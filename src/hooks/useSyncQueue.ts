import { useRef } from 'react'
import { useMutationState } from '@tanstack/react-query'
import { deriveSyncQueueState, isReplayableMutationKey, type SyncQueueState } from '@/lib/offlineSync'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

/**
 * The offline-sync banner state (#283): how many offline-originated toggles are
 * still waiting to reach Supabase, and whether a reconnect flush is underway.
 *
 * A toggle queued offline sits in the mutation cache as `status: 'pending'` with
 * `isPaused: true`; on reconnect `onlineManager` resumes it (`isPaused` flips to
 * false) and it stays `pending` only until the write lands. The offline queue
 * depth is therefore the **paused** count — a normal online tap is `pending` too
 * for its round-trip but is never paused, so it must not be counted. All of that
 * distinction lives in the pure {@link deriveSyncQueueState}; this hook only
 * feeds it the live cache and threads the latched drain flag across renders.
 */
export function useSyncQueue(): Omit<SyncQueueState, 'draining'> {
  const online = useOnlineStatus()

  // `isPaused` for every in-flight allow-listed toggle (paused offline, or
  // briefly pending as it flushes). Selecting a primitive keeps useMutationState's
  // structural sharing stable, so this doesn't churn renders.
  const pausedFlags = useMutationState({
    filters: {
      predicate: (mutation) =>
        isReplayableMutationKey(mutation.options.mutationKey) &&
        mutation.state.status === 'pending',
    },
    select: (mutation) => mutation.state.isPaused,
  })

  // Remember the previous drain latch. deriveSyncQueueState is idempotent when
  // fed its own output as wasDraining, so a render-phase write is safe here
  // (including under StrictMode's double invocation).
  const wasDraining = useRef(false)
  const { queued, syncing, draining } = deriveSyncQueueState(pausedFlags, online, wasDraining.current)
  wasDraining.current = draining

  return { queued, syncing }
}
