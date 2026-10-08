/*
  What a notification email actually says (epic #181, the email channel).

  Runtime-agnostic on purpose, exactly like src/server/ai/schemas.ts: this
  module runs unchanged on Cloudflare Workers, Deno or Node, and `node --test`
  imports it directly after type-stripping. So no path aliases, no
  `import.meta`, no browser globals — which is also why `NotificationType`'s
  four values are re-declared here rather than imported from src/types. The one
  import is a relative one to the colour palette, matching how
  src/server/ai/handler.ts reaches src/lib/places.

  THE WHOLE JOB IS RESTRAINT. An email about a trip is competing with the
  recipient's actual inbox, and the fastest way to get the whole channel muted
  is to send something that reads like marketing. So: one fact, one link, no
  images, no tracking pixel, no "we thought you'd love". The subject line
  carries the entire message, because on a phone the subject is often all
  anyone reads.

  EVERY INTERPOLATED VALUE IS ESCAPED. Trip names, item titles and display
  names are member-authored free text that reaches an HTML document here. A
  trip called `<img src=x onerror=...>` must render as those characters, not as
  markup — mail clients vary wildly in what they strip, so we never rely on
  theirs.
*/

import { EMAIL_COLORS } from '../../lib/colors'

/** The event types the inbox carries, mirroring `NotificationType`. */
export const EMAIL_TYPES = [
  'checklist_assigned',
  'poll_opened',
  'expense_owed',
  'mention',
] as const
export type EmailType = (typeof EMAIL_TYPES)[number]

/**
 * One queued email, as `claim_email_batch` hands it over.
 *
 * Two shapes in one row, discriminated by `kind`. A `notification` carries an
 * actor, an event type and the subject's title; a `chat_digest` carries none of
 * those — it has no author by nature ("twelve people said things") — and
 * carries `digest_count` instead. The database enforces the pairing with a
 * CHECK, so a row can never arrive here half-way between the two.
 */
export interface EmailJob {
  id: string
  to_email: string
  /** 'notification' | 'chat_digest'. Absent on rows written before digests
   *  existed, which are notifications by definition. */
  kind?: string | null
  type: string | null
  subject_title: string | null
  trip_name: string
  actor_name: string | null
  /** The in-app hash route, e.g. `#/trip/<id>/chat?n=<id>`. */
  deep_link: string
  /** How many unread messages a digest is about; null for a notification. */
  digest_count?: number | null
  attempts: number
}

/** True when this job is a chat digest rather than a single event. */
export function isDigest(job: EmailJob): boolean {
  return job.kind === 'chat_digest'
}

/** `n` with a correctly pluralised noun — "1 message", "4 messages". */
export function pluralMessages(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`
}

/** A rendered message, ready for any transport. */
export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

/**
 * Escape text for an HTML context. Covers the five characters that can break
 * out of either element content or a double-quoted attribute value, which is
 * every position we interpolate into below.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Clamp member-authored text to a sane length for a subject line or a heading.
 * A 2,000-character "title" is a mis-paste, and a subject that long is
 * truncated by every mail client anyway — doing it ourselves means we choose
 * where the ellipsis lands.
 */
export function clamp(value: string, max: number): string {
  const v = value.trim()
  if (v.length <= max) return v
  // Prefer a word boundary so the cut does not land mid-word.
  const cut = v.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Who caused it, in a form safe to put in a sentence. */
function actor(job: EmailJob): string {
  const name = (job.actor_name ?? '').trim()
  // A member who has since left the trip leaves `actor_id` null, so the event
  // still stands but has no name attached — say so neutrally rather than
  // rendering "null mentioned you".
  return name ? clamp(name, 40) : 'Someone'
}

/**
 * The subject line, which is the real deliverable here.
 *
 * Shaped as "<who> <did what> · <trip>": the trip name comes last so a
 * recipient in several trips can still tell them apart after a mail client
 * truncates, and the actor comes first because that is the part that decides
 * whether this is worth opening. No "Wander:" prefix — the From name already
 * says that, and repeating it wastes the only characters that matter.
 */
export function subjectFor(job: EmailJob): string {
  const who = actor(job)
  const trip = clamp(job.trip_name, 60)

  // A digest leads with the count, because that is the entire decision the
  // recipient makes from the subject line: is it worth opening? There is no
  // actor to name and no single title to quote.
  if (isDigest(job)) {
    return `${pluralMessages(Math.max(1, job.digest_count ?? 1))} in the trip chat · ${trip}`
  }

  const what: Record<EmailType, string> = {
    checklist_assigned: `${who} assigned you a task`,
    poll_opened: `${who} opened a poll`,
    expense_owed: `${who} added an expense you owe on`,
    mention: `${who} mentioned you`,
  }
  const line = what[job.type as EmailType] ?? `${who} needs you`
  return `${line} · ${trip}`
}

/** The one-line explanation under the heading, matching the subject's verb. */
function bodyLineFor(job: EmailJob): string {
  const who = actor(job)
  if (isDigest(job)) {
    const n = Math.max(1, job.digest_count ?? 1)
    return n === 1
      ? 'There’s a new message in the trip chat.'
      : `There are ${n} new messages in the trip chat.`
  }
  const lines: Record<EmailType, string> = {
    checklist_assigned: `${who} assigned this task to you.`,
    poll_opened: `${who} opened a poll and the group is waiting on your vote.`,
    expense_owed: `${who} logged an expense that you're part of.`,
    mention: `${who} mentioned you in the trip chat.`,
  }
  return lines[job.type as EmailType] ?? `${who} needs you on this trip.`
}

