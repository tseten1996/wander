/*
  Draining the email outbox (epic #181).

  The orchestration half of the email channel: take a claimed batch, render
  each message, hand it to the provider, and record the outcome. Runtime-
  agnostic and injection-based — it receives a queue and a provider rather than
  constructing either — so the whole policy below is unit-testable with stubs
  and holds no knowledge of Supabase, Cloudflare or Resend.

  WHY THIS RUNS UNATTENDED AND NOT IN A MEMBER'S REQUEST.
  `claim_email_batch` returns email addresses, so it is granted to the service
  role only (see the migration's header). The credential that can call it must
  therefore never be present in code a member can invoke. This module is what
  the scheduled endpoint runs, and nothing else calls it.

  THE ORDERING RULE. Claim increments `attempts` and pushes `send_after`
  forward *before* anything is sent, so the failure we cannot observe — the
  process dying mid-send — degrades to "retried once more, later", never to
  "retried forever" and never to "sent twice in a tight loop". Everything here
  is written so that a crash at any line leaves the queue in a state the next
  run handles correctly.
*/
import type { EmailJob } from './render'
import { renderEmail } from './render'
import type { EmailProvider } from './provider'

/** The database operations the drain needs. Implemented over Supabase in the
 *  Pages Function; stubbed in tests. */
export interface EmailQueue {
  /** Atomically claim up to `limit` due rows (service role only). */
  claim(limit: number): Promise<EmailJob[]>
  /**
   * Queue any chat digests that have come due, returning how many.
   *
   * Part of the queue rather than a separate step the caller must remember,
   * because a drain that claims without first enqueueing would silently never
   * send a digest — and nothing would fail. Optional so a caller that has not
   * migrated yet still works.
   */
  enqueueDigests?(): Promise<number>
  /**
   * Record the outcome of one send.
   *
   * `terminal` marks a failure as permanent, so the row is retired instead of
   * waiting out four more retry windows. Only the caller knows this: a 422 for
   * a malformed address will be rejected identically forever, while a 429 is
   * pure timing.
   */
  markResult(id: string, sent: boolean, error?: string, terminal?: boolean): Promise<void>
}

export interface DrainOptions {
  /** Absolute origin the links point at, e.g. `https://you.github.io/wander`. */
  appOrigin: string
  /** Upper bound on messages per run. */
  limit?: number
  /**
   * Ceiling on concurrent sends.
   *
   * Low on purpose. Every provider rate-limits, and a burst of parallel
   * requests is the fastest way to collect 429s — which then consume retry
   * attempts for messages that were perfectly sendable a second later. A small
   * window is also kinder to a Workers isolate's subrequest budget.
   */
  concurrency?: number
}

export interface DrainReport {
  /** Chat digests queued by this pass before it claimed anything. */
  digestsQueued: number
  claimed: number
  sent: number
  /** Failed but left pending — the next run tries again. */
  retrying: number
  /** Failed permanently (bad address, malformed payload). */
  dropped: number
  /**
   * Distinct provider errors this pass hit, with addresses redacted.
   *
   * Without this a misconfigured deployment is silent in the one place anyone
   * would look. The single most likely first-run failure is `EMAIL_FROM` not
   * being on a verified domain: every send 403s, every row retries, and the
   * report reads `{sent: 0, dropped: 3}` with the reason only in
   * `email_outbox.last_error` — a column no credential but the service role
   * can read. The scheduled workflow echoes this response into its log, so
   * surfacing the provider's own words here is the difference between
   * "configuration is wrong, here is how" and a silent queue.
   *
   * Deduped, capped, and scrubbed: see {@link redactEmails}. A drain's output
   * must never say who was emailed.
   */
  errors: string[]
}

/** How many distinct error strings a report will carry. */
export const MAX_REPORTED_ERRORS = 5

/**
 * Remove anything shaped like an email address from provider error text.
 *
 * Providers echo the offending input back: a 422 for a malformed recipient
 * commonly quotes it. That text ends up in a public CI log via the drain's
 * response, so it is scrubbed here rather than trusted to be clean. Kept
 * deliberately broad — over-redacting an error message costs nothing, and the
 * surrounding words ("domain is not verified", "invalid `to` field") are what
 * actually makes the failure diagnosable.
 */
