/*
  The AI endpoint's actual logic (#211), independent of any runtime.

  Order of operations is the security design, and it is deliberate:

      kill switch → parse → membership → quota → dispatch → record

  Each gate fails closed, and every outcome — including the refusals — writes a
  usage row. A quota that only counts successes lets a caller retry a failing
  request forever at full cost; an abuse pattern that never succeeds would leave
  no trace at all.

  ONE database client, carrying the caller's own JWT, so every read and write
  runs under exactly the RLS policies the browser gets. There is no service-role
  key here and there must never be one: it bypasses RLS on every table, and the
  only thing this needs privilege for is appending an audit row — which the
  `record_ai_usage` SECURITY DEFINER RPC does instead, validating membership
  inside Postgres (the join_trip pattern this repo already uses).

  That is also why there is no JWT-signature verification: the RLS read IS the
  verification. A forged or expired token is rejected by PostgREST and returns
  zero rows, and the membership check below is itself an RLS read — so identity
  is established by Postgres as a side effect of a query we needed anyway,
  rather than costing a second secret.
*/
import {
  AiRequest,
  DayPickResult,
  ParsedBookingResult,
  QUOTA_PER_TRIP,
  QUOTA_WINDOW_HOURS,
} from './schemas'
import type { AiResponse, Intent, ReasonSource, RefusalReason } from './schemas'
import { bookingParsePrompt, improveDayPrompt } from './prompts'
import type { PromptPreferences } from './prompts'
import { MODELS } from './provider'
import type { ModelProvider } from './provider'
import { planDay } from './day'
import type { Candidate, DayItem, DayPlans } from './day'

/** The slice of a Supabase client this module needs — so tests can pass a fake. */
export interface Db {
  from(table: string): {
    select: (
      columns: string,
      opts?: { count?: 'exact'; head?: boolean },
    ) => {
      eq: (column: string, value: unknown) => {
        gte: (column: string, value: string) => Promise<{ count: number | null; error: unknown }>
        limit: (n: number) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> }
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>
      }
    }
  }
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data?: unknown; error: unknown }>
}

export interface HandlerDeps {
  /** Runs as the caller. RLS is the authorization boundary. */
  db: Db
  /** Kill switch: false or absent disables the endpoint. */
  enabled: boolean
  /**
   * Model access. Optional on purpose: a runtime with no binding configured is
   * a runtime where AI is off, and that must read as "disabled" rather than as
   * a crash on the first request.
   */
  provider?: ModelProvider
  /** Injected so tests are not clock-dependent. */
  now?: () => Date
}

export interface HandlerResult {
  status: number
  body: AiResponse
}

const refuse = (
  reason: RefusalReason,
  message: string,
  status: number,
): HandlerResult => ({ status, body: { ok: false, reason, message } })

/**
 * Append to the usage ledger. Never throws: a bookkeeping failure must not turn
 * a served request into a 500, nor mask the outcome the caller actually needs.
 * A dropped row costs a little quota accuracy; an exception here would cost the
 * user their answer.
 */
async function record(
  deps: HandlerDeps,
  args: {
    tripId: string
    feature: string
    outcome: 'ok' | 'refused' | 'failed'
    model?: string
    inputTokens?: number
    outputTokens?: number
  },
): Promise<void> {
  try {
    await deps.db.rpc('record_ai_usage', {
      p_trip_id: args.tripId,
      p_feature: args.feature,
      p_outcome: args.outcome,
      p_model: args.model ?? '',
      p_input_tokens: args.inputTokens ?? 0,
      p_output_tokens: args.outputTokens ?? 0,
      // Left at zero deliberately. Workers AI bills in neurons, which the
      // binding does not report, so any dollar figure derived here would be a
      // guess dressed as a measurement. Tokens are what we actually observe.
      p_estimated_cost_usd: 0,
    })
  } catch {
    // Intentionally swallowed — see above.
  }
}

/**
 * The trip's own date range, read as the caller.
 *
 * Only used to anchor year-less dates ("Jul 24") in the prompt, so a failure is
 * a degraded answer rather than a refusal: nulls simply tell the model not to
 * guess a year. Never throws.
 */
async function tripRange(
  deps: HandlerDeps,
  tripId: string,
): Promise<{ start: string | null; end: string | null }> {
  try {
    const { data, error } = await deps.db
      .from('trips')
      .select('start_date, end_date')
      .eq('id', tripId)
      .maybeSingle()
    if (error || !data) return { start: null, end: null }
    const row = data as { start_date?: string | null; end_date?: string | null }
    return { start: row.start_date ?? null, end: row.end_date ?? null }
  } catch {
    return { start: null, end: null }
  }
}

