import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import type { ItineraryCategory, ItineraryItem } from '@/types'

export function useItinerary(tripId: string) {
  return useQuery({
    queryKey: ['itinerary_items', tripId],
    queryFn: async (): Promise<ItineraryItem[]> => {
      const { data, error } = await supabase
        .from('itinerary_items')
        .select('*')
        .eq('trip_id', tripId)
        .order('day', { nullsFirst: false })
        .order('position')
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['itinerary_items', tripId] })
}

export interface ItineraryInput {
  title: string
  category: ItineraryCategory
  day: string | null
  start_time: string | null
  end_time: string | null
  location: string | null
  notes: string | null
  cost: number | null
}

export function useCreateItineraryItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: ItineraryInput) => {
      const { error } = await supabase.from('itinerary_items').insert({
        ...input,
        trip_id: tripId,
        created_by: memberId,
        position: Date.now(),
      })
      if (error) throw error
      logActivity(tripId, memberId, 'added to the itinerary', input.title)
    },
    onSuccess: invalidate,
  })
}

export function useUpdateItineraryItem(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<ItineraryItem> & { id: string }) => {
      const { error } = await supabase.from('itinerary_items').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}

/** Persist a drag-reorder within one day with an optimistic cache swap. */
export function useReorderItinerary(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, position }: { id: string; position: number }) => {
      const { error } = await supabase
        .from('itinerary_items')
        .update({ position })
        .eq('id', id)
      if (error) throw error
    },
    onMutate: async ({ id, position }) => {
      await queryClient.cancelQueries({ queryKey: ['itinerary_items', tripId] })
      const previous = queryClient.getQueryData<ItineraryItem[]>(['itinerary_items', tripId])
      queryClient.setQueryData<ItineraryItem[]>(['itinerary_items', tripId], (old) =>
        (old ?? [])
          .map((i) => (i.id === id ? { ...i, position } : i))
          .sort((a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999') || a.position - b.position)
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['itinerary_items', tripId], ctx.previous)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['itinerary_items', tripId] }),
  })
}

export function useDeleteItineraryItem(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('itinerary_items').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}
