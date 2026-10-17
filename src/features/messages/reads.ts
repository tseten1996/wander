/**
 * Chat read-marker gating (#396, epic #181).
 *
 * The server-side read marker (`chat_reads`, written by the chat page and read
 * by the email digest) must only ever claim the messages the reader has
 * actually seen. A member re-reading earlier chat while new messages arrive is
 * *not* caught up: the "N new messages" pill is proof they haven't reached the
 * bottom, and advancing the marker past those arrivals would withhold the one
 * digest meant to catch them up.
 *
 * So the page tracks the newest message id seen *while at/near the live edge*
 * and feeds that to `useMarkChatRead`, rather than the unconditional live
 * newest. This pure helper is the single rule for how that id moves, kept
 * dependency-free so it can be unit-tested without React.
 */

/**
 * The newest message id the read marker is allowed to reach.
 *
 * At/near the live edge (`atBottom`) the reader is caught up, so the id tracks
 * the current newest. Scrolled up it holds at whatever they last saw at the
 * bottom — so the marker, and the digest that reads it, never advance past
 * arrivals they haven't seen. Scrolling back to the bottom (which also clears
 * the pill) catches it up again.
 */
export function advanceSeenId(
  prevSeenId: string | undefined,
  newestId: string | undefined,
  atBottom: boolean,
): string | undefined {
  return atBottom ? newestId : prevSeenId
}
