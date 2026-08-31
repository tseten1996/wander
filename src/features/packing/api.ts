import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import {
  PACKING_TOGGLE_MUTATION_KEY,
  type TogglePackedVars,
} from '@/lib/offlineSync'
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
    onError: (err) => toast.error(friendlyError(err, 'Could not add that item')),
  })
}

/** Rollback context: the packing rows as they were before the optimistic flip. */
interface TogglePackedContext {
  previous?: PackingItem[]
}

/**
 * Register the packing-toggle mutation as offline-replayable (#283). Called once
 * at startup (src/main.tsx) **before** the persisted cache hydrates, so a toggle
 * that was queued offline in a previous session — restored paused from disk —
 * has a `mutationFn`, optimistic apply, and rollback to resume with even though
 * no PackingPage is mounted. The whole write lives here so this api.ts stays the
 * only module that touches `packing_items` in Supabase.
 */
export function registerPackingMutationDefaults(queryClient: QueryClient): void {
  queryClient.setMutationDefaults(PACKING_TOGGLE_MUTATION_KEY, {
    // 'online' (not the app-wide 'always') so this write PAUSES offline and is
    // queued, persisted, and resumed on reconnect instead of erroring.
    networkMode: 'online',
    mutationFn: async ({ id, packed }: TogglePackedVars) => {
      const { error } = await supabase.from('packing_items').update({ packed }).eq('id', id)
      if (error) throw error
    },
    onMutate: async ({ tripId, id, packed }: TogglePackedVars): Promise<TogglePackedContext> => {
      await queryClient.cancelQueries({ queryKey: ['packing_items', tripId] })
      const previous = queryClient.getQueryData<PackingItem[]>(['packing_items', tripId])
      // Absolute target, not a flip: re-running onMutate on resume (or a double
      // queue) is idempotent and converges even if the row changed meanwhile.
      queryClient.setQueryData<PackingItem[]>(['packing_items', tripId], (old) =>
        (old ?? []).map((i) => (i.id === id ? { ...i, packed } : i))
      )
      return { previous }
    },
    onError: (err, { tripId }: TogglePackedVars, ctx) => {
      const context = ctx as TogglePackedContext | undefined
      if (context?.previous) queryClient.setQueryData(['packing_items', tripId], context.previous)
      toast.error(friendlyError(err, 'Could not update that item'))
    },
    onSettled: (_data, _err, { tripId }: TogglePackedVars) =>
      queryClient.invalidateQueries({ queryKey: ['packing_items', tripId] }),
  })
}

/**
 * Toggle a packing item's `packed` flag. The behaviour lives entirely in the
 * defaults registered above (so a resumed offline write and a live tap share one
 * code path); the hook just binds the key. Pass the **target** value, not the
 * item, so the queued write is idempotent on replay.
 */
export function useTogglePacked() {
  return useMutation<void, Error, TogglePackedVars, TogglePackedContext>({
    mutationKey: PACKING_TOGGLE_MUTATION_KEY,
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
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that item')),
  })
}
