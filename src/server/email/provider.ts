/*
  The email transport contract (epic #181).

  One interface, one implementation — Gmail, in ./gmail.ts. The interface is
  still worth having: adding Gmail alongside Resend cost one file and one line
  of selection, and REMOVING Resend cost about as little, because nothing
  outside this contract ever knew which transport was in use. The renderer, the
  drain, the outbox and the schema have never referenced one.

  WHY GMAIL AND ONLY GMAIL. Resend — and every transactional provider — refuses
  to deliver to arbitrary recipients until you own and verify a domain. This
  project has no domain, so that path was not "the better option for later", it
  was dead configuration that could silently become the active transport if a
  stray RESEND_API_KEY were ever set. One transport means one way to configure
  this and one way for it to be wrong.

  The Resend implementation lived here through commit cfd24ae and is one
  `git revert` away if a domain ever appears; adding it back is the same
  one-file change adding it was the first time.

  Runtime-agnostic and import-free, so it runs unchanged on Workers and can be
  unit-tested under `node --test` with a stub `fetch`.

  The transport needs a TRUE SECRET — an OAuth refresh token. There is no
  platform-authenticated binding for email the way `env.AI` is for Workers AI,
  so it lives in the drain function's secret store and nowhere else: never in
  the bundle, never in the database, never reachable from a browser. That is
  also why the drain is a scheduled, non-user-invoked endpoint — no member
  request ever runs code holding it.
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

/** Whether a transport's credentials actually work, without sending anything. */
export interface VerifyResult {
  ok: boolean
  /** Why not, with anything address-shaped already stripped by the caller. */
  error?: string
}

export interface EmailProvider {
  send(email: OutgoingEmail): Promise<SendResult>
  /**
   * Check the credentials without sending a message.
   *
   * This exists because of the order people do things in: you set the secrets,
   * turn the channel on, and then wait for someone to be @-mentioned before
   * finding out whether any of it was right. A wrong refresh token or an
   * unverified domain is then discovered by a stuck queue, not by a check you
   * could run the moment you finished pasting values in.
   *
   * Optional, so a transport with no cheap read-only probe simply omits it and
   * the preflight reports that it could not be checked — which is honest, and
   * better than inventing a probe that sends a real email to somebody.
   */
  verify?(): Promise<VerifyResult>
}


/**
 * The URL to advertise in `List-Unsubscribe`, pulled back out of the rendered
 * message so the header and the footer link can never disagree.
 *
 * Lives here rather than in the transport because it is a property of the
 * message, not of how it is delivered — any future transport needs the same
 * value.
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
