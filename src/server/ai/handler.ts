/*
  The AI endpoint's actual logic (#211), independent of any runtime.

  Order of operations is the security design, and it is deliberate:

      kill switch → parse → membership → quota → dispatch → record

  Each gate fails closed, and every outcome — including the refusals — writes a
  usage row. A quota that only counts successes lets a caller retry a failing
  request forever at full cost; an abuse pattern that never succeeds would leave
  no trace at all.

  Two database clients, and the split between them IS the security model:

    * `asCaller` carries the caller's own JWT, so every read runs under exactly
      the RLS policies the browser gets. A non-member reads nothing. This is
      also why there is no JWT-signature verification here — the RLS read *is*
      the verification. A forged or expired token is rejected by PostgREST and
      returns zero rows, and the membership check below is itself an RLS read,
      so identity is established by Postgres as a side effect of a query we
      needed anyway.

    * `asService` bypasses RLS and touches `ai_usage` ONLY. If it is ever used
      to read or write a content table, that is an authorization bug: the whole
      claim that Postgres remains the enforcement boundary rests on this client
      having exactly one job.
*/
import { AiRequest, QUOTA_PER_TRIP, QUOTA_WINDOW_HOURS } from './schemas'
import type { AiResponse, Intent, RefusalReason } from './schemas'

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
    insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>
  }
}

export interface HandlerDeps {
  /** Reads run under the caller's RLS. */
  asCaller: Db
  /** Writes the usage ledger. Must never touch a content table. */
  asService: Db
  /** Kill switch: false or absent disables the endpoint. */
  enabled: boolean
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
 * Record the call. Never throws: a ledger write failing must not turn a served
 * request into a 500, and must not mask the original outcome. A dropped row
 * costs a little accuracy in the quota; an exception here would cost the
 * response.
 */
async function record(
  deps: HandlerDeps,
  row: {
    trip_id: string
    member_id: string | null
    feature: string
    outcome: 'ok' | 'refused' | 'failed'
  },
): Promise<void> {
  try {
    await deps.asService.from('ai_usage').insert(row)
  } catch {
    // Intentionally swallowed — see above.
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
  // 1. Kill switch, before anything else can cost money or touch the database.
  //    Absent config means disabled: an endpoint that turns itself on when its
  //    configuration fails to load is the wrong way round.
  if (!deps.enabled) {
    return refuse(
      'disabled',
      'Wander AI is switched off right now. Nothing was sent anywhere.',
      503,
    )
  }

  // 2. Shape. A caller-supplied prompt field would be rejected here simply by
  //    not existing in the schema (see schemas.ts).
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
  let memberId: string | null = null
  try {
    const { data, error } = await deps.asCaller
      .from('members')
      .select('id')
      .eq('trip_id', tripId)
      .maybeSingle()
    if (error || !data) {
      return refuse('forbidden', 'You do not have access to this trip.', 403)
    }
    memberId = (data as { id: string }).id
  } catch {
    // A failed authorization read is not permission to continue.
    return refuse('forbidden', 'Could not confirm your access to this trip.', 403)
  }

  // 4. Quota, per trip (never per user — see schemas.ts and the migration).
  const now = (deps.now ?? (() => new Date()))()
  const since = new Date(now.getTime() - QUOTA_WINDOW_HOURS * 3600_000).toISOString()
  let used: number
  try {
    const { count, error } = await deps.asService
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
    await record(deps, { trip_id: tripId, member_id: memberId, feature: intent, outcome: 'refused' })
    return refuse(
      'quota',
      `This trip has used its ${QUOTA_PER_TRIP} AI requests for today. It resets within ${QUOTA_WINDOW_HOURS} hours.`,
      429,
    )
  }

  // 5. Dispatch. No model is called in this slice (#211) — the point is to
  //    prove auth, quota and the ledger in isolation, before anything spends.
  //    #212 replaces this with the provider call.
  await record(deps, { trip_id: tripId, member_id: memberId, feature: intent, outcome: 'ok' })

  return {
    status: 200,
    body: {
      ok: true,
      intent,
      // The issue number stays out of the string below: the token lint scans
      // quoted spans for hex colours, and a #-prefixed issue number matches.
      // Tracking issue for the model call: #212.
      result: { stub: true, note: 'No model is wired up yet.' },
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  }
}
