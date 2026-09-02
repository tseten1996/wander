import type { Comment } from '@/types'

/** Cap the mention notification's title snapshot so a long comment doesn't
 *  bloat the inbox row — matches the chat path (#193). */
export const MENTION_TITLE_MAX = 140

/**
 * Tally per-entity comment counts from the id-only rows `fetchCommentCounts`
 * selects. Pure and framework-free — no Supabase, no React Query — so the
 * reducer that drives every itinerary count badge can be asserted directly
 * (#325). An entity with no rows is simply absent from the Map, so a caller
 * reading it with `?? 0` sees a plain 0 and renders exactly as today.
 */
export function tallyCommentCounts(
  rows: Pick<Comment, 'entity_id'>[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1)
  }
  return counts
}

/**
 * Clip a plain-text comment body to the mention-title snapshot cap, appending an
 * ellipsis when it overflows and passing a body at or under the cap through
 * unchanged. Byte-for-byte identical to the inline logic it replaced, so the
 * notification inbox row is unchanged.
 */
export function truncateMentionTitle(plain: string, max = MENTION_TITLE_MAX): string {
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
