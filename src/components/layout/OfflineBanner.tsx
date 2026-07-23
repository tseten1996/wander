import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CloudOff } from 'lucide-react'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

/**
 * A read-only/offline indicator (issue #55). When the device drops offline the
 * persisted TanStack Query cache still renders the last-fetched trip data, but
 * nothing can be saved — this pill makes that state explicit.
 *
 * Rendered once at the app root so it covers the home list and every trip
 * page. It sits above the mobile tab bar and is announced politely for screen
 * readers; `no-print` keeps it out of the print-to-PDF summary.
 */
export function OfflineBanner() {
  const online = useOnlineStatus()
  const reduce = useReducedMotion()

  return (
    <AnimatePresence>
      {!online && (
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
            <CloudOff className="size-4 shrink-0 text-accent" aria-hidden />
            <span>
              Offline — showing saved data.{' '}
              <span className="text-muted">Changes can’t be saved until you reconnect.</span>
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
