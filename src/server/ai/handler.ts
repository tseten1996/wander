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
  ParsedBookingResult,
  QUOTA_PER_TRIP,
  QUOTA_WINDOW_HOURS,
} from './schemas'
import type { AiResponse, Intent, RefusalReason } from './schemas'
import { bookingParsePrompt } from './prompts'
import { MODELS } from './provider'
import type { ModelProvider } from './provider'

/** The slice of a Supabase client this module needs — so tests can pass a fake. */
export interface Db {
  from(table: string): {
    select: (
      columns: string,
      opts?: { count?: 'exact'; head?: boolean },
    ) => {
      eq: (column: string, value: unknown) => {
        gte: (column: string, value: string) => Promise<{ count: number | null; error: unknown }>
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>
      }
    }
  }
  rpc(fn: string, args: Record<string, unknown>): Promise<{ error: unknown }>
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
  try {
    const { data, error } = await deps.db
      .from('members')
      .select('id')
      .eq('trip_id', tripId)
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

  // improve_day still has no model behind it — that is #213. Kept as an
  // explicit stub rather than removed from the enum so the endpoint's shape
  // does not change when it lands.
  await record(deps, { tripId, feature: intent, outcome: 'ok' })

  return {
    status: 200,
    body: {
      ok: true,
      intent,
      result: { stub: true, note: 'No model is wired up yet.' },
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  }
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

  // No binding configured is a runtime with AI switched off, not an error.
  // Not recorded, for the same reason the kill switch is not: nothing happened.
  if (!deps.provider) {
    return refuse('disabled', 'Wander AI is switched off right now. Nothing was sent anywhere.', 503)
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
