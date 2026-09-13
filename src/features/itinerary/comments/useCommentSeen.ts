import * as React from 'react'
import type { CommentEntityType } from '@/types'

/*
  Device-local "which threads have I read" state for the unread-comment dot
  (#342), reusing the shape of the nav "new since last visit" dots (#43): a
  last-seen timestamp per (trip, entity_type, entity_id, member) kept in
  localStorage. The dot means "new since *you* last looked *here*", which isn't
  server state — so there's no table, no RLS, no new trust surface.

  A tiny module-level store (not the query cache — this is local UI state, not
  the server state TanStack owns) lets the count badge that *reads* the dot and
  the CommentsSection that *marks it seen* live in separate component trees yet
  stay in sync: marking a thread seen re-renders every badge for that surface.
*/

interface SeenState {
  /** First-open time on this device. Entities with no explicit last-seen fall
   *  back to this, so a returning member isn't dotted on every old thread. */
  baseline: string
  /** entity_id → ISO of the newest comment the viewer has acknowledged. */
  seen: Record<string, string>
}

const storageKey = (tripId: string, entityType: CommentEntityType, memberId: string) =>
  `wander_comment_seen_${tripId}_${entityType}_${memberId}`

// One cached SeenState per storage key. getSnapshot returns the cached object
// by reference, so useSyncExternalStore only re-renders when a mark replaces it.
const cache = new Map<string, SeenState>()
const listeners = new Set<() => void>()

function isSeenState(v: unknown): v is SeenState {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SeenState).baseline === 'string' &&
    typeof (v as SeenState).seen === 'object' &&
    (v as SeenState).seen !== null
  )
}

function persist(key: string, state: SeenState) {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Broken/blocked storage → the in-memory cache still keeps this session
    // consistent; it just won't survive a reload.
  }
}

function load(key: string): SeenState {
  const cached = cache.get(key)
  if (cached) return cached

  let state: SeenState | null = null
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (isSeenState(parsed)) state = parsed
    }
  } catch {
    // Broken/blocked storage → behave as a fresh device.
  }

  if (!state) {
    // First open on this device: everything already posted counts as seen, so
    // a member joining a trip with existing discussion isn't dotted everywhere.
    state = { baseline: new Date().toISOString(), seen: {} }
    persist(key, state)
  }
  cache.set(key, state)
  return state
}

function markSeen(key: string, entityId: string, iso: string) {
  const prev = load(key)
  const current = prev.seen[entityId]
  // Only ever move the marker forward — a stale mark must not un-see newer
  // discussion the viewer has already caught up on.
  if (current && new Date(current).getTime() >= new Date(iso).getTime()) return
  const next: SeenState = {
    baseline: prev.baseline,
    seen: { ...prev.seen, [entityId]: iso },
  }
  cache.set(key, next)
  persist(key, next)
  listeners.forEach((notify) => notify())
}

const subscribe = (notify: () => void) => {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

/**
 * Read/write the viewer's per-entity last-seen state for one comment surface.
 * `state` feeds `isEntityUnread`; `markSeen(entityId, iso)` acknowledges a
 * thread up to `iso` (call it when the thread is opened or a comment posted).
 */
export function useCommentSeen(
  tripId: string,
  entityType: CommentEntityType,
  memberId: string
) {
  const key = storageKey(tripId, entityType, memberId)
  const getSnapshot = React.useCallback(() => load(key), [key])
  const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const mark = React.useCallback(
    (entityId: string, iso: string) => markSeen(key, entityId, iso),
    [key]
  )
  return { state, markSeen: mark }
}
