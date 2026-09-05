import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import {
  initialResyncState,
  reduceRegain,
  reduceStatus,
  type ResyncState,
} from '@/lib/realtimeResync'

// Child tables whose changes should refresh their parent feature's query
const INVALIDATION_ALIASES: Record<string, string[]> = {
  poll_options: ['polls'],
  votes: ['polls'],
  message_reactions: ['messages'],
  // Availability poll children roll up into the parent poll query (#176).
  availability_candidates: ['availability_polls'],
  availability_responses: ['availability_polls'],
  // A comment change refreshes both the open thread and the itinerary count
  // badges (#314). Both keys are prefixes: TanStack invalidates every query
  // whose key starts with `['comments', tripId]` / `['comment_counts', tripId]`.
  comments: ['comments', 'comment_counts'],
}

// (trips is handled separately below — it filters on `id`, not `trip_id`)
const TABLES = [
  'members', 'polls', 'poll_options', 'votes', 'messages',
  'message_reactions', 'questions', 'checklist_items', 'itinerary_items',
  'budget_entries', 'repayments', 'packing_items', 'notes', 'inspiration_items',
  'activity', 'notifications', 'availability_polls', 'availability_candidates',
  'availability_responses', 'destinations', 'trip_preferences', 'trip_photos',
  'comments',
]

/**
 * How long a reconnect/visibility catch-up is coalesced (#332). A socket drop
 * surfaces as a short burst — CHANNEL_ERROR/CLOSED → SUBSCRIBED, often with an
 * `online` or `visibilitychange` event alongside — so a single debounce
 * collapses the whole burst into one invalidation pass instead of several.
 */
const RESYNC_DEBOUNCE_MS = 250

/**
 * One realtime channel per open trip. Any change made by another member
 * invalidates the matching TanStack Query cache, so every screen is live
 * without feature-specific socket code.
 *
 * Steady state is per-event: a single CDC row invalidates just its own feature
 * keys (below). But CDC is **not** replayed on reconnect — a socket that
 * dropped while the tab was backgrounded delivers only *new* changes when it
 * comes back, so everything other members changed in the meantime would stay
 * silently stale in the persisted cache (#332). To close that gap, a reconnect
 * *after a real drop* (and a visibility/online regain while a drop is pending)
 * invalidates the trip's active keys once, coalesced. A healthy, never-dropped
 * socket never triggers this, so the refetch-on-focus storms ARCHITECTURE §6
 * warns against are not reintroduced.
 */
export function useTripRealtime(tripId: string | undefined) {
  const queryClient = useQueryClient()

  React.useEffect(() => {
    if (!tripId) return

    // ── Coalesced catch-up: one debounced invalidation pass, however many
    //    reconnect/visibility/online signals arrive together (#332). Only
    //    currently-mounted queries actually refetch — invalidating an inactive
    //    key just marks it stale — so the burst is bounded to what's on screen.
    let resyncTimer: ReturnType<typeof setTimeout> | undefined
    const invalidateEverything = () => {
      for (const table of TABLES) {
        const keys = INVALIDATION_ALIASES[table] ?? [table]
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: [key, tripId] })
        }
      }
      queryClient.invalidateQueries({ queryKey: ['activity', tripId] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', tripId] })
      queryClient.invalidateQueries({ queryKey: ['calendar', tripId] })
      queryClient.invalidateQueries({ queryKey: ['trip', tripId] })
      queryClient.invalidateQueries({ queryKey: ['trips'] })
    }
    const scheduleResync = () => {
      if (resyncTimer) return // already coalescing this burst
      resyncTimer = setTimeout(() => {
        resyncTimer = undefined
        invalidateEverything()
      }, RESYNC_DEBOUNCE_MS)
    }

    // The reconnect state machine (pure, unit-tested in realtimeResync.ts).
    let resyncState: ResyncState = initialResyncState

    const channel = supabase.channel(`trip:${tripId}`)
    for (const table of TABLES) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `trip_id=eq.${tripId}` },
        () => {
          const keys = INVALIDATION_ALIASES[table] ?? [table]
          for (const key of keys) {
            queryClient.invalidateQueries({ queryKey: [key, tripId] })
          }
          // The dashboard + calendar aggregate several tables; refresh on anything
          queryClient.invalidateQueries({ queryKey: ['activity', tripId] })
          queryClient.invalidateQueries({ queryKey: ['dashboard', tripId] })
          queryClient.invalidateQueries({ queryKey: ['calendar', tripId] })
        }
      )
    }
    // `trips` rows filter on id, not trip_id
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'trips', filter: `id=eq.${tripId}` },
      () => {
        queryClient.invalidateQueries({ queryKey: ['trip', tripId] })
        queryClient.invalidateQueries({ queryKey: ['trips'] })
      }
    )
    channel.subscribe((status) => {
      // supabase-js reports SUBSCRIBED on a successful (re)join; every other
      // status (TIMED_OUT, CLOSED, CHANNEL_ERROR) is a drop.
      const { state, resync } = reduceStatus(resyncState, String(status) === 'SUBSCRIBED')
      resyncState = state
      if (resync) scheduleResync()
    })

    // Visibility/online regain accelerates the catch-up on a phone waking a
    // suspended PWA — but only when a drop is already known (reduceRegain
    // guards this), so a healthy socket regaining focus never refetches.
    const onRegain = () => {
      const { state, resync } = reduceRegain(resyncState)
      resyncState = state
      if (resync) scheduleResync()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onRegain()
    }
    window.addEventListener('online', onRegain)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (resyncTimer) clearTimeout(resyncTimer)
      window.removeEventListener('online', onRegain)
      document.removeEventListener('visibilitychange', onVisibility)
      supabase.removeChannel(channel)
    }
  }, [tripId, queryClient])
}
