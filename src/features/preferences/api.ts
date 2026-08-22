import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { TripPreferences } from '@/types'

/*
  Stated trip preferences (#268, epic #209 slice 4).

  The only place that touches Supabase for the preferences feature. One
  group-owned row per trip, read by every member and fed to the "improve this
  day" AI context as data the group stated — never mined from chat.
*/

/** The editable slice of a preferences row (everything but the audit stamps). */
export interface TripPreferencesInput {
  pace: TripPreferences['pace']
  budget_style: TripPreferences['budget_style']
  interests: string[]
  dietary: string[]
  notes: string | null
}

export function useTripPreferences(tripId: string) {
  return useQuery({
    queryKey: ['trip_preferences', tripId],
    queryFn: async (): Promise<TripPreferences | null> => {
      // maybeSingle: a trip that has never stated preferences simply has no row,
      // which is a valid empty state, not an error.
      const { data, error } = await supabase
        .from('trip_preferences')
        .select('*')
        .eq('trip_id', tripId)
        .maybeSingle()
      if (error) throw error
      return data
    },
  })
}

export function useSaveTripPreferences(tripId: string, memberId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: TripPreferencesInput) => {
      // Upsert on the trip_id primary key: the first save inserts the row, every
      // later one updates it. updated_at is bumped by the DB trigger, so it is
      // deliberately not set here. updated_by is pinned to the caller (the RLS
      // write policy requires it to equal their own member id).
      const { error } = await supabase.from('trip_preferences').upsert(
        {
          trip_id: tripId,
          pace: values.pace,
          budget_style: values.budget_style,
          interests: values.interests,
          dietary: values.dietary,
          notes: values.notes,
          updated_by: memberId,
        },
        { onConflict: 'trip_id' },
      )
      if (error) throw error
      logActivity(tripId, memberId, 'updated how the group likes to travel')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trip_preferences', tripId] }),
    onError: (err) => toast.error(friendlyError(err, 'Could not save those preferences')),
  })
}
