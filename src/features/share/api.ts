import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { PublicItinerary, PublicRecap } from '@/types'

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

/**
 * Reads a trip's public, read-only post-trip recap by share token (#238, epic
 * #205). The same shape as {@link usePublicItinerary}: a single token-validating
 * SECURITY DEFINER RPC (`get_public_recap`) is the only data path, with no
 * session required (an outsider with no Wander account calls it with the public
 * anon key). The RPC returns one of three things, which map here to:
 *   - SQL null → `null`: an invalid / revoked / not-shared token — the "link
 *     unavailable" state, distinct from a thrown error (a real network failure
 *     the page offers to retry).
 *   - `{ status: 'pending' }`: a valid, shared link whose trip has not ended —
 *     the "recap not ready yet" state.
 *   - `{ status: 'ready', … }`: the whitelisted recap.
 * Not keyed by `[table, tripId]` — there is no trip context here, only a token.
 */
export function usePublicRecap(token: string | undefined) {
  return useQuery({
    queryKey: ['public_recap', token],
    enabled: !!token,
    // A missing / not-shared recap is `data: null`, not an error — so a genuine
    // thrown error is always a transient failure worth retrying, never a dead link.
    retry: 1,
    queryFn: async (): Promise<PublicRecap | null> => {
      const { data, error } = await supabase.rpc('get_public_recap', {
        p_token: token,
      })
      if (error) throw error
      return (data as PublicRecap | null) ?? null
    },
  })
}
