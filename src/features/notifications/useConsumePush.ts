import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { NOTIFICATION_PARAM } from './route'
import { useMarkNotificationRead } from './api'

/**
 * When the app is opened from a Web Push (`#/trip/…?n=<id>`), mark that exact
 * inbox row read and strip the param — keeping the closed-app tap and the
 * in-app tap consistent (#309 acceptance criterion: "marks the matching inbox
 * row consistently"). Idempotent: the mark-read mutation no-ops on an
 * already-read row (`.is('read_at', null)`), and the param is cleared so a
 * refresh does not repeat it.
 *
 * Reuses the foundation's own `useMarkNotificationRead` (#267) — the same
 * mutation the in-app bell uses — so there is exactly one write path.
 */
export function useConsumePushNotification(tripId: string): void {
  const [params, setParams] = useSearchParams()
  const markRead = useMarkNotificationRead(tripId)
  const consumed = React.useRef<string | null>(null)

  const id = params.get(NOTIFICATION_PARAM)

  React.useEffect(() => {
    if (!id || consumed.current === id) return
    consumed.current = id
    markRead.mutate(id)
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete(NOTIFICATION_PARAM)
        return next
      },
      { replace: true },
    )
  }, [id, markRead, setParams])
}
