import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useTripRealtime } from '@/hooks/useRealtime'
import { useTripPresence } from '@/hooks/usePresence'
import type { Member, Trip } from '@/types'

interface TripContextValue {
  trip: Trip
  members: Member[]
  membersById: Map<string, Member>
  /** The signed-in person's member row in this trip. */
  me: Member
  isOwner: boolean
  /** Member ids of everyone who currently has this trip open (live presence). */
  activeIds: Set<string>
}

const TripContext = React.createContext<TripContextValue | null>(null)

export function useTripContext(): TripContextValue {
  const ctx = React.useContext(TripContext)
  if (!ctx) throw new Error('useTripContext must be used inside a trip route')
  return ctx
}

/** Data loader used by TripLayout; renders children only once everything exists. */
export function TripProvider({
  tripId,
  children,
  fallback,
  denied,
}: {
  tripId: string
  children: React.ReactNode
  fallback: React.ReactNode
  denied: React.ReactNode
}) {
  const { session } = useAuth()
  useTripRealtime(tripId)

  const tripQuery = useQuery({
    queryKey: ['trip', tripId],
    queryFn: async (): Promise<Trip | null> => {
      const { data, error } = await supabase
        .from('trips')
        .select('*')
        .eq('id', tripId)
        .maybeSingle()
      if (error) throw error
      return data
    },
    enabled: !!session,
  })

  const membersQuery = useQuery({
    queryKey: ['members', tripId],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await supabase
        .from('members')
        .select('*')
        .eq('trip_id', tripId)
        .order('joined_at')
      if (error) throw error
      return data
    },
    enabled: !!session,
  })

  const trip = tripQuery.data
  const members = membersQuery.data
  const me = members?.find((m) => m.user_id === session?.user.id)

  // One presence channel per open trip, subscribed here so every consumer of
  // the trip context shares it. Subscribing per-component instead would open a
  // second channel on the same topic — supabase-js reuses the channel by topic
  // and then throws "cannot add `presence` callbacks … after `subscribe()`".
  const activeIds = useTripPresence(trip?.id, me?.id)

  const value = React.useMemo<TripContextValue | null>(() => {
    if (!trip || !members || !me) return null
    return {
      trip,
      members,
      membersById: new Map(members.map((m) => [m.id, m])),
      me,
      isOwner: me.role === 'owner',
      activeIds,
    }
  }, [trip, members, me, activeIds])

  if (tripQuery.isLoading || membersQuery.isLoading) return <>{fallback}</>
  // RLS returns no row when you're not a member — same as not-found.
  if (!value) return <>{denied}</>

  return <TripContext.Provider value={value}>{children}</TripContext.Provider>
}
