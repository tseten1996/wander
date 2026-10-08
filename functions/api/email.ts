/*
  Enqueue side of the email channel (epic #181) — the member-invoked half.

  A sibling of functions/api/push.ts and almost its twin: a thin Cloudflare
  Pages routing shell that forwards the browser's Supabase JWT, so it runs AS
  THE CALLER and has no more database reach than the person who invoked it.

  WHAT IT DOES NOT DO, AND WHY. /api/push reads the recipients' push endpoints
  and sends. This endpoint sends nothing. It calls one RPC that resolves
  addresses *inside the database*, writes them to an outbox no browser
  credential can read, and returns a count. The reason is in the migration's
  header: a push endpoint is inert without our VAPID key, while an email
  address is PII that is valuable on its own, so no code path a member can
  reach is ever handed one. The actual sending happens in email-drain.ts, which
  a member cannot invoke.

  It therefore holds NO SECRET at all — not even the Resend key. Which means
  the worst case for this endpoint, if someone hammers it with ids they did not
  author, is a sequence of zeroes.

  Best-effort by contract, like push: notify.ts has already written the inbox
  rows and moved on, so a failure here is invisible and must never surface.
*/
import { createClient } from '@supabase/supabase-js'
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '../../src/lib/supabase-public'

interface Env {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  /** Kill switch. Anything other than the exact string 'true' disables email. */
  EMAIL_ENABLED?: string
}

interface PagesContext {
  request: Request
  env: Env
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/** Matches the enqueue RPC's own input bound. */
const MAX_IDS = 100

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  // One switch here, not two: unlike push there is no key to check, because
  // this half holds no credential. An unconfigured deployment degrades to a
  // clean no-op rather than a 500, so the app is fully functional without
  // email ever being set up.
  if (env.EMAIL_ENABLED !== 'true') return json({ ok: true, queued: 0, disabled: true }, 200)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Expected a JSON body.' }, 400)
  }
  const rawIds = (body as { ids?: unknown })?.ids
  const ids = Array.isArray(rawIds) ? rawIds.filter(isUuid).slice(0, MAX_IDS) : []
  if (ids.length === 0) return json({ ok: true, queued: 0 }, 200)

  const db = createClient(
    env.SUPABASE_URL || PUBLIC_SUPABASE_URL,
    env.SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  )

  // RLS-gated by the caller's JWT; the definer RPC additionally proves the
  // caller authored each notification, that it is recent, that the recipient
  // opted in to email for this event type, that their address is verified, and
  // that they are under their daily cap. It returns a count — never an address.
  const { data, error } = await db.rpc('enqueue_emails_for_notifications', { p_ids: ids })
  if (error) return json({ ok: true, queued: 0 }, 200)

  return json({ ok: true, queued: typeof data === 'number' ? data : 0 }, 200)
}
