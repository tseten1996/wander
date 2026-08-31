import type { MutationKey } from '@tanstack/react-query'

/**
 * Offline mutation replay (#283) — the allow-list and the pure predicates that
 * decide which mutations may be queued offline, persisted, and replayed on
 * reconnect. Kept dependency-free (type-only imports) so it can be unit-tested
 * against the TypeScript source directly and imported before cache hydration.
 *
 * Only two deliberately low-risk toggles opt in: the packing "packed" checkbox
 * and the checklist "done" checkbox. Everything else stays online-only and
 * fails visibly offline (`friendlyError` toast) — no silent queueing is
 * introduced anywhere else. Money and destructive paths are explicitly out of
 * scope.
 *
 * Both toggles carry an **absolute target value**, never a flip, so a replay is
 * idempotent: a toggle queued twice — or replayed after another member changed
 * the same row — converges on the same value instead of double-applying (the
 * hazard #283's acceptance criteria pin down, same class as #272).
 */

/** Stable mutation key for a queued packing "packed" toggle. Persisted to disk
 *  as the identity a restored, paused mutation is matched back to its
 *  `setMutationDefaults` handler by — changing it strands in-flight offline
 *  writes, so treat it like the persist buster. */
export const PACKING_TOGGLE_MUTATION_KEY = ['packing_items', 'toggle'] as const

/** Stable mutation key for a queued checklist "done" toggle. Same persistence
 *  contract as {@link PACKING_TOGGLE_MUTATION_KEY}. */
export const CHECKLIST_TOGGLE_MUTATION_KEY = ['checklist_items', 'toggle'] as const

/** Variables for a queued packing toggle. All fields are plain JSON so the
 *  mutation survives being persisted to `localStorage` and rehydrated. */
export interface TogglePackedVars {
  tripId: string
  id: string
  /** The value to write — not a flip. Absolute so replay is idempotent. */
  packed: boolean
}

/** Variables for a queued checklist toggle. Carries `memberId`/`title` because
 *  a replayed mutation runs from `setMutationDefaults` with no React closure,
 *  and marking a task done writes an activity row. */
export interface ToggleDoneVars {
  tripId: string
  id: string
  /** The value to write — not a flip. Absolute so replay is idempotent. */
  done: boolean
  memberId: string
  title: string
}

const REPLAYABLE_KEY_HASHES: readonly string[] = [
  JSON.stringify(PACKING_TOGGLE_MUTATION_KEY),
  JSON.stringify(CHECKLIST_TOGGLE_MUTATION_KEY),
]

/**
 * True only for the two allow-listed offline-replayable toggle keys. This is
 * the single gate that keeps every other mutation from being persisted or
 * counted as "waiting to sync" — a safety belt on top of those toggles being
 * the only ones left pausable offline.
 */
export function isReplayableMutationKey(key: MutationKey | undefined): boolean {
  if (key == null) return false
  return REPLAYABLE_KEY_HASHES.includes(JSON.stringify(key))
}

/** The shape `shouldPersistMutation` reads — a structural subset of TanStack's
 *  `Mutation`, so the predicate is testable without constructing a real one. */
export interface PersistableMutation {
  state: { isPaused: boolean }
  options: { mutationKey?: MutationKey }
}

/**
 * Which mutations are written into the persisted snapshot: only a paused one
 * whose key is allow-listed. Paused ⇒ it never reached Supabase, so replaying
 * it later is safe; the key gate ⇒ no unrelated mutation can ride along and be
 * silently replayed under another account after sign-out.
 */
export function shouldPersistMutation(mutation: PersistableMutation): boolean {
  return mutation.state.isPaused && isReplayableMutationKey(mutation.options.mutationKey)
}

/** What the offline banner renders, derived by {@link deriveSyncQueueState}. */
export interface SyncQueueState {
  /** How many changes the banner reports as offline-originated. */
  queued: number
  /** True while a reconnect flush is in progress — drives the "syncing…" pill. */
  syncing: boolean
  /** Latched drain flag to thread back on the next derivation (opaque to callers
   *  except that the previous value is passed in as `wasDraining`). */
  draining: boolean
}

/**
 * Pure derivation of the offline-sync banner state (#283), split out of the hook
 * so its one subtle property is pinned by a unit test rather than only
 * reproducible in a browser: a **normal online toggle is never counted**.
 *
 * The bug this fixes (bounced on the first cut): counting every allow-listed
 * toggle whose `status === 'pending'` also caught an ordinary online tap, which
 * is `pending` (but *not paused*) for its Supabase round-trip — so every wifi
 * tap briefly flashed the "syncing…" pill.
 *
 * `pausedFlags` is `isPaused` for each in-flight allow-listed toggle:
 * - **Offline queue depth** = the paused ones. A live online tap is never
 *   paused, so it never counts here.
 * - **`draining`** latches the reconnect flush: it arms while anything sits
 *   paused and clears only once the device is online with nothing allow-listed
 *   in flight — so "syncing N…" tracks the queue draining, not raw pending. A
 *   fresh online tap after the queue has drained can't re-arm it (nothing was
 *   paused), so it leaves the banner hidden.
 */
export function deriveSyncQueueState(
  pausedFlags: readonly boolean[],
  online: boolean,
  wasDraining: boolean,
): SyncQueueState {
  const inFlight = pausedFlags.length
  const pausedCount = pausedFlags.reduce((n, paused) => (paused ? n + 1 : n), 0)

  const draining =
    pausedCount > 0 ? true : online && inFlight === 0 ? false : wasDraining

  const syncing = online && draining && inFlight > 0
  const queued = syncing ? inFlight : pausedCount

  return { queued, syncing, draining }
}
