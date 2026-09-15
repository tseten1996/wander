import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Stay } from '@/types'

/** The trip's stays, ordered by check-in (dateless stays sort last, by creation).
 *  Keyed `['stays', tripId]` so realtime and every consumer (the Stays card, the
 *  calendar day surface) share one fetch. */
export function useStays(tripId: string) {
  return useQuery({
    queryKey: ['stays', tripId],
    queryFn: async (): Promise<Stay[]> => {
      const { data, error } = await supabase
        .from('stays')
        .select('*')
        .eq('trip_id', tripId)
        // nullsFirst: false → a stay with no check-in date sinks below the dated
        // ones rather than floating to the top of the list.
        .order('check_in', { nullsFirst: false })
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['stays', tripId] })
}

export interface StayInput {
  name: string
  address?: string | null
  latitude?: number | null
  longitude?: number | null
  check_in?: string | null
  check_out?: string | null
  confirmation_code?: string | null
  booking_url?: string | null
}

export function useCreateStay(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: StayInput) => {
      const { error } = await supabase.from('stays').insert({
        trip_id: tripId,
        // Self-attributed: the insert policy pins member_id to my_member_id, so a
        // forged author is rejected by RLS, not merely hidden by the UI.
        member_id: memberId,
        name: input.name,
        address: input.address ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        check_in: input.check_in || null,
        check_out: input.check_out || null,
        confirmation_code: input.confirmation_code ?? null,
        booking_url: input.booking_url ?? null,
      })
      if (error) throw error
      logActivity(tripId, memberId, 'added a stay', input.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not add that stay')),
  })
}

type StayUpdate = Partial<Stay> & { id: string }

export function useUpdateStay(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: StayUpdate) => {
      const { error } = await supabase.from('stays').update(patch).eq('id', id)
      if (error) throw error
      if (patch.name) logActivity(tripId, memberId, 'updated a stay', patch.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that stay')),
  })
}

export function useDeleteStay(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (stay: Stay) => {
      const { error } = await supabase.from('stays').delete().eq('id', stay.id)
      if (error) throw error
      logActivity(tripId, memberId, 'removed a stay', stay.name)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not remove that stay')),
  })
}
