/**
 * Reconnect re-sync state machine for the per-trip realtime channel (#332).
 *
 * Wander trades refetch-on-focus for realtime invalidation (ARCHITECTURE §6)
 * and persists the query cache to localStorage. That combination has a blind
 * spot on mobile: when the OS suspends a backgrounded PWA the realtime socket
 * drops, and Postgres CDC events are **not** replayed on reconnect — a
 * resubscribe delivers only *new* changes. So everything other members changed
 * while the tab was asleep (a new itinerary stop, an edited budget entry, a
 * closed poll) is silently missing from the persisted cache until some other
 * refetch happens to run.
 *
 * The fix is to invalidate the trip's active query keys **once** when the
 * channel reconnects after a real drop (and, as an accelerant, when the tab
 * regains visibility or the device comes back online) — never on a healthy,
 * never-dropped socket, which would reintroduce exactly the refetch-on-focus
 * storms §6 warns against.
 *
 * This module is the pure decision core, kept dependency-free (no imports at
 * all) so it can be unit-tested against the TypeScript source directly with
 * `node --test` — the same contract as `offlineSync.ts`. The React/Supabase
 * wiring lives in `src/hooks/useRealtime.ts`.
 */

export interface ResyncState {
  /** Whether the channel has reached SUBSCRIBED at least once — the initial
   *  connect. A channel that has never connected missed nothing, so nothing it
   *  does before the first SUBSCRIBED can trigger a catch-up. */
  everSubscribed: boolean
  /** Whether the channel has dropped since the last successful SUBSCRIBED. This
   *  is the guard that keeps a healthy socket from ever re-syncing: only a real
   *  drop arms the next reconnect (or visibility/online regain) to catch up. */
  droppedSinceConnect: boolean
}

export const initialResyncState: ResyncState = {
  everSubscribed: false,
  droppedSinceConnect: false,
}

export interface ResyncResult {
  /** The next state to carry forward. */
  state: ResyncState
  /** True when the caller should schedule a (coalesced) catch-up re-sync now. */
  resync: boolean
}

/**
 * Fold a channel subscribe-status change into the machine. `subscribed` is
 * `true` only for the SUBSCRIBED status; every other status the channel reports
 * (TIMED_OUT, CLOSED, CHANNEL_ERROR) is a drop.
 *
 * - First SUBSCRIBED ever → connected, **no** resync (a fresh mount already
 *   fetched what it needs; refetching here would double-fetch on every open).
 * - SUBSCRIBED after a drop → reconnected, **resync** and disarm.
 * - SUBSCRIBED with no drop since the last one → redundant, no resync.
 * - A drop after having connected → arm the next reconnect; no resync yet.
 * - Any status churn before the first connect → ignored (nothing missed).
 */
export function reduceStatus(state: ResyncState, subscribed: boolean): ResyncResult {
  if (subscribed) {
    if (!state.everSubscribed) {
      return { state: { everSubscribed: true, droppedSinceConnect: false }, resync: false }
    }
    if (state.droppedSinceConnect) {
      return { state: { everSubscribed: true, droppedSinceConnect: false }, resync: true }
    }
    return { state, resync: false }
  }
  if (state.everSubscribed && !state.droppedSinceConnect) {
    return { state: { ...state, droppedSinceConnect: true }, resync: false }
  }
  return { state, resync: false }
}

/**
 * Fold an `online` / `visibilitychange`→visible regain into the machine. It
 * only accelerates catch-up when a drop is already known — on a healthy socket
 * it is a no-op, so focus/visibility churn can never trigger a refetch storm.
 *
 * When it does fire it disarms `droppedSinceConnect`, so the reconnect
 * SUBSCRIBED that follows won't fire a second, redundant burst for the same
 * outage.
 */
export function reduceRegain(state: ResyncState): ResyncResult {
  if (state.everSubscribed && state.droppedSinceConnect) {
    return { state: { ...state, droppedSinceConnect: false }, resync: true }
  }
  return { state, resync: false }
}
