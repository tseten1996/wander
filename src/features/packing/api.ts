import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { PackingCategory, PackingItem } from '@/types'

export function usePacking(tripId: string) {
  return useQuery({
    queryKey: ['packing_items', tripId],
    queryFn: async (): Promise<PackingItem[]> => {
      const { data, error } = await supabase
        .from('packing_items')
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
  return () => queryClient.invalidateQueries({ queryKey: ['packing_items', tripId] })
}

export function useAddPackingItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ name, category }: { name: string; category: PackingCategory }) => {
      const { error } = await supabase.from('packing_items').insert({
        trip_id: tripId,
        added_by: memberId,
        name,
        category,
        position: Date.now(),
      })
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}

export function useTogglePacked(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (item: PackingItem) => {
      const { error } = await supabase
        .from('packing_items')
        .update({ packed: !item.packed })
        .eq('id', item.id)
      if (error) throw error
    },
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: ['packing_items', tripId] })
      const previous = queryClient.getQueryData<PackingItem[]>(['packing_items', tripId])
      queryClient.setQueryData<PackingItem[]>(['packing_items', tripId], (old) =>
        (old ?? []).map((i) => (i.id === item.id ? { ...i, packed: !i.packed } : i))
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['packing_items', tripId], ctx.previous)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['packing_items', tripId] }),
  })
}

export function useDeletePackingItem(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('packing_items').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}
