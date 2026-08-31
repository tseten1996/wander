import { AnimatePresence, motion, useReducedMotion } from '@/lib/motion'
import { CloudOff, RefreshCw } from 'lucide-react'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useSyncQueueCount } from '@/hooks/useSyncQueue'

/**
 * A read-only/offline indicator (issue #55) that also reports the offline sync
 * queue (issue #283). The persisted TanStack Query cache renders the last
 * trip data while offline; most writes still can't be saved, but a packing or
 * checklist toggle is queued and flushed on reconnect. This pill distinguishes
 * "showing saved data" from "N changes waiting to sync".
 *
 * Rendered once at the app root so it covers the home list and every trip
 * page. It sits above the mobile tab bar and is announced politely for screen
 * readers; `no-print` keeps it out of the print-to-PDF summary.
 *
 * It shows whenever the device is offline OR the sync queue is non-empty — so
 * it stays visible after reconnect just long enough to flush, then clears when
 * the queue drains.
 */
export function OfflineBanner() {
  const online = useOnlineStatus()
  const queued = useSyncQueueCount()
  const reduce = useReducedMotion()

  const visible = !online || queued > 0
  // Online with a draining queue = actively syncing what was queued offline.
  const syncing = online && queued > 0
  const countLabel = `${queued} ${queued === 1 ? 'change' : 'changes'}`

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="no-print pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex justify-center px-4 md:bottom-5"
        >
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-elevated px-4 py-2 text-sm font-medium text-ink shadow-lift">
            {syncing ? (
              <>
                <RefreshCw
                  className={reduce ? 'size-4 shrink-0 text-accent' : 'size-4 shrink-0 animate-spin text-accent'}
                  aria-hidden
                />
                <span>Back online — syncing {countLabel}…</span>
              </>
            ) : (
              <>
                <CloudOff className="size-4 shrink-0 text-accent" aria-hidden />
                <span>
                  Offline — showing saved data.{' '}
                  {queued > 0 ? (
                    <span className="text-muted">{countLabel} waiting to sync.</span>
                  ) : (
                    <span className="text-muted">Most changes can’t be saved until you reconnect.</span>
                  )}
                </span>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