/**
 * Handle one request. `rawBody` is whatever the platform parsed out of the
 * request; everything about its shape is distrusted until zod says otherwise.
 */
export async function handleAiRequest(
  rawBody: unknown,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  // 1. Kill switch, before anything can cost money or touch the database.
  //    Absent config means disabled: an endpoint that switches itself on when
  //    its configuration fails to load is the wrong way round.
  if (!deps.enabled) {
    return refuse(
      'disabled',
      'Wander AI is switched off right now. Nothing was sent anywhere.',
      503,
    )
  }

  // 2. Shape. A caller-supplied prompt field is rejected here simply by not
  //    existing in the schema (see schemas.ts).
  const parsed = AiRequest.safeParse(rawBody)
  if (!parsed.success) {
    return refuse('forbidden', 'That request was not something Wander AI can do.', 400)
  }
  const request = parsed.data
  const intent: Intent = request.intent
  const tripId = request.tripId

  // 3. Membership, read as the caller. A non-member — or a forged token — gets
  //    no row back, which is both the authorization check and the proof the
  //    token is real. Deliberately a distinct 403 rather than an empty success,
  //    so a genuine bug does not look like an empty trip.
  //
  //    `.limit(1)` is load-bearing, not a micro-optimisation. The members_select
  //    policy lets a member see EVERY member of their trip, so this filter
  //    matches one row on a solo trip and several as soon as anyone joins — and
  //    `.maybeSingle()` treats "more than one row" as an error. Without the
  //    limit this refused every multi-member trip with "You do not have access",
  //    which is both wrong and the most alarming way to be wrong.
  //
  //    Any visible row is sufficient proof: RLS only exposes member rows for
  //    trips the caller belongs to, so seeing one at all IS the membership.
  try {
    const { data, error } = await deps.db
      .from('members')
      .select('id')
      .eq('trip_id', tripId)
      .limit(1)
      .maybeSingle()
    if (error || !data) {
      return refuse('forbidden', 'You do not have access to this trip.', 403)
    }
  } catch {
    // A failed authorization read is not permission to continue.
    return refuse('forbidden', 'Could not confirm your access to this trip.', 403)
  }

  // 4. Quota, per trip (never per user — see schemas.ts and the migration).
  //    Read as the caller: the ai_usage select policy already scopes rows to
  //    trip members, so the number enforced here is the same number the app can
  //    show them. They cannot hide rows — there is no delete policy.
  const now = (deps.now ?? (() => new Date()))()
  const since = new Date(now.getTime() - QUOTA_WINDOW_HOURS * 3600_000).toISOString()
  let used: number
  try {
    const { count, error } = await deps.db
      .from('ai_usage')
      .select('id', { count: 'exact', head: true })
      .eq('trip_id', tripId)
      .gte('created_at', since)
    // A quota we cannot read is a quota we cannot enforce, so refuse. Failing
    // open here would delete the only bound on what a leaked invite link costs.
    if (error || count == null) {
      return refuse('quota', 'Wander AI is unavailable right now. Please try again later.', 503)
    }
    used = count
  } catch {
    return refuse('quota', 'Wander AI is unavailable right now. Please try again later.', 503)
  }

  if (used >= QUOTA_PER_TRIP) {
    await record(deps, { tripId, feature: intent, outcome: 'refused' })
    return refuse(
      'quota',
      `This trip has used its ${QUOTA_PER_TRIP} AI requests for today. It resets within ${QUOTA_WINDOW_HOURS} hours.`,
      429,
    )
  }

  // 5. Dispatch.
  if (request.intent === 'parse_booking') {
    return parseBooking(deps, request.tripId, request.text)
  }

  return improveDay(deps, request.tripId, request.day)
}

/**
 * parse_booking (#212): read a confirmation the regex parser could not.
 *
 * The contract with the caller is that this is *never worse than not calling
 * it*. `src/features/itinerary/parse.ts` already degrades a failed parse to a
 * create form with the raw text in its notes, and every failure path here —
 * no binding, a thrown call, output that does not validate — returns nothing
 * usable so the caller falls back to exactly that. Nothing is retried: a second
 * attempt at the same text with the same prompt costs a second call to be wrong
 * again, and the user is one tap from doing it themselves.
 */
