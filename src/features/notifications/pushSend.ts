/*
  The bridge from "an inbox row was written" to "deliver it while the app is
  closed" (#309, epic #181). notify.ts calls this right after it inserts the
  notification rows, handing over their ids; the /api/push Pages Function signs
  and sends a Web Push to each recipient's subscribed devices.

  Best-effort by contract: the inbox write has already happened and returned, so
  a failure here is invisible and must never surface. Skipped entirely when no
  VAPID public key is configured, so an unconfigured build issues no extra
  request — its behaviour is identical to before this feature existed. The gate
  is the *deployment's* configuration, not this browser's push support: the send
  is for the recipients' devices, not the actor's, so it runs even from a device
  that cannot itself receive push.
*/
import { supabase } from '@/lib/supabase'
import { VAPID_PUBLIC_KEY } from '@/lib/config'

/** True only when this deployment has a VAPID public key — the send is dark otherwise. */
function pushConfigured(): boolean {
  return !!VAPID_PUBLIC_KEY
}

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
