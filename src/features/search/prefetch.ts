import type { QueryClient } from '@tanstack/react-query'
import { fetchPolls } from '@/features/polls/api'
import { fetchMessages } from '@/features/messages/api'
import { fetchChecklist } from '@/features/checklist/api'
import { fetchNotes } from '@/features/notes/api'
import { fetchInspiration } from '@/features/inspiration/api'
import { fetchItinerary } from '@/features/itinerary/api'
import { fetchBudget } from '@/features/budget/api'

/**
 * Warm the TanStack Query cache for every section the palette searches, so a
 * result can be found on a page this session hasn't visited yet (the index in
 * `useTripSearch` reads the cache, never the network). Each source routes
 * through its own feature `api.ts` fetcher, keeping every table's Supabase
 * access inside that feature — this module never touches Supabase itself.
 *
 * Loaded lazily (dynamically imported by `useTripSearch` the first time the
 * palette opens) so its seven feature modules stay out of the eager shell
 * bundle. Each fetcher writes the *same* cache key its own hook reads, so a
 * later visit to that page renders instantly from this warmed cache.
 */
const SOURCES: { key: string; fetch: (tripId: string) => Promise<unknown> }[] = [
  { key: 'itinerary_items', fetch: fetchItinerary },
  { key: 'budget_entries', fetch: fetchBudget },
  { key: 'polls', fetch: fetchPolls },
  { key: 'messages', fetch: fetchMessages },
  { key: 'checklist_items', fetch: fetchChecklist },
  { key: 'notes', fetch: fetchNotes },
  { key: 'inspiration_items', fetch: fetchInspiration },
]

/**
 * Prefetch every searchable section for `tripId`. `onSettle` fires once per
 * source as it lands, so the caller can recompute results incrementally rather
 * than waiting for the slowest fetch. A `staleTime` means reopening the palette
 * within the window reuses fresh cache instead of refetching all seven.
 */
export async function prefetchTripSearch(
  queryClient: QueryClient,
  tripId: string,
  onSettle?: () => void,
): Promise<void> {
  await Promise.all(
    SOURCES.map(({ key, fetch }) =>
      // prefetchQuery swallows its own errors (they surface in query state), so a
      // section that fails to load simply stays uncovered — never a thrown reject.
      queryClient
        .prefetchQuery({
          queryKey: [key, tripId],
          queryFn: () => fetch(tripId),
          staleTime: 60_000,
        })
        .then(() => onSettle?.()),
    ),
  )
}
