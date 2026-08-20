import * as React from 'react'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { watchForUpdate } from '@/lib/appUpdate'

/**
 * "A new version is ready" — the missing half of an `autoUpdate` service worker.
 *
 * Mounted once at the app root beside OfflineBanner and InstallNudge, because
 * like them it is about the app itself rather than any route.
 *
 * Deliberately a toast with an action rather than a forced reload. A silent
 * `location.reload()` the moment a deploy lands would be the technically
 * simplest fix and a hostile one: it can discard a half-typed message, a
 * partly-filled itinerary form, or an open dialog, and it would fire during
 * exactly the working sessions where an update is most likely. The new build
 * is already being served for anything loaded from here on, so the only thing
 * a reload buys is the *running* code — worth offering, never worth stealing
 * someone's typing for.
 *
 * `duration: Infinity` because this is not news that expires. A toast that
 * vanishes after four seconds is a toast nobody on a phone will ever catch.
 */
export function UpdateNudge() {
  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    return watchForUpdate(navigator.serviceWorker, () => {
      toast('Wander just updated', {
        description: 'Reload to pick up the newest version.',
        duration: Infinity,
        action: {
          label: 'Reload',
          onClick: () => window.location.reload(),
        },
        icon: <RefreshCw className="size-4" aria-hidden />,
      })
    })
  }, [])

  return null
}
