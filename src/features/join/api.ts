import { supabase } from '@/lib/supabase'
import type { InvitePreview } from '@/types'

/**
 * The join feature's single Supabase boundary (the Wander convention: a
 * feature's `api.ts` is the only file that touches Supabase for it). Both
 * calls go through the two SECURITY DEFINER RPCs that guard the join flow —
 * `get_invite_preview` for presentational context and `join_trip` for the one
 * and only join path. No second join path, no direct table access: the invite
 * code stays a server-validated capability.
 *
 * Deliberately thin, inline wrappers — JoinPage keeps ownership of the
 * parallel-paint / single-fire dedup shape (#215), and the main bundle sits
 * against the gzip ceiling, so the indirection stays as light as possible.
 */

/**
 * Whitelisted invite-context projection for a code, or `null` when the invite
 * isn't real (no row) — never throws for a dead link, matching the RPC, which
 * returns an empty set rather than an error. A genuine network failure still
 * rejects, so the caller can tell "no such invite" from "couldn't reach it".
 */
export async function getInvitePreview(code: string): Promise<InvitePreview | null> {
  const { data } = await supabase.rpc('get_invite_preview', { p_invite_code: code })
  return (data?.[0] as InvitePreview) ?? null
}

/**
 * The single join path, returning the raw `{ data, error }` response so the
 * caller reads `data` as the joined trip id. Omitting `color` (with a blank
 * `displayName`) is the idempotent probe: an already-member device joins
 * straight through, an unknown one comes back `NAME_REQUIRED`, a dead link
 * `INVALID_INVITE`. `color` is undefined for the probe and JSON.stringify
 * drops the key, so its wire body matches the original probe exactly.
 */
export function joinTrip({
  code,
  displayName,
  color,
}: {
  code: string
  displayName: string
  color?: string
}) {
  return supabase.rpc('join_trip', {
    p_invite_code: code,
    p_display_name: displayName,
    p_color: color,
  })
}
