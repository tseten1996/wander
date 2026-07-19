import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

// Child tables whose changes should refresh their parent feature's query
const INVALIDATION_ALIASES: Record<string, string[]> = {
  poll_options: ['polls'],
  votes: ['polls'],
  message_reactions: ['messages'],
}

// (trips is handled separately below — it filters on `id`, not `trip_id`)
const TABLES = [
  'members', 'polls', 'poll_options', 'votes', 'messages',
  'message_reactions', 'questions', 'checklist_items', 'itinerary_items',
  'budget_entries', 'packing_items', 'notes', 'inspiration_items', 'activity',
]

/**
 * One realtime channel per open trip. Any change made by another member
 * invalidates the matching TanStack Query cache, so every screen is live
 * without feature-specific socket code.
 */
export function useTripRealtime(tripId: string | undefined) {
  const queryClient = useQueryClient()

  React.useEffect(() => {
    if (!tripId) return

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
          // The dashboard aggregates several tables; refresh it on anything
          queryClient.invalidateQueries({ queryKey: ['activity', tripId] })
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
    channel.subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [tripId, queryClient])
}
