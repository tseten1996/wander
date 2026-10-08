/*
  The bridge from "an inbox row was written" to "put it in their inbox too"
  (epic #181, the email channel). A deliberate twin of pushSend.ts: notify.ts
  calls this right after inserting the notification rows, handing over their
  ids, and /api/email asks the database to queue an email for each recipient
  who opted in.

  Best-effort by contract, for the same reason push is: the inbox write has
  already happened and returned, so a failure here is invisible and must never
  surface. Skipped entirely when the deployment has not configured email, so an
  unconfigured build issues no extra request and behaves exactly as it did
  before this feature existed.

  THIS SENDS NOTHING. It only asks the server to queue. The distinction matters:
  the endpoint it calls holds no secret, cannot read an address, and returns a
  count — so the worst a hostile caller achieves here is a different number.
  Actual delivery is a scheduled drain the browser cannot reach.
*/
import { supabase } from '@/lib/supabase'
import { EMAIL_ENABLED } from '@/lib/config'

export function queueEmailForNotifications(ids: string[]): void {
  if (ids.length === 0 || !EMAIL_ENABLED) return
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) return
      await fetch('/api/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids }),
        // Survive the tab closing right after the mutation that triggered it.
        keepalive: true,
      })
    } catch {
      // Offline, no endpoint deployed, or an edge error — all fine, all silent.
      // The notification still stands in the in-app inbox, which is the
      // channel that never depends on anything being configured.
    }
  })()
}
