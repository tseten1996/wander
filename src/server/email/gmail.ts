/*
  Gmail as the email transport (epic #181).

  A second implementation of `EmailProvider`, which is the whole reason that
  interface exists — swapping transports is one new file and one line of
  selection, with nothing else in the channel touched.

  WHY GMAIL IS THE BETTER DEFAULT HERE. Resend (and every other transactional
  provider) will not deliver to arbitrary recipients until you own and verify a
  domain. For a free-tier side project with no domain, that is a hard stop:
  the queue fills and every send 403s. Gmail needs no domain — it sends as an
  account that already exists — so the channel can actually work today. The
  trade is deliverability and identity: mail arrives from a person's address,
  not from "Wander", and replies land in their inbox.

  LIMITS WORTH KNOWING. A free Gmail account allows roughly 500 recipients a
  day, a Workspace account 2,000. Both are far above what this app's
  per-recipient cap (12/24h) and six-hourly digest can generate, so the binding
  constraint stays ours, not Google's.

  Runtime-agnostic and dependency-free, like its siblings: `fetch`, `btoa` and
  `TextEncoder` are all present in Workers, Deno and Node, so this runs
  unchanged on any of them and is unit-testable with a stub `fetch`.

  THE CREDENTIAL IS A REFRESH TOKEN, which is a true secret and lives only in
  the drain function's secret store — the same place the Resend key would. It
  is exchanged for a short-lived access token at send time; no access token is
  ever stored.
*/
import type { EmailProvider, OutgoingEmail, SendResult } from './provider'

