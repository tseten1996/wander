import { motion } from '@/lib/motion'
import { format, parseISO } from 'date-fns'
import { PlaneLanding, PlaneTakeoff, Users } from 'lucide-react'
import { joinNames, presenceTimeline } from '@/lib/presence'
import type { PresenceTimelineDay } from '@/lib/presence'
import { Card } from '@/components/ui/card'
import { MemberAvatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import type { Member } from '@/types'

/*
  Arrivals & departures board (#331, epic #285 slice 4). One chronological,
  read-only answer to "who's arriving Thursday, and who's already gone by Sunday
  brunch?" — the coordination moment the epic opened with ("who lets the late
  arrivals in"). Pure aggregation over `members.arrives_on` / `departs_on`, the
  same columns the calendar cells and header already read; no schema, RLS, or
  new trust surface.

  A trip where nobody set dates has no events, so the board renders a calm
  full-trip state ("Everyone's here for the whole trip") rather than empty or
  negative UI — the acceptance criterion for that case.
*/

/** One member's arrival or departure, rendered as an avatar + a short sentence
 *  ("Sam and Priya arrive"). Members are grouped so a shared date reads as one
 *  line, not one per person. */
function EventRow({
  members,
  kind,
}: {
  members: Member[]
  kind: 'arrive' | 'depart'
}) {
  if (members.length === 0) return null
  const arriving = kind === 'arrive'
  const Icon = arriving ? PlaneTakeoff : PlaneLanding
  const verb = arriving
    ? members.length > 1
      ? 'arrive'
      : 'arrives'
    : members.length > 1
      ? 'leave'
      : 'leaves'
  return (
    <div className="flex items-center gap-3 py-1.5">
      {/* Green for an arrival, amber for a departure — the same colour language
          the calendar day detail uses. */}
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg text-white',
          arriving ? 'bg-success' : 'bg-accent'
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <span className="flex -space-x-1.5">
        {members.map((m) => (
          <MemberAvatar key={m.id} name={m.display_name} color={m.color} size="sm" />
        ))}
      </span>
      <p className="min-w-0 text-sm">
        <span className="font-medium">{joinNames(members.map((m) => m.display_name))}</span>
        <span className="text-muted"> {verb}</span>
      </p>
    </div>
  )
}

function TimelineDay({ day }: { day: PresenceTimelineDay }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
        {format(parseISO(day.date), 'EEE, MMM d')}
      </p>
      <EventRow members={day.arrivals} kind="arrive" />
      <EventRow members={day.departures} kind="depart" />
    </div>
  )
}

/**
 * The board itself. `members` comes from trip context (the caller already holds
 * it), keeping this component a pure render of the timeline.
 */
export function ArrivalsBoard({ members }: { members: Member[] }) {
  const { days, wholeTrip } = presenceTimeline(members)
  const hasEvents = days.length > 0

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="mt-5"
      aria-label="Arrivals and departures"
    >
      <h3 className="mb-2.5 flex items-center gap-2 font-display font-semibold">
        <PlaneTakeoff className="size-4 text-primary" aria-hidden />
        Who&apos;s here when
      </h3>
      <Card className="p-4">
        {hasEvents ? (
          <>
            <div className="divide-y divide-line/60">
              {days.map((day) => (
                <TimelineDay key={day.date} day={day} />
              ))}
            </div>
            {wholeTrip.length > 0 && (
              <div className="mt-3 flex items-center gap-3 border-t border-line/60 pt-3">
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted"
                  aria-hidden
                >
                  <Users className="size-4" />
                </span>
                <span className="flex -space-x-1.5">
                  {wholeTrip.map((m) => (
                    <MemberAvatar key={m.id} name={m.display_name} color={m.color} size="sm" />
                  ))}
                </span>
                <p className="min-w-0 text-sm">
                  <span className="font-medium">
                    {joinNames(wholeTrip.map((m) => m.display_name))}
                  </span>
                  <span className="text-muted">
                    {' '}
                    {wholeTrip.length > 1 ? 'are' : 'is'} here the whole trip
                  </span>
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-3">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted"
              aria-hidden
            >
              <Users className="size-4" />
            </span>
            <p className="text-sm text-muted">
              Everyone&apos;s here for the whole trip. Set arrival or departure
              dates from a member&apos;s profile in{' '}
              <span className="font-medium text-ink-soft">Settings</span> to
              coordinate staggered plans.
            </p>
          </div>
        )}
      </Card>
    </motion.section>
  )
}
