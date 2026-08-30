/*
  The bridge from "an inbox row was written" to "deliver it while the app is
  closed" (#267). notify.ts calls this right after it inserts the notification
  rows, handing over their ids; the /api/push Pages Function signs and sends a
  Web Push to each recipient's subscribed devices.

  Best-effort by contract: the inbox write has already happened and returned, so
  a failure here is invisible and must never surface. Skipped entirely when no
  VAPID key is configured, so an unconfigured build issues no extra request —
  its behaviour is identical to before this feature existed.
*/
import { supabase } from '@/lib/supabase'
import { pushConfigured } from './push'

export function sendPushForNotifications(ids: string[]): void {
  if (ids.length === 0 || !pushConfigured()) return
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) return
      await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids }),
        // Survive the tab closing right after the mutation that triggered it.
        keepalive: true,
      })
    } catch {
      // Offline, no endpoint deployed, or an edge error — all fine, all silent.
    }
  })()
}
