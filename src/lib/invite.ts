import * as React from 'react'
import { toast } from 'sonner'
import type { Trip } from '@/types'

/**
 * The shareable invite URL for a trip. Built from the live location so it stays
 * correct under HashRouter + the relative `base: './'` (no absolute-URL
 * assumptions) — a link that works wherever the SPA is actually served from.
 */
export function inviteUrl(trip: Pick<Trip, 'invite_code'>): string {
  return `${window.location.origin}${window.location.pathname}#/join/${trip.invite_code}`
}

/**
 * Copy-to-clipboard invite behavior shared by Settings and the dashboard, so
 * both surfaces build the same link and reuse the one invite mechanism (no
 * second join path). Returns the `copied` pulse for a check-mark confirmation.
 */
export function useInviteLink(trip: Pick<Trip, 'invite_code'>) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])

  const url = inviteUrl(trip)

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
      toast.success('Invite link copied')
    } catch {
      toast.error('Could not copy the invite link — try again')
    }
  }, [url])

  return { url, copied, copy }
}
