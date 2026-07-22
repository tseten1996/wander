import * as React from 'react'
import { useQueries } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/*
  Per-feature "new since last visit" nav dots (#43).

  Each content feature gets a tiny probe query for its latest created_at.
  The query keys start with [table, tripId] — the same prefix
  useTripRealtime invalidates on any change to that table — so the probes
  refresh live without new socket code.

  "Last seen" is device-local (localStorage, keyed by trip + member): the
  dot means "new since *you* last looked *here*", which isn't server state.
*/

export const UNREAD_FEATURES = [
  { route: 'itinerary', table: 'itinerary_items' },
  { route: 'chat', table: 'messages' },
  { route: 'polls', table: 'polls' },
  { route: 'checklist', table: 'checklist_items' },
  { route: 'budget', table: 'budget_entries' },
  { route: 'packing', table: 'packing_items' },
  { route: 'questions', table: 'questions' },
  { route: 'notes', table: 'notes' },
  { route: 'ideas', table: 'inspiration_items' },
] as const

export type UnreadRoute = (typeof UNREAD_FEATURES)[number]['route']

const isUnreadRoute = (r: string): r is UnreadRoute =>
  UNREAD_FEATURES.some((f) => f.route === r)

const storageKey = (tripId: string, memberId: string) =>
  `wander_seen_${tripId}_${memberId}`

function initialSeen(tripId: string, memberId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey(tripId, memberId))
    if (raw) return JSON.parse(raw) as Record<string, string>
  } catch {
    // Broken/blocked storage → behave as a fresh device
  }
  // First open on this device: everything counts as seen-now, so a brand-new
  // member isn't greeted by a dot on every tab.
  const now = new Date().toISOString()
  const seeded = Object.fromEntries(UNREAD_FEATURES.map((f) => [f.route, now]))
  try {
    localStorage.setItem(storageKey(tripId, memberId), JSON.stringify(seeded))
  } catch {
    /* ignore */
  }
  return seeded
}

/**
 * Returns which feature routes have content newer than this member's last
 * visit on this device. `activeRoute` (the trip-relative path segment) is
 * continuously marked seen, so the page being looked at never shows a dot.
 */
export function useUnreadDots(
  tripId: string,
  memberId: string,
  activeRoute: string
): Record<UnreadRoute, boolean> {
  const [seen, setSeen] = React.useState(() => initialSeen(tripId, memberId))
  React.useEffect(() => {
    setSeen(initialSeen(tripId, memberId))
  }, [tripId, memberId])

  const latest = useQueries({
    queries: UNREAD_FEATURES.map((f) => ({
      queryKey: [f.table, tripId, 'latest'],
      queryFn: async (): Promise<string | null> => {
        const { data, error } = await supabase
          .from(f.table)
          .select('created_at')
          .eq('trip_id', tripId)
          .order('created_at', { ascending: false })
          .limit(1)
        if (error) throw error
        return data[0]?.created_at ?? null
      },
      staleTime: 60_000,
    })),
  })

  // Joined stamp of all probe results — the mark-seen effect below must also
  // rerun when new content lands while the member is already on that page.
  const latestStamp = latest.map((q) => q.data ?? '').join('|')

  React.useEffect(() => {
    if (!isUnreadRoute(activeRoute)) return
    // Acknowledge everything currently on the page, not just "now" — server
    // timestamps can be ahead of the device clock, and a dot that survives
    // an actual visit would be worse than no dot at all.
    const idx = UNREAD_FEATURES.findIndex((f) => f.route === activeRoute)
    const newest = latest[idx]?.data
    const stamp = new Date(
      Math.max(Date.now(), newest ? new Date(newest).getTime() : 0)
    ).toISOString()
    setSeen((prev) => {
      const next = { ...prev, [activeRoute]: stamp }
      try {
        localStorage.setItem(storageKey(tripId, memberId), JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
    // `latest` is intentionally represented by latestStamp — the array's
    // identity changes every render, its data only when a probe refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute, latestStamp, tripId, memberId])

  return React.useMemo(() => {
    const unread = {} as Record<UnreadRoute, boolean>
    UNREAD_FEATURES.forEach((f, i) => {
      const newest = latest[i].data
      const last = seen[f.route]
      unread[f.route] =
        !!newest && !!last && new Date(newest).getTime() > new Date(last).getTime()
    })
    return unread
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestStamp, seen])
}
