import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Destination } from '@/types'

/** The trip's ordered legs. Keyed `['destinations', tripId]` so realtime and
 *  every consumer (settings editor, itinerary, calendar, hero, sidebar) share
 *  one fetch. */
export function useDestinations(tripId: string) {
  return useQuery({
    queryKey: ['destinations', tripId],
    queryFn: async (): Promise<Destination[]> => {
      const { data, error } = await supabase
        .from('destinations')
        .select('*')
        .eq('trip_id', tripId)
        .order('position')
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['destinations', tripId] })
}

export interface DestinationInput {
  name: string
  latitude?: number | null
  longitude?: number | null
  start_date?: string | null
  end_date?: string | null
}

export function useCreateDestination(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: DestinationInput) => {
      const { error } = await supabase.from('destinations').insert({
        trip_id: tripId,
        name: input.name,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        start_date: input.start_date || null,
        end_date: input.end_date || null,
        position: Date.now(), // append at the end; stable and monotonic
      })
      if (error) throw error
      logActivity(tripId, memberId, 'added a destination', input.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not add that destination')),
  })
}

type DestinationUpdate = Partial<Destination> & { id: string }

export function useUpdateDestination(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: DestinationUpdate) => {
      const { error } = await supabase.from('destinations').update(patch).eq('id', id)
      if (error) throw error
      if (patch.name) logActivity(tripId, memberId, 'updated a destination', patch.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that destination')),
  })
}

/** Position-only update for reorder (move up/down). Kept separate from the edit
 *  mutation so shuffling the route never spams the activity feed. */
export function useReorderDestination(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, position }: { id: string; position: number }) => {
      const { error } = await supabase.from('destinations').update({ position }).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not reorder destinations')),
  })
}

export function useDeleteDestination(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (dest: Destination) => {
      const { error } = await supabase.from('destinations').delete().eq('id', dest.id)
      if (error) throw error
      logActivity(tripId, memberId, 'removed a destination', dest.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not remove that destination')),
  })
}