async function parseBooking(
  deps: HandlerDeps,
  tripId: string,
  text: string,
): Promise<HandlerResult> {
  const feature = 'parse_booking'

  // No binding configured. Still not an error, and still not recorded — but
  // deliberately NOT the same sentence as the kill switch above.
  //
  // These are two different problems with two different fixes: one is a flag
  // someone chose to set, the other is a binding nobody attached. Saying
  // "switched off" for both sent a real debugging session looking at the flag
  // while the binding was the thing missing, which is the same failure the
  // client-side transport messages had.
  if (!deps.provider) {
    return refuse(
      'disabled',
      'Wander AI is switched on, but no model is connected to it yet.',
      503,
    )
  }

  const range = await tripRange(deps, tripId)
  const args = bookingParsePrompt({ text, tripStart: range.start, tripEnd: range.end })
  const model = MODELS[args.tier]

  let completion
  try {
    completion = await deps.provider.complete(args)
  } catch {
    // The call itself failed, so there are no token counts to record — but the
    // attempt still gets a row, or an outage looks like nobody tried.
    await record(deps, { tripId, feature, outcome: 'failed', model })
    return refuse(
      'unavailable',
      'Wander AI could not read that just now. Your text is still here.',
      503,
    )
  }

  const usage = {
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  }
  const usageRow = { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }

  // Model output is untrusted input. JSON mode constrains the shape at the
  // provider; this decides whether what came back is usable.
  const parsed = ParsedBookingResult.safeParse(completion.json)
  if (!parsed.success) {
    await record(deps, { tripId, feature, outcome: 'failed', ...usageRow })
    // Deliberately a 200 with an empty result rather than an error: the call
    // completed and cost tokens, it simply found nothing. The caller shows
    // today's raw-text create form either way, and reporting this as a failure
    // would push a normal outcome into an error toast.
    return {
      status: 200,
      body: { ok: true, intent: 'parse_booking', result: { booking: null }, usage },
    }
  }

  await record(deps, { tripId, feature, outcome: 'ok', ...usageRow })
  return {
    status: 200,
    body: { ok: true, intent: 'parse_booking', result: { booking: parsed.data }, usage },
  }
}

/* ── improve_day (#213) ──────────────────────────────────────────────────── */

/** A deterministic explanation, used when no model is called or its pick fails. */
function computedReason(plan: Candidate, plans: DayPlans): string {
  const parts: string[] = []
  const saved = plans.baseline.travelKm - plan.travelKm
  if (saved >= 0.1) parts.push(`saves about ${saved.toFixed(1)} km of travel`)
  if (plans.baseline.conflicts > 0) {
    parts.push(
      `clears ${plans.baseline.conflicts} overlapping ${plans.baseline.conflicts === 1 ? 'item' : 'items'}`,
    )
  }
  if (!parts.length) parts.push('groups nearby stops together')
  const moved = `${plan.moved} ${plan.moved === 1 ? 'item moves' : 'items move'}`
  return `This order ${parts.join(' and ')}. ${moved}, finishing at ${plan.endsAt}.`
}

const nothingToDo = (message: string, plans: DayPlans): HandlerResult => ({
  status: 200,
  body: {
    ok: true,
    intent: 'improve_day',
    result: {
      status: 'nothing',
      message,
      baseline: plans.baseline,
      notes: plans.notes,
      excluded: plans.excluded,
    },
    usage: { inputTokens: 0, outputTokens: 0 },
  },
})

/**
 * improve_day (#213): choose between plans this server generated.
 *
 * The expensive work happens before any model is considered. `get_ai_day_context`
 * reads the day as the caller, `planDay` enumerates and scores every valid
 * ordering, and only then — if there is genuinely more than one good answer —
 * is a model asked which one and why.
 *
 * That gate is the cost control and it is not a policy someone has to
 * remember. A day with nothing to fix, a day with one obvious fix, a day too
 * short to reorder: each returns without a call. The model earns its tokens
 * only when the output is a judgement, which is §7's rule made mechanical.
 *
 * AUTHORIZATION is a property of where the plan came from, not of a later
 * check. Every action names an item that `get_ai_day_context` returned, and
 * that function is SECURITY INVOKER — so the caller's own RLS policies decided
 * what it could see. `itinerary_update` requires only trip membership, which
 * this request already proved. There is therefore no action in a plan that the
 * caller could not have performed by hand, which is exactly the bar a
 * suggestion has to clear.
 */
