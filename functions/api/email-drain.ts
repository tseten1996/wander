/*
  The email sender (epic #181) — the scheduled, never-member-invoked half.

  This is the one endpoint in Wander that holds a SERVICE ROLE KEY, and it is
  worth being explicit about why that is acceptable here when it is forbidden
  everywhere else (guardrail #1: RLS is the security boundary, the client is
  never trusted).

  Every other function in functions/ forwards the browser's JWT and therefore
  cannot exceed the caller's own permissions. This one cannot work that way:
  `claim_email_batch` returns email addresses, so it is granted to the service
  role alone, and no credential a member holds may ever reach it. The
  reconciliation is that THIS ENDPOINT HAS NO MEMBER CALLER. It is authenticated
  by a shared secret that only the scheduler knows, it accepts no input that
  selects rows, and it returns counts. There is no request a signed-in member
  can make that causes this code to run with their data in scope — which is a
  different trust model from "trusted client", not a weakening of it.

  Two independent gates, like /api/ai and /api/push:
    * EMAIL_ENABLED must be exactly 'true'
    * every secret must be present
  Missing either degrades to a clean no-op, so a half-configured deployment
  sends nothing rather than erroring.

  Secrets (production only, `wrangler pages secret put <NAME>`):
    EMAIL_DRAIN_SECRET   bearer token the scheduler presents
    SUPABASE_SERVICE_KEY service role key — the strongest credential we have
    RESEND_API_KEY       provider key
*/
import { createClient } from '@supabase/supabase-js'
import { PUBLIC_SUPABASE_URL } from '../../src/lib/supabase-public'
import { drainOnce, redactEmails } from '../../src/server/email/drain'
import type { EmailQueue } from '../../src/server/email/drain'
import { gmailProvider } from '../../src/server/email/gmail'
import type { EmailJob } from '../../src/server/email/render'

