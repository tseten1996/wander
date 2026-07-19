import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import type { InspirationCategory, InspirationItem } from '@/types'

export function useInspiration(tripId: string) {
  return useQuery({
    queryKey: ['inspiration_items', tripId],
    queryFn: async (): Promise<InspirationItem[]> => {
      const { data, error } = await supabase
        .from('inspiration_items')
        .select('*')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['inspiration_items', tripId] })
}

export interface InspirationInput {
  title: string | null
  url: string | null
  image_url: string | null
  note: string | null
  category: InspirationCategory
}

export function useCreateInspiration(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: InspirationInput) => {
      const { error } = await supabase.from('inspiration_items').insert({
        ...input,
        trip_id: tripId,
        created_by: memberId,
      })
      if (error) throw error
      logActivity(tripId, memberId, 'pinned an idea', input.title ?? undefined)
    },
    onSuccess: invalidate,
  })
}

export function useDeleteInspiration(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('inspiration_items').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}