export function redactEmails(text: string): string {
  return text.replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted]')
}

/** Defaults sized for a hobby-tier provider quota, not for throughput. */
export const DEFAULT_LIMIT = 50
export const DEFAULT_CONCURRENCY = 4

/**
 * Send one claimed job and record what happened.
 *
 * `markResult` is awaited rather than fired off, because the record of a send
 * is what prevents the next run from sending it again — losing it is strictly
 * worse than a slow run.
 */
async function deliver(
  job: EmailJob,
  queue: EmailQueue,
  provider: EmailProvider,
  appOrigin: string,
): Promise<{ outcome: 'sent' | 'retrying' | 'dropped'; error?: string }> {
  try {
    const { subject, html, text } = renderEmail(job, appOrigin)
    const result = await provider.send({ to: job.to_email, subject, html, text })

    if (result.ok) {
      await queue.markResult(job.id, true)
      return { outcome: 'sent' }
    }

    // A permanent failure is recorded as terminal, not merely "failed once".
    // Left to the attempt cap it would cost four more sends to an address that
    // will never accept mail, four more slots of provider quota, and four more
    // retry windows of delay for every message queued behind it.
    const error = result.error ?? 'send failed'
    await queue.markResult(job.id, false, error, !result.retryable)
    return { outcome: result.retryable ? 'retrying' : 'dropped', error }
  } catch (err) {
    // A throw here is ours, not the provider's — a render bug, most likely.
    const message = err instanceof Error ? err.message : String(err)
    try {
      // Not terminal: a throw here is most likely our bug, and a deploy can
      // fix it — so leave the row to be retried rather than discarding a real
      // notification because of a render error.
      await queue.markResult(job.id, false, `drain error: ${message}`)
    } catch {
      // If even recording fails, the row stays claimed and its retry window
      // expires in due course. Nothing more to do from here.
    }
    return { outcome: 'retrying', error: `drain error: ${message}` }
  }
}

/**
 * Run one drain pass.
 *
 * Returns counts only — deliberately never an address, so a drain's output can
 * be logged, surfaced in a workflow run, or returned over HTTP without leaking
 * who was emailed. That is the same discipline the enqueue RPC follows.
 *
 * Never throws for a per-message failure; a single bad row must not strand the
 * rest of the batch.
 */
export async function drainOnce(
  queue: EmailQueue,
  provider: EmailProvider,
  { appOrigin, limit = DEFAULT_LIMIT, concurrency = DEFAULT_CONCURRENCY }: DrainOptions,
): Promise<DrainReport> {
  // Digests first, so anything that just came due is claimable in this same
  // pass rather than waiting a whole interval for the next one. A failure here
  // must not stop event emails going out — they are unrelated.
  let digestsQueued = 0
  if (queue.enqueueDigests) {
    try {
      digestsQueued = (await queue.enqueueDigests()) || 0
    } catch {
      // The digest enqueue is best-effort; the next pass tries again.
    }
  }

  const jobs = await queue.claim(Math.max(1, Math.min(limit, 200)))
  const report: DrainReport = {
    digestsQueued,
    claimed: jobs.length,
    sent: 0,
    retrying: 0,
    dropped: 0,
    errors: [],
  }
  if (jobs.length === 0) return report

  // A Set because one misconfiguration produces the same error once per row,
  // and fifty copies of it is noise, not information.
  const errors = new Set<string>()

  // A fixed pool of workers pulling from a shared cursor: bounded concurrency
  // without batching into fixed-size waves, so one slow send does not idle the
  // others waiting for its wave to finish.
  let cursor = 0
  const width = Math.max(1, Math.min(concurrency, jobs.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= jobs.length) return
        const { outcome, error } = await deliver(jobs[index], queue, provider, appOrigin)
        if (outcome === 'sent') report.sent++
        else if (outcome === 'dropped') report.dropped++
        else report.retrying++
        if (error) errors.add(redactEmails(error))
      }
    }),
  )

  report.errors = [...errors].slice(0, MAX_REPORTED_ERRORS)
  return report
}
