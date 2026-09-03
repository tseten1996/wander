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
 * Tally per-entity comment counts from the cheap `entity_id`-only rows that
 * `fetchCommentCounts` selects. Returns `entity_id → count`; an entity absent
 * from the rows is simply missing from the map, so a `.get(id) ?? 0` read at
 * the call site renders a plain 0 for an item with no comments.
 */
export function tallyCommentCounts(rows: { entity_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1)
  }
  return counts
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