/** The call to action, per type. */
function ctaFor(job: EmailJob): string {
  if (isDigest(job)) return 'Catch up on the chat'
  const ctas: Record<EmailType, string> = {
    checklist_assigned: 'View the task',
    poll_opened: 'Cast your vote',
    expense_owed: 'See the expense',
    mention: 'Open the chat',
  }
  return ctas[job.type as EmailType] ?? 'Open the trip'
}

/**
 * Turn the app-relative hash route the outbox stored into an absolute URL.
 *
 * Email has no notion of "relative to the app", so this is the one place an
 * origin is required. `appOrigin` arrives from the drain's environment rather
 * than being hardcoded, because the same build serves GitHub Pages and
 * Cloudflare Pages and a link to the wrong one is a dead end.
 */
export function absoluteLink(appOrigin: string, deepLink: string): string {
  const base = appOrigin.replace(/\/+$/, '')
  const hash = deepLink.startsWith('#') ? deepLink : `#${deepLink}`
  return `${base}/${hash}`
}

/*
  Brand colours.

  Imported rather than written inline: src/lib/colors.ts is one of the files
  the token lint recognises as a palette source, and EMAIL_COLORS documents
  there why an email has to carry hex at all (no stylesheet, no custom
  properties, no <style> in most clients). Destructured to short names purely
  so the template below stays readable.
*/
const {
  primary: TEAL,
  ink: INK,
  muted: MUTED,
  page: CREAM,
  border: BORDER,
  surface: SURFACE,
} = EMAIL_COLORS

/**
 * The full message.
 *
 * Table-based layout with inline styles, because that is what Outlook and
 * Gmail actually render. Deliberately no `<img>`: an image would need an
 * absolute asset URL and would be blocked by default in most clients, so the
 * wordmark is text. The plain-text alternative is not an afterthought —
 * sending `multipart/alternative` materially improves deliverability, and some
 * recipients read only that part.
 */
export function renderEmail(job: EmailJob, appOrigin: string): RenderedEmail {
  const subject = subjectFor(job)
  const url = absoluteLink(appOrigin, job.deep_link)
  const line = bodyLineFor(job)
  const cta = ctaFor(job)
  const trip = clamp(job.trip_name, 60)
  // The subject snapshot: the task / poll / expense title, or the message that
  // mentioned you. Absent on an event whose subject row carried no title.
  const detail = job.subject_title ? clamp(job.subject_title, 160) : null

  const text = [
    line,
    detail ? `\n“${detail}”\n` : '',
    `${cta}: ${url}`,
    '',
    `— Wander · ${trip}`,
    `You're getting this because you turned on email updates for this trip.`,
    `Turn them off any time in the trip's notification settings.`,
  ]
    .filter((l) => l !== '')
    .join('\n')

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${CREAM};">
<!-- Preheader: the grey line a mail client shows after the subject. Without
     one, clients pull the first visible text, which here would be the
     wordmark — a wasted line of the only preview the recipient gets. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(
    detail ?? line,
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:${SURFACE};border:1px solid ${BORDER};border-radius:12px;">
      <tr><td style="padding:24px 24px 8px;font:600 15px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEAL};letter-spacing:-0.01em;">
        Wander
      </td></tr>
      <tr><td style="padding:0 24px;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
        ${escapeHtml(line)}
      </td></tr>
      ${
        detail
          ? `<tr><td style="padding:16px 24px 0;">
        <div style="border-left:3px solid ${TEAL};padding:2px 0 2px 12px;font:400 16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
          ${escapeHtml(detail)}
        </div>
      </td></tr>`
          : ''
      }
      <tr><td style="padding:24px;">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:${TEAL};color:${SURFACE};text-decoration:none;padding:11px 20px;border-radius:8px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          ${escapeHtml(cta)}
        </a>
      </td></tr>
      <tr><td style="padding:0 24px 24px;border-top:1px solid ${BORDER};">
        <p style="margin:16px 0 0;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
          ${escapeHtml(trip)} · You turned on email updates for this trip.
          <a href="${escapeHtml(url)}" style="color:${MUTED};">Turn them off</a> any time.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`

  return { subject, html, text }
}
