import type { Member } from '@/types'

/**
 * Chat @-mentions (epic #181, slice 2 / #193).
 *
 * A mention is stored inline in the message as `@[Display Name](member-uuid)`.
 * The name is a snapshot for readability; the `member-uuid` is the source of
 * truth the renderer resolves back to a live member, so a chip stays correct if
 * that member is later renamed. Parsing is a single regex with no markdown
 * library, matching the house style of `src/features/itinerary/parse.ts`.
 */

/** The shape of a member id (Postgres uuid). */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/** Matches one stored mention token. Source-only — build a fresh `RegExp` per
 *  use so nobody trips over a shared global's `lastIndex`. */
export const MENTION_SOURCE = `@\\[([^\\]]+)\\]\\((${UUID})\\)`

export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; name: string; memberId: string }

/** Split raw message content into ordered text / mention segments. */
export function parseMentions(content: string): MentionSegment[] {
  const segments: MentionSegment[] = []
  const re = new RegExp(MENTION_SOURCE, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    if (m.index > last) segments.push({ type: 'text', value: content.slice(last, m.index) })
    segments.push({ type: 'mention', name: m[1], memberId: m[2] })
    last = m.index + m[0].length
  }
  if (last < content.length) segments.push({ type: 'text', value: content.slice(last) })
  return segments
}

/** The distinct member ids mentioned in a message, in first-seen order. A
 *  member mentioned twice appears once — the caller notifies each id once. */
export function extractMentionIds(content: string): string[] {
  const ids: string[] = []
  const re = new RegExp(MENTION_SOURCE, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    if (!ids.includes(m[2])) ids.push(m[2])
  }
  return ids
}

/** Flatten mention tokens to plain `@Name` for previews and snapshots that show
 *  raw text rather than chips (reply quote, pinned strip, notification title). */
export function mentionsToPlainText(content: string): string {
  return content.replace(new RegExp(MENTION_SOURCE, 'g'), (_all, name) => `@${name}`)
}

/** The token a composer inserts when a member is picked. */
export function formatMention(member: Pick<Member, 'id' | 'display_name'>): string {
  return `@[${member.display_name}](${member.id})`
}

export interface ActiveMention {
  /** Index of the triggering `@` in the text. */
  start: number
  /** The raw query typed after `@`, up to the caret (empty right after `@`). */
  query: string
}

/** Characters that end a mention run — whitespace or any token punctuation. */
const MENTION_STOP = /[\s[\]()@]/

/**
 * Detect an in-progress `@mention` immediately before the caret: an `@` at the
 * start of the text or after whitespace, followed by a run of non-breaking
 * characters up to the caret. Returns null when the caret is not inside such a
 * run — so an already-inserted `@[Name](id)` token never re-triggers the picker
 * (its `[]()` punctuation stops the scan) and an email like `a@b` is ignored
 * (the `@` is not preceded by whitespace).
 */
export function detectActiveMention(text: string, caret: number): ActiveMention | null {
  let i = caret - 1
  while (i >= 0 && !MENTION_STOP.test(text[i])) i--
  if (i < 0 || text[i] !== '@') return null
  if (i > 0 && !/\s/.test(text[i - 1])) return null
  return { start: i, query: text.slice(i + 1, caret) }
}

/** Members whose display name matches an active query (case-insensitive
 *  substring). An empty query matches everyone. */
export function matchMembers<T extends { display_name: string }>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return members
  return members.filter((m) => m.display_name.toLowerCase().includes(q))
}

/** Replace the active `@query` with a full mention token (plus a trailing
 *  space) and report where the caret should land after it. */
export function applyMention(
  text: string,
  active: ActiveMention,
  member: Pick<Member, 'id' | 'display_name'>
): { text: string; caret: number } {
  const before = text.slice(0, active.start)
  const after = text.slice(active.start + 1 + active.query.length)
  const insert = `${formatMention(member)} `
  return { text: `${before}${insert}${after}`, caret: before.length + insert.length }
}
