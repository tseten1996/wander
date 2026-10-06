import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  BedDouble, Heart, Lightbulb, ListChecks, MapPin, MessageCircle, NotebookPen,
  PiggyBank, Route, Vote, type LucideIcon,
} from 'lucide-react'
import type {
  BudgetEntry, ChecklistItem, InspirationItem, ItineraryItem, Message, Note,
  Poll, PollOption, Stay, Transport, WishlistItem,
} from '@/types'
import {
  collectResults, MIN_QUERY_LENGTH, type SearchKind, type SearchResult,
  type SearchSources,
} from './collect'

export { MIN_QUERY_LENGTH }
export type { SearchKind, SearchResult }

export interface SearchGroup {
  kind: SearchKind
  label: string
  icon: LucideIcon
  results: SearchResult[]
}

export interface SearchOutcome {
  groups: SearchGroup[]
  total: number
}

const KIND_META: Record<SearchKind, { label: string; icon: LucideIcon }> = {
  itinerary: { label: 'Itinerary', icon: MapPin },
  budget: { label: 'Budget', icon: PiggyBank },
  stay: { label: 'Stays', icon: BedDouble },
  transport: { label: 'Transport', icon: Route },
  poll: { label: 'Polls', icon: Vote },
  message: { label: 'Chat', icon: MessageCircle },
  checklist: { label: 'Checklist', icon: ListChecks },
  note: { label: 'Notes', icon: NotebookPen },
  idea: { label: 'Ideas', icon: Lightbulb },
  wishlist: { label: 'Wishlist', icon: Heart },
}

/**
 * Gather every searchable section from the TanStack Query cache only — no
 * network. A section is searchable once its cache key is populated (either its
 * page was opened this session, or the palette's `prefetch` warmed it). The
 * matching itself is the pure `collectResults`; this just reads the cache.
 */
function collect(queryClient: ReturnType<typeof useQueryClient>, tripId: string, q: string): SearchOutcome {
  const sources: SearchSources = {
    itinerary: queryClient.getQueryData<ItineraryItem[]>(['itinerary_items', tripId]) ?? [],
    budget: queryClient.getQueryData<BudgetEntry[]>(['budget_entries', tripId]) ?? [],
    polls:
      queryClient.getQueryData<(Poll & { poll_options: PollOption[] })[]>(['polls', tripId]) ?? [],
    messages: queryClient.getQueryData<Message[]>(['messages', tripId]) ?? [],
    checklist: queryClient.getQueryData<ChecklistItem[]>(['checklist_items', tripId]) ?? [],
    notes: queryClient.getQueryData<Note[]>(['notes', tripId]) ?? [],
    ideas: queryClient.getQueryData<InspirationItem[]>(['inspiration_items', tripId]) ?? [],
    stays: queryClient.getQueryData<Stay[]>(['stays', tripId]) ?? [],
    transport: queryClient.getQueryData<Transport[]>(['transport', tripId]) ?? [],
    wishlist: queryClient.getQueryData<WishlistItem[]>(['wishlist_items', tripId]) ?? [],
  }

  const groups: SearchGroup[] = []
  let total = 0
  for (const { kind, results } of collectResults(sources, q)) {
    groups.push({ kind, label: KIND_META[kind].label, icon: KIND_META[kind].icon, results })
    total += results.length
  }
  return { groups, total }
}

/**
 * Client-side search across the current trip's cached feature data. Recomputed
 * synchronously from the cache whenever the query text changes.
 *
 * When `active` (the palette is open) it also warms the cache for every
 * searchable section, so results no longer depend on which pages the member
 * happened to open this session. Each landed prefetch bumps a revision that
 * recomputes the index against the now-fuller cache — that's the only reason
 * `revision` is a dependency of the memo below.
 */
export function useTripSearch(tripId: string, rawQuery: string, active: boolean): SearchOutcome {
  const queryClient = useQueryClient()
  const [revision, bumpRevision] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    // Loaded lazily so the feature fetchers stay out of the eager shell bundle
    // SearchDialog ships in — they arrive only once the palette opens.
    void import('./prefetch').then(({ prefetchTripSearch }) => {
      if (cancelled) return
      void prefetchTripSearch(queryClient, tripId, () => {
        if (!cancelled) bumpRevision()
      })
    })
    return () => {
      cancelled = true
    }
  }, [active, queryClient, tripId])

  return React.useMemo(() => {
    const q = rawQuery.trim().toLowerCase()
    if (q.length < MIN_QUERY_LENGTH) return { groups: [], total: 0 }
    return collect(queryClient, tripId, q)
  }, [queryClient, tripId, rawQuery, revision])
}
