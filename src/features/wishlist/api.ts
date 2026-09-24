import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { WishlistCategory, WishlistItem } from '@/types'

/** The trip's wishlist — saved-but-unscheduled places, ordered by `position`
 *  (seeded on insert so newer saves sink to the bottom of the shelf). Keyed
 *  `['wishlist_items', tripId]` so realtime and every consumer share one fetch. */
export function useWishlist(tripId: string) {
  return useQuery({
    queryKey: ['wishlist_items', tripId],
    queryFn: async (): Promise<WishlistItem[]> => {
      const { data, error } = await supabase
        .from('wishlist_items')
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
  return () => queryClient.invalidateQueries({ queryKey: ['wishlist_items', tripId] })
}

export interface WishlistInput {
  name: string
  category?: WishlistCategory | null
  latitude?: number | null
  longitude?: number | null
  note?: string | null
  url?: string | null
}

export function useCreateWishlistItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: WishlistInput) => {
      const { error } = await supabase.from('wishlist_items').insert({
        trip_id: tripId,
        // Self-attributed: the insert policy pins added_by to my_member_id, so a
        // forged author is rejected by RLS, not merely hidden by the UI.
        added_by: memberId,
        name: input.name,
        category: input.category ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        note: input.note ?? null,
        url: input.url ?? null,
        // Monotonic seed (matching the itinerary's `Date.now()` scheme) so a new
        // save sorts after the existing shelf without reading the current max.
        position: Date.now(),
      })
      if (error) throw error
      logActivity(tripId, memberId, 'saved a place to the wishlist', input.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that place')),
  })
}

type WishlistUpdate = Partial<WishlistItem> & { id: string }

export function useUpdateWishlistItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: WishlistUpdate) => {
      const { error } = await supabase.from('wishlist_items').update(patch).eq('id', id)
      if (error) throw error
      if (patch.name) logActivity(tripId, memberId, 'updated a wishlist place', patch.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that place')),
  })
}

export function useDeleteWishlistItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (item: WishlistItem) => {
      const { error } = await supabase.from('wishlist_items').delete().eq('id', item.id)
      if (error) throw error
      logActivity(tripId, memberId, 'removed a wishlist place', item.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not remove that place')),
  })
}
