import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Transport, TransportMode } from '@/types'

/** The trip's transport hops, ordered by departure (time-TBD hops sort last, by
 *  creation). Keyed `['transport', tripId]` so realtime and every consumer (the
 *  Transport card, the calendar day surface) share one fetch. */
export function useTransport(tripId: string) {
  return useQuery({
    queryKey: ['transport', tripId],
    queryFn: async (): Promise<Transport[]> => {
      const { data, error } = await supabase
        .from('transport')
        .select('*')
        .eq('trip_id', tripId)
        // nullsFirst: false → a hop with no departure time sinks below the dated
        // ones rather than floating to the top of the list.
        .order('depart_at', { nullsFirst: false })
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['transport', tripId] })
}

export interface TransportInput {
  mode: TransportMode
  depart_place?: string | null
  arrive_place?: string | null
  depart_at?: string | null
  arrive_at?: string | null
  confirmation_code?: string | null
  booking_url?: string | null
}

/** A short "Paris → Amsterdam" / "Train" label for the activity log. */
function routeLabel(input: TransportInput): string {
  const ends = [input.depart_place?.trim(), input.arrive_place?.trim()].filter(Boolean)
  if (ends.length === 2) return `${ends[0]} → ${ends[1]}`
  if (ends.length === 1) return ends[0] as string
  return input.mode
}

export function useCreateTransport(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: TransportInput) => {
      const { error } = await supabase.from('transport').insert({
        trip_id: tripId,
        // Self-attributed: the insert policy pins member_id to my_member_id, so a
        // forged author is rejected by RLS, not merely hidden by the UI.
        member_id: memberId,
        mode: input.mode,
        depart_place: input.depart_place ?? null,
        arrive_place: input.arrive_place ?? null,
        depart_at: input.depart_at || null,
        arrive_at: input.arrive_at || null,
        confirmation_code: input.confirmation_code ?? null,
        booking_url: input.booking_url ?? null,
      })
      if (error) throw error
      logActivity(tripId, memberId, 'added transport', routeLabel(input))
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not add that hop')),
  })
}

type TransportUpdate = Partial<Transport> & { id: string }

export function useUpdateTransport(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: TransportUpdate) => {
      const { error } = await supabase.from('transport').update(patch).eq('id', id)
      if (error) throw error
      logActivity(tripId, memberId, 'updated transport', routeLabel(patch as TransportInput))
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that hop')),
  })
}

export function useDeleteTransport(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (hop: Transport) => {
      const { error } = await supabase.from('transport').delete().eq('id', hop.id)
      if (error) throw error
      logActivity(tripId, memberId, 'removed transport', routeLabel(hop as TransportInput))
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not remove that hop')),
  })
}
