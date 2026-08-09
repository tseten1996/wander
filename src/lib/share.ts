import type { Trip } from '@/types'

/**
 * The read-only public share URL for a trip (#127). Built from the live
 * location so it stays correct under HashRouter + the relative `base: './'`
 * (no absolute-URL assumptions) — exactly like the invite link — and works
 * wherever the SPA is actually served from.
 *
 * The token is the only capability, so the URL is shown/copied only when the
 * owner has explicitly enabled sharing (share_token is non-null).
 */
export function publicShareUrl(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/p/${token}`
}

/** Convenience: the URL for a trip, or null when it is not publicly shared. */
export function tripShareUrl(trip: Pick<Trip, 'share_token'>): string | null {
  return trip.share_token ? publicShareUrl(trip.share_token) : null
}
