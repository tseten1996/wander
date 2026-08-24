import * as React from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from '@/lib/motion'
import { Luggage, MapPin, MessageCircle, Sparkles, Vote, X } from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'

/**
 * A just-joined friend's first-visit orientation (issue #291). The 15-second
 * join drops a new member straight onto the dashboard, whose empty-state hints
 * read as planning-in-progress prompts rather than a first-timer's map of where
 * chat / itinerary / packing / polls live. This is the one dismissible panel
 * that says "you're in, here's the trip, here's where things happen" — the
 * smallest complete version, never a multi-step tour.
 *
 * Shown once per membership: gated on a per-(trip, member) "seen" flag in Local
 * Storage, so it never reappears for that member on that device and needs no
 * schema change. It never shows for the owner (their create-trip flow is not a
 * join), and never on a later visit once dismissed. Silence beats a modal — it
 * is an inline, skippable card, not a blocking dialog.
 */

/** Per-(trip, member) flag: this member has seen their welcome on this device. */
function seenKey(tripId: string, memberId: string) {
  return `wander_welcome_seen:${tripId}:${memberId}`
}

function readSeen(tripId: string, memberId: string): boolean {
  try {
    return window.localStorage.getItem(seenKey(tripId, memberId)) === '1'
  } catch {
    // Storage unavailable (private mode / blocked) — treat as already seen so a
    // panel we can't remember dismissing never becomes a permanent fixture.
    return true
  }
}

function writeSeen(tripId: string, memberId: string) {
  try {
    window.localStorage.setItem(seenKey(tripId, memberId), '1')
  } catch {
    // Degrade silently; the in-memory state below still hides it this session.
  }
}

/** "Alex", "Alex and Sam", "Alex, Sam and 3 others" — the people already here. */
function othersLine(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'}`
}

const SURFACES = [
  { to: 'chat', label: 'Chat', icon: MessageCircle, hint: 'Talk it out' },
  { to: 'itinerary', label: 'Itinerary', icon: MapPin, hint: 'The plan' },
  { to: 'polls', label: 'Polls', icon: Vote, hint: 'Decide together' },
  { to: 'packing', label: 'Packing', icon: Luggage, hint: 'Your list' },
] as const

export function JoinWelcome() {
  const { trip, members, me, isOwner } = useTripContext()
  const reduce = useReducedMotion()

  // The owner's create-trip flow is not a join, so they never get the welcome.
  // Members get it once, until they dismiss it. Read the persisted flag lazily
  // so the panel is hidden on the very first paint of a return visit.
  const [dismissed, setDismissed] = React.useState(
    () => isOwner || readSeen(trip.id, me.id)
  )

  const show = !isOwner && !dismissed

  function close() {
    writeSeen(trip.id, me.id)
    setDismissed(true)
  }

  const others = othersLine(members.filter((m) => m.id !== me.id).map((m) => m.display_name))

  return (
    <AnimatePresence>
      {show && (
        <motion.section
          aria-labelledby="join-welcome-title"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="relative overflow-hidden rounded-2xl border border-primary/20 bg-primary-faint p-5 pr-12"
        >
          <button
            type="button"
            onClick={close}
            aria-label="Dismiss welcome"
            data-icon-button
            className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-primary/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="size-4" aria-hidden />
          </button>

          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
              <Sparkles className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id="join-welcome-title" className="font-display text-lg font-bold text-ink">
                You’re in{me.display_name ? `, ${me.display_name}` : ''}! Welcome to {trip.name}.
              </h2>
              <p className="mt-1 text-sm text-muted">
                {others
                  ? `You’re planning this trip with ${others}. Here’s where it all happens:`
                  : 'This is your group’s shared space. Here’s where it all happens:'}
              </p>
            </div>
          </div>

          <nav
            aria-label="Trip surfaces"
            className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {SURFACES.map(({ to, label, icon: Icon, hint }) => (
              <Link
                key={to}
                to={to}
                data-tap-target
                className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-all hover:-translate-y-0.5 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:flex-col sm:items-start sm:gap-1.5"
              >
                <Icon className="size-5 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{label}</p>
                  <p className="truncate text-xs text-muted">{hint}</p>
                </div>
              </Link>
            ))}
          </nav>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
