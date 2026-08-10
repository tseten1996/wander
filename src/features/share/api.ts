import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { PublicItinerary } from '@/types'

/**
 * Reads a trip's public, read-only itinerary by share token (#127). The only
 * data path for the public page: a single token-validating SECURITY DEFINER
 * RPC (`get_public_itinerary`) that returns a whitelisted projection, or SQL
 * null for an invalid / revoked / absent token — which surfaces here as `null`
 * (the "link unavailable" state), distinct from a thrown error (a real network
 * failure, which the page offers to retry).
 *
 * No session is required: an outsider with no Wander account calls this with
 * the public anon key. The query is intentionally NOT keyed by `[table,
 * tripId]` — there is no trip context here, only a token.
 */
export function usePublicItinerary(token: string | undefined) {
  return useQuery({
    queryKey: ['public_itinerary', token],
    enabled: !!token,
    // A missing trip is `data: null`, not an error — so a genuine thrown error
    // is always a transient failure worth retrying, never a dead link.
    retry: 1,
    queryFn: async (): Promise<PublicItinerary | null> => {
      const { data, error } = await supabase.rpc('get_public_itinerary', {
        p_token: token,
      })
      if (error) throw error
      return (data as PublicItinerary | null) ?? null
    },
  })
}
