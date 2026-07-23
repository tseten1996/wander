import * as React from 'react'
import { supabase } from '@/lib/supabase'

interface PresencePayload {
  member_id: string
  online_at: string
}

/**
 * Realtime presence for a trip: tracks which members currently have the trip
 * plan open and returns the set of their member ids. Uses a dedicated Supabase
 * presence channel keyed by member id, so several tabs/devices for the same
 * person collapse to a single entry. The set updates live as members join and
 * leave (tab close, navigate away, or network drop all fire a `leave`).
 */
export function useTripPresence(
  tripId: string | undefined,
  memberId: string | undefined,
): Set<string> {
  const [activeIds, setActiveIds] = React.useState<Set<string>>(() => new Set())

  React.useEffect(() => {
    if (!tripId || !memberId) return

    const channel = supabase.channel(`presence:trip:${tripId}`, {
      config: { presence: { key: memberId } },
    })

    const sync = () => {
      const state = channel.presenceState<PresencePayload>()
      setActiveIds(new Set(Object.keys(state)))
    }

    channel
      .on('presence', { event: 'sync' }, sync)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void channel.track({
            member_id: memberId,
            online_at: new Date().toISOString(),
          })
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [tripId, memberId])

  return activeIds
}
