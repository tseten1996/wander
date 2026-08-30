import * as React from 'react'
import { BellOff, BellRing } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { usePush } from './usePush'

/**
 * The "notify me when I'm away" control in the notifications surface (#267).
 *
 * Renders nothing unless closed-app push is actually available — no VAPID key,
 * or a browser without Web Push, and it stays invisible, so declining (or an
 * unconfigured deployment) leaves the inbox exactly as it was. A blocked
 * permission degrades to a settings hint rather than a dead toggle.
 */
export function PushOptIn({ tripId, memberId }: { tripId: string; memberId: string }) {
  const { status, busy, enable, disable } = usePush(tripId, memberId)
  const switchId = React.useId()

  if (status === 'unavailable') return null

  if (status === 'denied') {
    return (
      <div className="flex items-start gap-2.5 border-t border-line px-3 py-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-muted">
          <BellOff className="size-4" aria-hidden />
        </span>
        <p className="text-xs leading-snug text-muted">
          Notifications are blocked for Wander. Turn them on in your browser’s site
          settings to hear about tasks, polls and expenses while it’s closed.
        </p>
      </div>
    )
  }

  const subscribed = status === 'subscribed'

  return (
    <div className="flex items-center gap-2.5 border-t border-line px-3 py-2.5">
      <span
        className={
          subscribed
            ? 'flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-faint text-primary'
            : 'flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-muted'
        }
      >
        <BellRing className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={switchId} className="block cursor-pointer text-sm font-medium text-ink">
          Notify me when I’m away
        </label>
        <p className="text-xs leading-snug text-muted">
          Get a push when you’re waited on, even with Wander closed.
        </p>
      </div>
      <Switch
        id={switchId}
        checked={subscribed}
        disabled={busy || status === 'loading'}
        onCheckedChange={(on) => void (on ? enable() : disable())}
      />
    </div>
  )
}
