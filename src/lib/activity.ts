import { supabase } from './supabase'

/**
 * Append to the trip's activity feed. Fire-and-forget: feed entries are
 * nice-to-have and must never block or fail the primary mutation.
 */
export function logActivity(
  tripId: string,
  memberId: string,
  verb: string,
  subject?: string
): void {
  void supabase
    .from('activity')
    .insert({ trip_id: tripId, member_id: memberId, verb, subject: subject ?? null })
    .then(({ error }) => {
      if (error) console.warn('activity log failed:', error.message)
    })
}
