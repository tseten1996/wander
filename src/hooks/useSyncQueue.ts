import { useMutationState } from '@tanstack/react-query'
import { isReplayableMutationKey } from '@/lib/offlineSync'

/**
 * How many offline-replayable toggles are still waiting to reach Supabase
 * (#283) — paused while offline, or mid-flight during replay on reconnect.
 *
 * A queued toggle sits in the mutation cache as `status: 'pending'` (paused
 * offline, then briefly pending as it flushes); it leaves the count the moment
 * it settles — `success` drops out, `error` rolls the row back and toasts. So
 * this drains cleanly to 0 as the queue empties, and never lingers on a
 * settled mutation. Only the allow-listed toggle keys are counted, so an
 * ordinary in-flight mutation is never mistaken for a queued offline change.
 */
export function useSyncQueueCount(): number {
  return useMutationState({
    filters: {
      predicate: (mutation) =>
        isReplayableMutationKey(mutation.options.mutationKey) &&
        mutation.state.status === 'pending',
    },
  }).length
}