/** OAuth2 installed-app credentials plus the long-lived refresh token. */
export interface GmailCredentials {
  clientId: string
  clientSecret: string
  /** Long-lived token obtained once, out of band, via the OAuth consent flow. */
  refreshToken: string
  /**
   * The From header.
   *
   * Gmail will NOT let you send as an arbitrary address: it must be the
   * authenticated account, or an alias that account has configured under
   * "Send mail as". A mismatch is rejected at send time, which is why this is
   * passed in rather than guessed.
   */
  from: string
  replyTo?: string
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const TIMEOUT_MS = 10_000

/** Seconds of headroom before expiry at which a cached token is refreshed. */
const TOKEN_SKEW_SECONDS = 60

/* ── encoding ─────────────────────────────────────────────────────────────── */

/**
 * Base64 of arbitrary bytes.
 *
 * `btoa` takes a latin1 string, not text and not bytes, so UTF-8 has to be
 * encoded to bytes first and then widened one byte per char. Passing a string
 * with any character above U+00FF straight to `btoa` throws, which is exactly
 * what our own subject lines would do — they contain `·` and a curly
 * apostrophe.
 */
export function base64Bytes(bytes: Uint8Array): string {
  let latin1 = ''
  for (let i = 0; i < bytes.length; i++) latin1 += String.fromCharCode(bytes[i])
  return btoa(latin1)
}

/** Base64 of UTF-8 text. */
export function base64Utf8(text: string): string {
  return base64Bytes(new TextEncoder().encode(text))
}

/**
 * Base64url, as the Gmail API wants the raw message: URL-safe alphabet and no
 * padding.
 */
export function base64Url(text: string): string {
  return base64Utf8(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Encode a header value that may contain non-ASCII, per RFC 2047.
 *
 * NOT optional for us. Every subject this app generates contains `·`, and most
 * contain a typographic apostrophe; a raw 8-bit header is invalid and mail
 * clients render it as mojibake or drop it. ASCII-only values are returned
 * untouched so the common case stays readable in the wire format.
 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value
  return `=?UTF-8?B?${base64Utf8(value)}?=`
}

/** Wrap base64 at 76 characters, as RFC 2045 requires for a body part. */
export function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/**
 * Build the RFC 5322 message.
 *
 * `multipart/alternative` with the plain-text part first and the HTML second —
 * the order is load-bearing: a client picks the LAST part it can render, so
 * reversing them shows plain text to everyone.
 *
 * Both parts use `Content-Transfer-Encoding: base64`, which sidesteps the two
 * ways a hand-built message usually breaks: a line longer than 998 octets, and
 * raw UTF-8 in a 7-bit transport.
 */
export function buildMimeMessage(
  email: OutgoingEmail,
  sender: { from: string; replyTo?: string },
  boundarySeed = 'wander',
): string {
  // The boundary must not occur in either part. Base64 bodies can only contain
  // the base64 alphabet, so a boundary carrying `=_` cannot collide.
  const boundary = `=_${boundarySeed}_${Math.random().toString(36).slice(2, 12)}`
  const headers = [
    `From: ${sender.from}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    ...(sender.replyTo ? [`Reply-To: ${sender.replyTo}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(email.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(email.html)),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/* ── the provider ─────────────────────────────────────────────────────────── */

/**
 * Which Gmail/OAuth failures are worth a second attempt.
 *
 * 429 and 5xx are timing. 403 is the interesting one: Gmail returns it both for
 * `rateLimitExceeded` (pure timing) and for a genuine permission problem, and
 * the two are indistinguishable without parsing the body — so it is treated as
 * retryable, because the cost of retrying a permission error four times is far
 * smaller than the cost of silently discarding real notifications during a rate
 * limit. 401 likewise: an access token can expire mid-batch, and the next pass
 * mints a fresh one. Everything else 4xx — a malformed address, a From the
 * account may not use — will fail identically forever and must stop.
 */
export function isRetryableGmailStatus(status: number): boolean {
  if (status === 429 || status === 401 || status === 403) return true
  return status >= 500
}

/**
 * Gmail over the REST API, authenticated by refreshing an OAuth2 token.
 *
 * The access token is cached inside the closure for the life of the provider,
 * so one drain pass sending twenty emails performs one token exchange rather
 * than twenty. Nothing is persisted: a new pass constructs a new provider and
 * starts again, which is the correct trade for a credential this sensitive.
 */
export function gmailProvider(credentials: GmailCredentials): EmailProvider {
  const { clientId, clientSecret, refreshToken, from, replyTo } = credentials

  let cachedToken: string | null = null
  let expiresAtMs = 0

  /** A valid access token, refreshing only when the cached one is near expiry. */
  async function accessToken(): Promise<{ token: string } | { error: SendResult }> {
    if (cachedToken && Date.now() < expiresAtMs) return { token: cachedToken }

    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      if (!res.ok) {
        let detail = ''
        try {
          detail = (await res.text()).slice(0, 200)
        } catch {
          detail = ''
        }
        return {
          error: {
            ok: false,
            error: `gmail token ${res.status}${detail ? `: ${detail}` : ''}`,
            // `invalid_grant` means the refresh token was revoked or expired —
            // a human has to re-consent. Retryable so that re-consenting
            // drains the backlog instead of having lost every message queued
            // in the meantime.
            retryable: true,
          },
        }
      }

      const body = (await res.json()) as { access_token?: string; expires_in?: number }
      if (!body.access_token) {
        return { error: { ok: false, error: 'gmail token: no access_token', retryable: true } }
      }
      cachedToken = body.access_token
      expiresAtMs = Date.now() + Math.max(0, (body.expires_in ?? 3600) - TOKEN_SKEW_SECONDS) * 1000
      return { token: cachedToken }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: { ok: false, error: `gmail token failed: ${message}`, retryable: true } }
    }
  }

  return {
    async send(email: OutgoingEmail): Promise<SendResult> {
      const auth = await accessToken()
      if ('error' in auth) return auth.error

      try {
        const raw = base64Url(buildMimeMessage(email, { from, replyTo }))
        const res = await fetch(SEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${auth.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ raw }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })

        if (res.ok) {
          let id: string | undefined
          try {
            id = ((await res.json()) as { id?: string })?.id
          } catch {
            id = undefined
          }
          return { ok: true, id, retryable: false }
        }

        // A 401 mid-batch means the cached token went stale; drop it so the
        // next message refreshes rather than reusing a token we know is dead.
        if (res.status === 401) {
          cachedToken = null
          expiresAtMs = 0
        }

        let detail = ''
        try {
          detail = (await res.text()).slice(0, 300)
        } catch {
          detail = ''
        }
        return {
          ok: false,
          error: `gmail ${res.status}${detail ? `: ${detail}` : ''}`,
          retryable: isRetryableGmailStatus(res.status),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `gmail send failed: ${message}`, retryable: true }
      }
    },
  }
}
