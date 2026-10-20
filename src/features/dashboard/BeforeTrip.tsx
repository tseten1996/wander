import { Link } from 'react-router-dom'
import { motion } from '@/lib/motion'
import {
  ArrowRight, BedDouble, CalendarCheck, CalendarDays, CheckCircle2, ListChecks, Vote,
} from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { useStays } from '@/features/stays/api'
import { useChecklist } from '@/features/checklist/api'
import { usePolls } from '@/features/polls/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/misc'
import { daysUntil } from '@/lib/utils'
import { tripReadiness, type ReadinessKey, type ReadinessSignal } from './readiness'
import type { LucideIcon } from 'lucide-react'

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

/** Label + icon for each readiness signal. Counts are plural-aware so the row
 *  reads like a sentence ("1 night" / "3 nights") rather than a stat dump. */
const PRESENTERS: Record<ReadinessKey, { icon: LucideIcon; label: (n: number) => string }> = {
  'member-dates': {
    icon: CalendarDays,
    label: (n) =>
      n === 1 ? "1 person hasn’t set their trip dates" : `${n} people haven’t set their trip dates`,
  },
  lodging: {
    icon: BedDouble,
    label: (n) => (n === 1 ? '1 night with no place to stay' : `${n} nights with no place to stay`),
  },
  checklist: {
    icon: ListChecks,
    label: (n) => (n === 1 ? '1 task still to do' : `${n} tasks still to do`),
  },
  polls: {
    icon: Vote,
    label: (n) => (n === 1 ? '1 poll waiting on your vote' : `${n} polls waiting on your vote`),
  },
}

function ReadinessRow({ signal }: { signal: ReadinessSignal }) {
  const { icon: Icon, label } = PRESENTERS[signal.key]
  return (
    <Link
      to={signal.to}
      data-tap-target
      className="flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-faint text-primary">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{label(signal.count)}</p>
      <ArrowRight className="size-4 shrink-0 text-faint" aria-hidden />
    </Link>
  )
}

/**
 * The **Before you go** card (#414) — shown in place of nothing while the group
 * is still in the pre-trip phase (`tripPhase === 'before'`), the one phase the
 * Today (#281) / recap (#206) pattern left without a dedicated card. It's a
 * read-only, group-aware readiness summary: who hasn't set their dates, which
 * nights have no lodging, what's still on the checklist, and which polls still
 * need the viewer — each a deep link to the tab that resolves it, each shown
 * only when it isn't already clear.
 *
 * Every figure comes from queries TanStack Query already caches for the trip
 * (`useStays`, `useChecklist`, `usePolls`, plus the members already in trip
 * context), so the card dedupes against the live cache rather than starting a
 * new query storm — the same discipline as `Today` and `TripRecap`. An
 * `undated` trip (no start/end yet) shows a lighter "set your dates" prompt
 * instead of a readiness list.
 */
export function BeforeTrip() {
  const { trip, members, me } = useTripContext()
  const stays = useStays(trip.id)
  const checklist = useChecklist(trip.id)
  const polls = usePolls(trip.id)

  const undated = !trip.start_date || !trip.end_date

  // Undated trips can't compute nights or anchor member dates — nudge the group
  // to pick dates first rather than showing an empty or misleading readiness list.
  if (undated) {
    return (
      <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.04 }}>
        <Card>
          <CardContent className="flex items-start gap-3 py-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-faint text-primary">
              <CalendarCheck className="size-4.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Set your dates to start planning</p>
              <p className="mt-0.5 text-sm text-muted">
                Once the trip has dates,{' '}
                <Link to="dates" className="font-medium text-primary hover:underline">
                  pick them together
                </Link>{' '}
                and this card will track what’s left before you go.
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    )
  }

  const loading = stays.isLoading || checklist.isLoading || polls.isLoading

  const signals = tripReadiness({
    startDate: trip.start_date,
    endDate: trip.end_date,
    members,
    stays: stays.data ?? [],
    checklist: checklist.data ?? [],
    polls: polls.data ?? [],
    viewerId: me.id,
  })

  const days = trip.start_date ? daysUntil(trip.start_date) : null
  const countdown =
    days != null && days > 0 ? (days === 1 ? '1 day to go' : `${days} days to go`) : null

  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.04 }}>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <CalendarCheck className="size-4 text-primary" aria-hidden /> Before you go
            {countdown && <span className="text-sm font-normal text-muted">{countdown}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-20" />
          ) : signals.length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl bg-success-soft p-4">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <p className="text-sm font-medium text-success">
                You’re all set — nothing outstanding before you go.
              </p>
            </div>
          ) : (
            <div className="space-y-1" aria-live="polite">
              {signals.map((signal) => (
                <ReadinessRow key={signal.key} signal={signal} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
