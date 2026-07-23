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
}

export interface CreatedTrip {
  trip: Trip
  /** The owner's member row, auto-created by the `on_trip_created` trigger. */
  member: Member
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
