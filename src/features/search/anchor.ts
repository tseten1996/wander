/**
 * A stable DOM id for a searchable record, shared by two places:
 *  - each feature page stamps it on the item's rendered root, and
 *  - a search result deep-links to `#<anchor>` so the item can be scrolled
 *    to and briefly highlighted when the page opens.
 *
 * Record ids are UUIDs (globally unique), so a single flat namespace is safe.
 */
export function searchAnchorId(recordId: string): string {
  return `wander-item-${recordId}`
}
