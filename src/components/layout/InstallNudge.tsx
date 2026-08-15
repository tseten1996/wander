import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from '@/lib/motion'
import { Share, SquarePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useInstallPrompt, isIOS, isStandalone } from '@/hooks/useInstallPrompt'

/**
 * Post-join "keep your spot" install nudge (issue #99, first slice of the
 * identity-persistence epic #97). Right after a friend commits to a trip, iOS
 * Safari will evict their anonymous session's Local Storage after ~7 days and
 * orphan their contributions; an installed PWA is the one accountless mitigation
 * available on the free-tier static stack. This offers it at that one moment.
 *
 * Rendered once at the app root (a sibling of the router, like OfflineBanner),
 * so it survives the JoinPage → trip-page navigation. It appears only when the
 * join dispatched `JOIN_NUDGE_EVENT` (or the per-session flag is set on reload),
 * the device isn't already a standalone PWA, an install path exists (a captured
 * Chromium prompt, or iOS's manual Share flow), and it hasn't been dismissed on
 * this device before. Silence beats a modal: it's an unobtrusive, skippable
 * bottom card that never blocks entry to the trip.
 */

/** Persistent, per-device: the nudge was dismissed/actioned once, never again. */
export const INSTALL_DISMISSED_KEY = 'wander_install_nudge_dismissed'
/** Per-session intent, set by a successful join so a reload still shows it. */
export const JOIN_NUDGE_KEY = 'wander_install_nudge_pending'
/** Fired by JoinPage on a successful join so the mounted nudge shows live. */
export const JOIN_NUDGE_EVENT = 'wander:trip-joined'

/**
 * Signal that a friend has just completed a join, so the mounted nudge shows.
 * Sets the per-session intent flag (surviving a reload) and fires the live
 * event. Called from the join success path; never blocks or navigates.
 */
export function signalTripJoined() {
  writeFlag('session', JOIN_NUDGE_KEY, '1')
  try {
    window.dispatchEvent(new Event(JOIN_NUDGE_EVENT))
  } catch {
    // No window (non-browser context) — the session flag alone still suffices.
  }
}

function readFlag(storage: 'local' | 'session', key: string): boolean {
  try {
    const store = storage === 'local' ? window.localStorage : window.sessionStorage
    return store.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(storage: 'local' | 'session', key: string, value: '1' | null) {
  try {
    const store = storage === 'local' ? window.localStorage : window.sessionStorage
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode / blocked); degrade silently.
  }
}

export function InstallNudge() {
  const reduce = useReducedMotion()
  const { canPrompt, promptInstall } = useInstallPrompt()
  const [pending, setPending] = React.useState(() => readFlag('session', JOIN_NUDGE_KEY))
  const [dismissed, setDismissed] = React.useState(() => readFlag('local', INSTALL_DISMISSED_KEY))

  React.useEffect(() => {
    function onJoined() {
      setPending(true)
    }
    window.addEventListener(JOIN_NUDGE_EVENT, onJoined)
    return () => window.removeEventListener(JOIN_NUDGE_EVENT, onJoined)
  }, [])

  const ios = isIOS()
  const show = pending && !dismissed && !isStandalone() && (canPrompt || ios)

  function close() {
    writeFlag('local', INSTALL_DISMISSED_KEY, '1')
    writeFlag('session', JOIN_NUDGE_KEY, null)
    setDismissed(true)
    setPending(false)
  }

  async function install() {
    // Whatever the user chooses in the native prompt, the nudge has done its job
    // on this device — don't nag again.
    await promptInstall()
    close()
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          role="dialog"
          aria-label="Add Wander to your home screen"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="no-print fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex justify-center px-4 md:bottom-5"
        >
          <div className="relative w-full max-w-sm rounded-2xl border border-line bg-elevated p-4 pr-10 shadow-lift">
            <button
              type="button"
              onClick={close}
              aria-label="Not now"
              data-icon-button
              className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-faint text-primary">
                <SquarePlus className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">Keep your spot on this trip</p>
                {ios && !canPrompt ? (
                  <p className="mt-1 text-xs text-muted">
                    Add Wander to your home screen so you stay signed in: tap{' '}
                    <Share className="inline size-3.5 -translate-y-px" aria-hidden />{' '}
                    <span className="font-medium text-ink-soft">Share</span>, then{' '}
                    <span className="font-medium text-ink-soft">Add to Home Screen</span>.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    Add Wander to your home screen so you don’t lose your place if you’re away for a
                    while.
                  </p>
                )}
                {canPrompt && (
                  <Button size="lg" className="mt-3 h-11 w-full" onClick={install}>
                    <SquarePlus aria-hidden /> Add to Home Screen
                  </Button>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
