import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { NOTIFICATION_PARAM } from './route'
import { useMarkNotificationRead } from './api'
import {
  disablePush,
  enablePush,
  isSubscribedHere,
  pushAvailable,
} from './push'

export type PushStatus = 'loading' | 'unavailable' | 'default' | 'denied' | 'subscribed'

interface UsePush {
  status: PushStatus
  busy: boolean
  enable: () => Promise<void>
  disable: () => Promise<void>
}

/**
 * Opt-in state for closed-app Web Push (#267), scoped to this member on this
 * device. `status` drives the control in the notifications surface:
 *   unavailable — no VAPID key or an unsupported browser: render nothing
 *   denied      — the browser blocked notifications: show a settings hint
 *   default     — offer to turn it on
 *   subscribed  — this device is registered; offer to turn it off
 */
export function usePush(tripId: string, memberId: string): UsePush {
  const available = pushAvailable()
  const [status, setStatus] = React.useState<PushStatus>(available ? 'loading' : 'unavailable')
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    if (!available) {
      setStatus('unavailable')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    const here = await isSubscribedHere(tripId, memberId).catch(() => false)
    setStatus(here && Notification.permission === 'granted' ? 'subscribed' : 'default')
  }, [available, tripId, memberId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const enable = React.useCallback(async () => {
    setBusy(true)
    try {
      const result = await enablePush(tripId, memberId)
      if (result === 'unsupported') {
        setStatus('unavailable')
      } else if (result === 'denied') {
        setStatus('denied')
        toast.error('Notifications are blocked — turn them on in your browser settings.')
      } else {
        setStatus('subscribed')
        toast.success('You’ll be notified when your group needs you, even with Wander closed.')
      }
    } catch (err) {
      toast.error(friendlyError(err, 'Could not turn on notifications'))
    } finally {
      setBusy(false)
    }
  }, [tripId, memberId])

  const disable = React.useCallback(async () => {
    setBusy(true)
    try {
      await disablePush(tripId, memberId)
      setStatus('default')
    } catch (err) {
      toast.error(friendlyError(err, 'Could not turn off notifications'))
    } finally {
      setBusy(false)
    }
  }, [tripId, memberId])

  return { status, busy, enable, disable }
}

/**
 * When the app is opened from a push (`#/trip/…?n=<id>`), mark that exact inbox
 * row read and strip the param — keeping the closed-app tap and the in-app tap
 * consistent. Idempotent: the mark-read mutation no-ops on an already-read row,
 * and the param is cleared so a refresh does not repeat it.
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
