import * as React from 'react'

/**
 * Add-to-home-screen plumbing for the post-join install nudge (issue #99, first
 * slice of the identity-persistence epic #97). An installed PWA is the one
 * accountless, guardrail-respecting mitigation for iOS Safari evicting a
 * friend's anonymous session after ~7 days — so we want to offer the install at
 * the moment they've just committed to a trip.
 *
 * Two platforms, two mechanisms:
 *   - Chromium fires a one-off `beforeinstallprompt` we can defer and trigger
 *     ourselves. It fires early — possibly before React mounts — so we capture
 *     it at module load into a singleton and notify subscribers, letting a
 *     component that mounts later still see it.
 *   - iOS Safari has no such event; there the UI must show the manual
 *     "Share → Add to Home Screen" instruction instead.
 *
 * Nothing here renders or persists anything; it only exposes capability +
 * a trigger. Deliberately dependency-free.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const subscribers = new Set<() => void>()

function notify() {
  subscribers.forEach((fn) => fn())
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stop Chrome's default mini-infobar; the nudge triggers the prompt itself.
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    notify()
  })
  // Once installed, drop the captured prompt so the nudge can't reappear.
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

/** True when the app is running as an installed / standalone PWA (either the
 *  standard display-mode or iOS Safari's legacy `navigator.standalone`). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const displayModeStandalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return displayModeStandalone || iosStandalone
}

/** True on iOS/iPadOS Safari, where there is no `beforeinstallprompt` and the
 *  user must add to the home screen manually via the Share sheet. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOSDevice = /iPad|iPhone|iPod/.test(ua)
  // iPadOS 13+ reports a desktop-Mac UA; the touch points give it away.
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  return iOSDevice || iPadOS
}

export interface InstallPrompt {
  /** A deferred Chromium install prompt is available to trigger. */
  canPrompt: boolean
  /** Trigger the native install prompt; resolves with the user's choice, or
   *  `'unavailable'` when there is no deferred prompt (e.g. iOS). */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>
}

export function useInstallPrompt(): InstallPrompt {
  // A stable dispatch that re-renders on capture/consume of the deferred prompt.
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    subscribers.add(forceRender)
    return () => {
      subscribers.delete(forceRender)
    }
  }, [])

  const promptInstall = React.useCallback(async () => {
    if (!deferredPrompt) return 'unavailable' as const
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    // A prompt is single-use; drop it whatever the choice was.
    deferredPrompt = null
    notify()
    return outcome
  }, [])

  return { canPrompt: deferredPrompt !== null, promptInstall }
}
