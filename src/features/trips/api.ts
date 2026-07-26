import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Member, Trip } from '@/types'

export type TripWithMembers = Trip & { members: Member[] }

export function useTrips(enabled: boolean) {
  return useQuery({
    queryKey: ['trips'],
    enabled,
    queryFn: async (): Promise<TripWithMembers[]> => {
      const { data, error } = await supabase
        .from('trips')
        .select('*, members(*)')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as TripWithMembers[]
    },
  })
}

export interface CreateTripInput {
  name: string
  destination?: string
  cover_url?: string | null
  start_date?: string | null
  end_date?: string | null
  estimated_budget?: number | null
  /** ISO 4217 code chosen at creation. Omit to keep the DB `USD` default. */
  currency?: string
}

export interface CreatedTrip {
  trip: Trip
  /** The owner's member row, auto-created by the `on_trip_created` trigger. */
  member: Member
}

export interface TripMoneyInput {
  /** ISO 4217 code; stored upper-cased. Validate with `isSupportedCurrency` first. */
  currency: string
  estimated_budget: number | null
}

/**
 * Updates a trip's money fields (default currency + total budget). Lives here,
 * in the trips feature's api.ts, so the Budget page can edit the `trips` row
 * without reaching into Supabase itself (each feature's api.ts is the only
 * place that touches Supabase for that feature). Owner-only in practice — the
 * `trips` RLS update policy (`is_trip_owner`) is the real gate; the UI hides
 * the control as UX. Invalidates `['trip', tripId]` so every screen that reads
 * `formatMoney(..., trip.currency)` reflects the change immediately.
 */
export function useUpdateTripMoney(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TripMoneyInput): Promise<void> => {
      const { error } = await supabase
        .from('trips')
        .update({
          currency: input.currency.trim().toUpperCase(),
          estimated_budget: input.estimated_budget,
        })
        .eq('id', tripId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trip', tripId] }),
  })
}

export function useCreateTrip() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateTripInput): Promise<CreatedTrip> => {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) throw new Error('Not signed in')
      const { data: trip, error } = await supabase
        .from('trips')
        .insert({
          name: input.name,
          destination: input.destination || null,
          cover_url: input.cover_url || null,
          start_date: input.start_date || null,
          end_date: input.end_date || null,
          estimated_budget: input.estimated_budget ?? null,
          // Only send a currency when one was chosen, so the column's `USD`
          // default still applies to any path that doesn't set it.
          ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
          owner_id: userData.user.id,
        })
        .select()
        .single()
      if (error) throw error
      const { data: member, error: memberError } = await supabase
        .from('members')
        .select('*')
        .eq('trip_id', trip.id)
        .eq('user_id', userData.user.id)
        .single()
      if (memberError) throw memberError
      return { trip, member }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trips'] }),
  })
}
