/**
 * Pure, dependency-free core of the itinerary comment feature (#314, #325).
 *
 * These two helpers hold the branchy logic that `api.ts` composes with
 * react-query and Supabase — kept in their own module with no runtime imports
 * so they can be unit-tested directly (`tests/comments.test.mjs`) without
 * standing up the query/client surface `api.ts` pulls in.
 */

/** Cap the mention notification's title snapshot so a long comment doesn't
 *  bloat the inbox row — matches the chat path (#193). */
export const MENTION_TITLE_MAX = 140

/**
 * Per-entity discussion summary: how many comments an entity has, plus the
 * newest comment's timestamp and author. The count drives the badge number
 * (as `tallyCommentCounts` did before #342); the newest fields drive the
 * unread-dot comparison — newer than the viewer's last-seen means "new to you"
 * (#342), and a newest comment the viewer wrote themselves is never unread.
 */
export interface EntityCommentActivity {
  count: number
  /** ISO timestamp of the newest comment on this entity. */
  newestAt: string
  /** `member_id` of the newest comment's author; null once that author left. */
  newestBy: string | null
}

/**
 * Tally per-entity comment activity from the cheap
 * `entity_id, created_at, member_id` rows `fetchCommentActivity` selects.
 * Returns `entity_id → {count, newestAt, newestBy}`; an entity absent from the
 * rows is simply missing from the map, so a `.get(id)` read at the call site is
 * `undefined` for an item with no comments and renders exactly as today.
 */
export function tallyCommentActivity(
  rows: { entity_id: string; created_at: string; member_id: string | null }[]
): Map<string, EntityCommentActivity> {
  const activity = new Map<string, EntityCommentActivity>()
  for (const row of rows) {
    const prev = activity.get(row.entity_id)
    if (!prev) {
      activity.set(row.entity_id, {
        count: 1,
        newestAt: row.created_at,
        newestBy: row.member_id,
      })
      continue
    }
    prev.count += 1
    if (new Date(row.created_at).getTime() > new Date(prev.newestAt).getTime()) {
      prev.newestAt = row.created_at
      prev.newestBy = row.member_id
    }
  }
  return activity
}

/**
 * Whether an entity's discussion is "new to you": there is a newest comment,
 * the viewer did not write it, and it is newer than the viewer's last-seen
 * stamp for this entity. Entities the viewer has never explicitly opened fall
 * back to `baseline` (their first-open time on this device), so a returning
 * member isn't greeted by a dot on every pre-existing thread — matching the
 * seed behaviour of the nav "new since last visit" dots (#43).
 */
export function isEntityUnread(
  entry: EntityCommentActivity | undefined,
  lastSeen: string | undefined,
  baseline: string,
  memberId: string
): boolean {
  if (!entry) return false
  // A comment the viewer just posted themselves never marks the entity unread
  // to them (#342) — covered even before the mark-seen write lands.
  if (entry.newestBy === memberId) return false
  const seen = lastSeen ?? baseline
  return new Date(entry.newestAt).getTime() > new Date(seen).getTime()
}

/**
 * Truncate a plain-text comment body for the mention notification's title
 * snapshot: a body over `max` characters is clipped to `max` with the final
 * character replaced by an ellipsis; a body at or under `max` passes through
 * unchanged.
 */
export function truncateMentionTitle(plain: string, max = MENTION_TITLE_MAX): string {
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