interface Env {
  SUPABASE_URL?: string
  /** Service role key. A TRUE SECRET — secret store only, never the bundle. */
  SUPABASE_SERVICE_KEY?: string
  /** Kill switch. Anything other than the exact string 'true' disables email. */
  EMAIL_ENABLED?: string
  /** Bearer token the scheduler must present. A TRUE SECRET. */
  EMAIL_DRAIN_SECRET?: string
  /** Gmail OAuth2 client id. Not secret on its own, but pointless alone. */
  GMAIL_CLIENT_ID?: string
  /** Gmail OAuth2 client secret. A TRUE SECRET. */
  GMAIL_CLIENT_SECRET?: string
  /** Gmail long-lived refresh token. A TRUE SECRET. */
  GMAIL_REFRESH_TOKEN?: string
  /** `Wander <trips@yourdomain.com>` — must be on a VERIFIED sending domain. */
  EMAIL_FROM?: string
  /** Where replies go. Optional. */
  EMAIL_REPLY_TO?: string
  /** Absolute origin the links point at, e.g. `https://you.github.io/wander`. */
  APP_ORIGIN?: string
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

/**
 * Constant-time-ish comparison of the presented bearer against the configured
 * secret.
 *
 * `===` on strings can short-circuit on the first differing byte, which in
 * principle leaks the shared secret's prefix to anyone who can measure
 * response times precisely enough. That attack is impractical across the
 * public internet against an edge function, but the fix is four lines and the
 * secret guards the service role key, so there is no reason to leave the
 * question open. Length is compared first and separately — lengths are not
 * secret.
 */
function secretMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/** The bearer token on the request, or '' when absent/malformed. */
function bearer(request: Request): string {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  // One transport, so one way to be configured and one way to be wrong. Every
  // value below is required; missing any of them degrades to a clean no-op
  // rather than a 500, so a half-configured deployment sends nothing instead
  // of erroring.
  const configured =
    env.EMAIL_ENABLED === 'true' &&
    !!env.EMAIL_DRAIN_SECRET &&
    !!env.SUPABASE_SERVICE_KEY &&
    !!env.EMAIL_FROM &&
    !!env.GMAIL_CLIENT_ID &&
    !!env.GMAIL_CLIENT_SECRET &&
    !!env.GMAIL_REFRESH_TOKEN
  if (!configured) return json({ ok: true, disabled: true }, 200)

  // Authenticate the scheduler before anything else touches a credential.
  // A wrong or absent token is a flat 401 carrying no detail about which part
  // was wrong.
  if (!secretMatches(bearer(request), env.EMAIL_DRAIN_SECRET as string)) {
    return json({ ok: false, message: 'Unauthorized.' }, 401)
  }

  const transport = 'gmail'
  const provider = gmailProvider({
    clientId: env.GMAIL_CLIENT_ID as string,
    clientSecret: env.GMAIL_CLIENT_SECRET as string,
    refreshToken: env.GMAIL_REFRESH_TOKEN as string,
    // Gmail will not send as an arbitrary address: EMAIL_FROM must be the
    // authenticated account or one of its "Send mail as" aliases.
    from: env.EMAIL_FROM as string,
    replyTo: env.EMAIL_REPLY_TO,
  })

  // A preflight, requested with {"check": true}: verify the configured
  // transport's credentials and return WITHOUT draining.
  //
  // This exists because of the order people do things in. You set the secrets,
  // turn the channel on, and then wait for someone to be @-mentioned before
  // finding out whether any of it was right — so a mistyped refresh token or
  // an unverified domain is discovered via a queue that silently never
  // empties. This turns that into a check you run the moment you finish
  // pasting values in.
  //
  // Answered before the Supabase client is built: a credential check should
  // not need the database, and "your mail credentials are fine" must not
  // depend on an unrelated service being up.
  let wantsCheck = false
  try {
    const body = (await request.clone().json()) as { check?: unknown }
    wantsCheck = body?.check === true
  } catch {
    // No body, or not JSON — the scheduler posts `{}`. Not a check.
  }

  if (wantsCheck) {
    if (!provider.verify) {
      return json({ ok: true, transport, credentials: 'unchecked' }, 200)
    }
    const result = await provider.verify()
    return json(
      {
        ok: result.ok,
        transport,
        credentials: result.ok ? 'valid' : 'invalid',
        // Scrubbed with the same helper the drain report uses: a provider can
        // echo an address back, and this response is meant to be safe to paste
        // into an issue or a public run log.
        ...(result.error ? { error: redactEmails(result.error) } : {}),
      },
      // 502 on a bad credential, so a `curl --fail` in a setup script or a
      // workflow step notices without having to parse the body.
      result.ok ? 200 : 502,
    )
  }

  // The service role client. RLS does not apply to it, which is exactly why it
  // exists here (the outbox denies every member credential) and exactly why
  // this endpoint must never grow a parameter that chooses rows.
  const db = createClient(
    env.SUPABASE_URL || PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_KEY as string,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const queue: EmailQueue = {
    async claim(limit) {
      const { data, error } = await db.rpc('claim_email_batch', { p_limit: limit })
      if (error || !Array.isArray(data)) return []
      return data as EmailJob[]
    },
    async enqueueDigests() {
      const { data, error } = await db.rpc('enqueue_chat_digests')
      if (error) return 0
      return typeof data === 'number' ? data : 0
    },
    async markResult(id, sent, error, terminal) {
      await db.rpc('mark_email_result', {
        p_id: id,
        p_sent: sent,
        p_error: error ?? null,
        p_terminal: !!terminal,
      })
    },
  }

  // APP_ORIGIN decides where every link in every email points, so a wrong
  // value is a batch of dead ends. Falling back to the canonical GitHub Pages
  // origin (docs/ARCHITECTURE.md §1) keeps a minimally-configured deployment
  // sending working links rather than broken ones.
  const appOrigin = env.APP_ORIGIN || 'https://tseten1996.github.io/wander'

  try {
    const report = await drainOnce(queue, provider, { appOrigin })
    // Counts and redacted errors only — never who was emailed — so this is
    // safe in a public run log. `transport` is named because when a send
    // fails the first question is always "which provider was that?", and the
    // answer should not require guessing from which secrets happen to be set.
    return json({ ok: true, transport, ...report }, 200)
  } catch (err) {
    // A thrown drain is a bug or an outage, not a caller error. Report it
    // plainly so the scheduled run goes red and someone looks.
    const message = err instanceof Error ? err.message : String(err)
    return json({ ok: false, message }, 500)
  }
}
