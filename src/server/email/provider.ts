/*
  Transport for the email channel (epic #181).

  One interface, one implementation, same shape and same reasoning as
  src/server/ai/provider.ts: the interface exists so the provider decision stays
  cheap to reverse — swapping Resend for Postmark, SES or plain SMTP means
  writing a second `send()` and nothing else — not because several providers are
  expected to coexist.

  Runtime-agnostic and import-free, so it runs unchanged on Workers and can be
  unit-tested under `node --test` with a stub `fetch`.

  UNLIKE the AI provider, this one needs a TRUE SECRET: an API key. There is no
  platform-authenticated binding for email the way `env.AI` is for Workers AI,
  so the key lives in the drain function's secret store and nowhere else — never
  in the bundle, never in the database, never reachable from a browser. That is
  also why the drain is a scheduled, non-user-invoked endpoint: no member
  request ever runs code that holds this key.
*/

/** One message to deliver. */
export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  text: string
}

/** What happened. `retryable` decides whether the outbox row stays pending. */
export interface SendResult {
  ok: boolean
  /** Provider-side id, when it gave one — useful when chasing a lost email. */
  id?: string
  error?: string
  /**
   * Whether trying again could plausibly work.
   *
   * This is the field that matters: a 422 for a malformed address will fail
   * identically forever, and retrying it four more times just burns quota and
   * delays everything behind it. A 429 or a 503, by contrast, is pure timing.
   * The drain feeds this straight into `mark_email_result`.
   */
  retryable: boolean
}

export interface EmailProvider {
  send(email: OutgoingEmail): Promise<SendResult>
}

/** The `from` header. A display name plus an address on a verified domain. */
export interface EmailSender {
  /** e.g. `Wander <trips@yourdomain.com>` — must be a VERIFIED sending domain. */
  from: string
  /** Where replies go, if anywhere sensible. Omitted when unset. */
  replyTo?: string
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 10_000

/**
 * Which HTTP statuses are worth a second attempt.
 *
 * 429 (rate limited) and 5xx (provider trouble) are timing. 401/403 mean the
 * key is wrong — retrying cannot fix that, but it is also not the *message's*
 * fault, so it is treated as retryable: a key rotated back into place should
 * let the queue drain rather than having silently failed every message in the
 * meantime. 4xx otherwise (422 for a bad address, 400 for a malformed payload)
 * is permanent and must stop consuming attempts.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true
  if (status === 401 || status === 403) return true
  return status >= 500
}

/**
 * Resend over its REST API.
 *
 * Deliberately `fetch`-only rather than the `resend` npm package: this module
 * has to run in a Workers isolate, the package would be a dependency on the
 * critical path of a function that exists to send a handful of emails, and the
 * request is six lines. `List-Unsubscribe` is set because a notification email
 * is exactly the kind of mail that must be one tap to stop — mailbox providers
 * increasingly require it, and a recipient who cannot find the off switch
 * reports the whole domain as spam instead.
 */
export function resendProvider(apiKey: string, sender: EmailSender): EmailProvider {
  return {
    async send({ to, subject, html, text }: OutgoingEmail): Promise<SendResult> {
      try {
        const res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: sender.from,
            to: [to],
            subject,
            html,
            text,
            ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
            headers: {
              // The trip's own notification settings are the off switch.
              'List-Unsubscribe': `<${unsubscribeTarget(html)}>`,
            },
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })

        if (res.ok) {
          // Resend answers `{ id }`. A body we cannot parse after a 2xx still
          // means the message was accepted, so this never fails the send.
          let id: string | undefined
          try {
            id = ((await res.json()) as { id?: string })?.id
          } catch {
            id = undefined
          }
          return { ok: true, id, retryable: false }
        }

        // Keep a short slice of the provider's own words: `last_error` is
        // capped at 500 chars in the database and is the only breadcrumb when
        // someone asks why an email never arrived.
        let detail = ''
        try {
          detail = (await res.text()).slice(0, 300)
        } catch {
          detail = ''
        }
        return {
          ok: false,
          error: `resend ${res.status}${detail ? `: ${detail}` : ''}`,
          retryable: isRetryableStatus(res.status),
        }
      } catch (err) {
        // A timeout, a DNS failure, an aborted fetch — all transient by nature.
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `send failed: ${message}`, retryable: true }
      }
    },
  }
}

/**
 * The URL to advertise in `List-Unsubscribe`, pulled back out of the rendered
 * message so the header and the footer link can never disagree.
 *
 * It points at the trip the email is about, which is where the member's own
 * email toggle lives — the only place that can turn this off, since the
 * preference is per member per trip and only that member may write it. Falls
 * back to an empty string if the pattern is ever not found, which simply omits
 * a useful header rather than breaking the send.
 */
export function unsubscribeTarget(html: string): string {
  const match = /href="(https?:\/\/[^"]+)"/.exec(html)
  return match ? match[1].replace(/&amp;/g, '&') : ''
}
