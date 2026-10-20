import * as React from 'react'
import { Link } from 'react-router-dom'
import { motion } from '@/lib/motion'
import {
  ArrowRight, BedDouble, CalendarClock, CalendarDays, CheckCircle2, ListChecks,
  Users, Vote, type LucideIcon,
} from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { useChecklist } from '@/features/checklist/api'
import { useStays } from '@/features/stays/api'
import { usePolls } from '@/features/polls/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/misc'
import { daysUntil } from '@/lib/utils'
import { tripReadiness, type ReadinessSignal } from './readiness'

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

/** How each readiness signal renders: its icon, where it deep-links, and the
 *  copy for its count (and any secondary count). Keeping the display here leaves
 *  `readiness.ts` as pure, testable data. */
function describe(signal: ReadinessSignal): {
  icon: LucideIcon
  to: string
  label: string
  sub?: string
} {
  const { count, unassigned } = signal
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
  switch (signal.kind) {
    case 'member-dates':
      return {
        icon: Users,
        to: 'me',
        label: `${count} ${plural(count, 'traveler hasn’t', 'travelers haven’t')} shared their dates`,
      }
    case 'lodging':
      return {
        icon: BedDouble,
        to: 'calendar',
        label: `${count} ${plural(count, 'night', 'nights')} without a place to stay`,
      }
    case 'checklist':
      return {
        icon: ListChecks,
        to: 'checklist',
        label: `${count} ${plural(count, 'task', 'tasks')} still to do`,
        sub: unassigned > 0 ? `${unassigned} ${plural(unassigned, 'needs', 'need')} an owner` : undefined,
      }
    case 'polls':
      return {
        icon: Vote,
        to: 'polls',
        label: `${count} ${plural(count, 'poll', 'polls')} awaiting your vote`,
      }
  }
}

/** One tappable readiness row — a link into the tab that resolves it. Floored at
 *  44px (guardrail #6) so it clears the mobile tap target. */
function ReadinessRow({ signal }: { signal: ReadinessSignal }) {
  const { icon: Icon, to, label, sub } = describe(signal)
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-faint text-primary">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        {sub && <p className="truncate text-xs text-muted">{sub}</p>}
      </div>
      <ArrowRight className="size-4 shrink-0 text-faint" aria-hidden />
    </Link>
  )
}

/**
 * The pre-trip **readiness** card (#414) — shown in place of nothing while the
 * group is still assembling the plan (`tripPhase === 'before'`, or a lighter
 * form when the trip is `undated`). It answers "what still isn't ready before we
 * go?" with a group-aware summary: who hasn't set dates, which nights have no
 * lodging, which tasks are open, and which polls still need the viewer's vote —
 * each a link to the tab that resolves it. A fully-ready trip shows a positive
 * empty state. Every figure comes from queries TanStack Query already caches for
 * the trip (`useChecklist`, `useStays`, `usePolls`), reused here rather than
 * re-fetched — the same discipline as `Today` / `TripRecap`.
 */
export function BeforeTrip() {
  const { trip, members, me } = useTripContext()
  const checklist = useChecklist(trip.id)
  const stays = useStays(trip.id)
  const polls = usePolls(trip.id)

  const undated = !trip.start_date || !trip.end_date
  const loading = checklist.isLoading || stays.isLoading || polls.isLoading

  const signals = React.useMemo(
    () =>
      tripReadiness({
        startDate: trip.start_date,
        endDate: trip.end_date,
        members,
        stays: stays.data ?? [],
        checklist: checklist.data ?? [],
        polls: polls.data ?? [],
        myMemberId: me.id,
      }),
    [trip.start_date, trip.end_date, members, stays.data, checklist.data, polls.data, me.id],
  )

  // The countdown lives on the Hero already (#414 is the readiness surface, not
  // another countdown); a dated trip gets a quiet "N days to go" subtitle, an
  // undated one a prompt to set dates so the rest of planning has a frame.
  const days = !undated && trip.start_date ? daysUntil(trip.start_date) : null
  const subtitle = undated
    ? 'Set your trip dates to start planning'
    : days != null && days > 0
      ? `${days} ${days === 1 ? 'day' : 'days'} to go`
      : 'Almost there'

  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" aria-hidden /> Before you go
            <span className="ml-auto text-sm font-normal text-muted">{subtitle}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {undated ? (
            // Lighter form: no dates means no nights to cover and no countdown —
            // point the group at the one thing that unblocks the rest.
            <Link
              to="settings"
              className="flex min-h-11 items-center gap-3 rounded-xl bg-sunken/60 p-3 transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-faint text-primary">
                <CalendarDays className="size-4.5" aria-hidden />
              </span>
              <p className="min-w-0 flex-1 text-sm text-muted">
                Set your trip dates to start planning what&rsquo;s needed before you go.
              </p>
              <ArrowRight className="size-4 shrink-0 text-faint" aria-hidden />
            </Link>
          ) : loading ? (
            <Skeleton className="h-24" />
          ) : signals.length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl bg-sunken/60 p-4">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <p className="text-sm text-muted">
                You&rsquo;re all set — nothing outstanding before you go.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5" aria-live="polite">
              {signals.map((signal) => (
                <ReadinessRow key={signal.kind} signal={signal} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
