import { supabase } from './supabase'
import type { NotificationType } from '@/types'

interface NotifyParams {
  tripId: string
  /** The member causing the event (the current member) — never notified. */
  actorId: string
  /** Members to notify; blanks, duplicates and the actor are filtered out. */
  recipientIds: Array<string | null | undefined>
  type: NotificationType
  /** The row the notification points at, for deep-linking. */
  entityId?: string | null
  /** Snapshot of the subject (task / poll / expense title) for the inbox. */
  title?: string | null
}

/**
 * Address a personal notification to one or more members (the inbox, #182).
 *
 * Fire-and-forget by design — it mirrors `logActivity`: the inbox is
 * nice-to-have signal and must never block or fail the primary mutation that
 * triggered it. RLS attributes the row to the caller; this helper only decides
 * *who* to notify.
 *
 * Self-notify is impossible by construction: the actor is filtered out of the
 * recipient set here (a guard behind the RLS one), and duplicate/blank ids are
 * collapsed so a member never receives the same event twice.
 */
export function notify({
  tripId,
  actorId,
  recipientIds,
  type,
  entityId = null,
  title = null,
}: NotifyParams): void {
  const recipients = [
    ...new Set(recipientIds.filter((id): id is string => !!id && id !== actorId)),
  ]
  if (recipients.length === 0) return

  void supabase
    .from('notifications')
    .insert(
      recipients.map((recipient_id) => ({
        trip_id: tripId,
        recipient_id,
        actor_id: actorId,
        type,
        entity_id: entityId,
        title,
      }))
    )
    .then(({ error }) => {
      if (error) console.warn('notify failed:', error.message)
    })
}
