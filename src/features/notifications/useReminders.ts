import * as React from 'react'
import { useTripContext } from '@/hooks/useTrip'
import { useChecklist } from '@/features/checklist/api'
import { usePacking } from '@/features/packing/api'
import { usePolls } from '@/features/polls/api'
import { deriveReminders, type Reminder } from './reminders'
import { useDismissedReminders } from './reminderDismissal'

/**
 * The signed-in member's live reminders for the current trip (#195).
 *
 * Reads only the feature queries that are already the app's cached source of
 * truth — `checklist_items`, `polls`, `packing_items` — all keyed `[table,
 * tripId]` and invalidated by the same per-trip realtime channel as everywhere
 * else. Because the bell mounts inside the trip shell, these resolve from the
 * TanStack cache (persisted across reloads) or fetch once per trip and dedupe
 * with the matching feature page; there are no per-reminder queries and no new
 * network on render. Derivation is delegated to the pure `deriveReminders`, and
 * session-dismissed reminders are filtered out here.
 */
export function useReminders(): Reminder[] {
  const { trip, me } = useTripContext()
  const checklist = useChecklist(trip.id)
  const polls = usePolls(trip.id)
  const packing = usePacking(trip.id)
  const dismissed = useDismissedReminders()

  const checklistData = checklist.data
  const pollsData = polls.data
  const packingData = packing.data

  return React.useMemo(() => {
    const all = deriveReminders({
      meId: me.id,
      // Snapshotted whenever the cached data changes; realtime keeps it fresh.
      now: Date.now(),
      tripId: trip.id,
      tripStartDate: trip.start_date,
      checklist: checklistData ?? [],
      polls: pollsData ?? [],
      packing: packingData ?? [],
    })
    return all.filter((r) => !dismissed.has(r.id))
  }, [me.id, trip.id, trip.start_date, checklistData, pollsData, packingData, dismissed])
}
