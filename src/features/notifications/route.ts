/*
  Where each notification type points — the one source of truth shared by three
  callers that must never drift apart:

    * the in-app inbox row (NotificationBell), which deep-links with react-router
    * the Web Push send path (functions/api/push.ts), which bakes the same link
      into the push payload so a tap lands on the same place
    * the boot-time reader that marks a push-opened notification read

  Deliberately dependency-free (no React, no `import.meta`, no browser globals)
  so the Cloudflare Pages Function can import it unchanged, exactly like it
  imports supabase-public.ts.
*/
import type { NotificationType } from '@/types'

/** The trip tab each event type deep-links to. */
export const NOTIFICATION_TAB: Record<NotificationType, string> = {
  checklist_assigned: 'checklist',
  poll_opened: 'polls',
  expense_owed: 'budget',
  mention: 'chat',
}

/**
 * The app-relative deep link for a notification, as a HashRouter location.
 *
 * `n` (the notification id) rides along as a query param so the page that opens
 * from a push can mark that exact inbox row read — keeping the closed-app and
 * in-app paths consistent (acceptance criterion: "marks the matching inbox row
 * consistently"). Returned as a `#/…` hash so it resolves against the app's
 * origin under any static-host subpath, matching the `base: './'` + HashRouter
 * contract.
 */
export function notificationDeepLink(
  tripId: string,
  type: NotificationType,
  notificationId?: string | null,
): string {
  const tab = NOTIFICATION_TAB[type] ?? 'checklist'
  const q = notificationId ? `?n=${encodeURIComponent(notificationId)}` : ''
  return `#/trip/${tripId}/${tab}${q}`
}

/** Query-param key carrying the id of the notification a push opened. */
export const NOTIFICATION_PARAM = 'n'