async function improveDay(
  deps: HandlerDeps,
  tripId: string,
  day: string,
): Promise<HandlerResult> {
  const feature = 'improve_day'

  let context: {
    items?: DayItem[]
    leg?: { name?: string | null } | null
    preferences?: PromptPreferences | null
  } | null
  try {
    const { data, error } = await deps.db.rpc('get_ai_day_context', {
      p_trip_id: tripId,
      p_day: day,
    })
    if (error || !data) {
      return refuse('unavailable', 'Could not read that day just now. Please try again.', 503)
    }
    context = data as typeof context
  } catch {
    return refuse('unavailable', 'Could not read that day just now. Please try again.', 503)
  }

  const items = Array.isArray(context?.items) ? context.items : []
  const plans = planDay(items, day)

  // No candidates is the common, free answer: the day is already sensible, or
  // there is nothing in it to reorder. Deliberately not a refusal — "there is
  // nothing to improve here" is a useful result, and no row is written because
  // no call was made.
  // Every path from here writes a usage row, including the ones that call no
  // model. The row costs a little quota for a free answer, which is the point:
  // reading a day is still an authenticated round trip to Postgres, and the
  // per-trip quota is the only bound on what a leaked invite link can drive.
  // A ledger that only counted model calls would leave that traffic invisible.
  const free = { model: '', inputTokens: 0, outputTokens: 0 }

  if (plans.candidates.length === 0) {
    await record(deps, { tripId, feature, outcome: 'ok', ...free })
    return nothingToDo(
      plans.baseline.total < 2
        ? 'There is not enough in this day to rearrange yet.'
        : 'This day already looks well ordered — nothing worth moving.',
      plans,
    )
  }

  const top = plans.candidates[0]

  // Exactly one viable plan is not a judgement, it is an answer — and a model
  // is only worth paying for judgement (§7). No plans is free; one plan is
  // free; the call happens when there is genuinely something to choose.
  //
  // The same fallback covers a runtime with no binding: the plans are ours and
  // cost nothing, so AI being off degrades the explanation, not the feature.
  if (plans.candidates.length === 1 || !deps.provider) {
    await record(deps, { tripId, feature, outcome: 'ok', ...free })
    return suggestion(plans, top, computedReason(top, plans), 'computed', {
      inputTokens: 0,
      outputTokens: 0,
    })
  }

  const args = improveDayPrompt({
    day,
    placeName: context?.leg?.name ?? null,
    baseline: plans.baseline,
    candidates: plans.candidates.map((c) => ({
      id: c.id,
      order: c.order,
      travelKm: c.travelKm,
      moved: c.moved,
      endsAt: c.endsAt,
    })),
    notes: plans.notes,
    // Stated preferences (#268), read as the caller by get_ai_day_context.
    // Only ever reaches the model on the judgement call — the deterministic
    // "nothing to do" and single-plan paths above never build a prompt.
    preferences: context?.preferences ?? null,
  })
  const model = MODELS[args.tier]

  let completion
  try {
    completion = await deps.provider.complete(args)
  } catch {
    await record(deps, { tripId, feature, outcome: 'failed', model })
    // Still a useful answer: the plans were never the model's to produce.
    return suggestion(plans, top, computedReason(top, plans), 'computed', {
      inputTokens: 0,
      outputTokens: 0,
    })
  }

  const usage = { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens }
  const usageRow = { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }

  const picked = DayPickResult.safeParse(completion.json)
  // An id outside the set we offered is as invalid as unparseable output — this
  // is the line that makes "the model cannot author a plan" true rather than
  // merely intended.
  const chosen = picked.success
    ? plans.candidates.find((c) => c.id === picked.data.planId)
    : undefined

  if (!picked.success || !chosen) {
    await record(deps, { tripId, feature, outcome: 'failed', ...usageRow })
    return suggestion(plans, top, computedReason(top, plans), 'computed', usage)
  }

  await record(deps, { tripId, feature, outcome: 'ok', ...usageRow })
  return suggestion(plans, chosen, picked.data.reason, 'model', usage)
}

/** Shape one chosen plan for the preview card. */
function suggestion(
  plans: DayPlans,
  plan: Candidate,
  reason: string,
  reasonSource: ReasonSource,
  usage: { inputTokens: number; outputTokens: number },
): HandlerResult {
  return {
    status: 200,
    body: {
      ok: true,
      intent: 'improve_day',
      result: {
        status: 'suggested',
        reason,
        reasonSource,
        plan: {
          id: plan.id,
          actions: plan.actions,
          sequence: plan.sequence,
          order: plan.order,
          travelKm: plan.travelKm,
          moved: plan.moved,
          endsAt: plan.endsAt,
        },
        // The alternatives travel with the suggestion so the card can say "2
        // other orders were considered" — a suggestion that hides its rivals
        // reads as an oracle rather than a choice.
        alternatives: plans.candidates.filter((c) => c.id !== plan.id).length,
        baseline: plans.baseline,
        notes: plans.notes,
        excluded: plans.excluded,
      },
      usage,
    },
  }
}
