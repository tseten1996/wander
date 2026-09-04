import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from '@/lib/motion'
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay,
  isSameMonth, isToday, parseISO, startOfMonth, startOfWeek,
} from 'date-fns'
import {
  CalendarClock, ChevronLeft, ChevronRight, CreditCard, MapPin, Plane,
  PlaneLanding, PlaneTakeoff,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useTripContext } from '@/hooks/useTrip'
import { useDestinations } from '@/features/destinations/api'
import { hasRange, legForDay } from '@/features/destinations/legs'
import { legColor, legHeading } from '@/features/destinations/route'
import { PageHeader } from '@/components/layout/PageHeader'
import { ArrivalsBoard } from './ArrivalsBoard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { MemberAvatar } from '@/components/ui/avatar'
import { ErrorState, Skeleton } from '@/components/ui/misc'
import { arrivalsOn, departuresOn } from '@/lib/presence'
import { cn, formatTime, longDate } from '@/lib/utils'
import type { Member } from '@/types'
import { useTripWeather } from '@/hooks/useWeather'
import { useTempUnit } from '@/hooks/useTempUnit'
import { describeWeather } from '@/lib/weather'
import { formatTemp } from '@/lib/units'
import type { BudgetEntry, ChecklistItem, ItineraryItem } from '@/types'

interface CalendarEvent {
  id: string
  date: Date
  label: string
  detail?: string
  kind: 'travel' | 'itinerary' | 'due' | 'payment'
  color: string
}

function useCalendarEvents(tripId: string) {
  const { trip } = useTripContext()
  return useQuery({
    queryKey: ['calendar', tripId],
    queryFn: async (): Promise<CalendarEvent[]> => {
      const [itinerary, checklist, budget] = await Promise.all([
        supabase.from('itinerary_items').select('*').eq('trip_id', tripId).not('day', 'is', null),
        supabase.from('checklist_items').select('*').eq('trip_id', tripId).not('due_date', 'is', null),
        supabase.from('budget_entries').select('*').eq('trip_id', tripId).not('entry_date', 'is', null),
      ])
      const events: CalendarEvent[] = []
      if (trip.start_date) {
        events.push({
          id: 'start', date: parseISO(trip.start_date), label: 'Trip begins ✈️',
          kind: 'travel', color: 'bg-primary',
        })
      }
      if (trip.end_date) {
        events.push({
          id: 'end', date: parseISO(trip.end_date), label: 'Heading home',
          kind: 'travel', color: 'bg-primary',
        })
      }
      for (const item of (itinerary.data ?? []) as ItineraryItem[]) {
        events.push({
          id: item.id,
          date: parseISO(item.day!),
          label: item.title,
          detail: item.start_time ? formatTime(item.start_time) : undefined,
          kind: 'itinerary',
          color: 'bg-sky-500',
        })
      }
      for (const item of (checklist.data ?? []) as ChecklistItem[]) {
        if (item.done) continue
        events.push({
          id: item.id,
          date: parseISO(item.due_date!),
          label: `Due: ${item.title}`,
          kind: 'due',
          color: 'bg-accent',
        })
      }
      for (const entry of (budget.data ?? []) as BudgetEntry[]) {
        events.push({
          id: entry.id,
          date: parseISO(entry.entry_date!),
          label: entry.title,
          kind: 'payment',
          color: 'bg-violet-500',
        })
      }
      return events.sort((a, b) => a.date.getTime() - b.date.getTime())
    },
  })
}

const KIND_ICON = {
  travel: Plane,
  itinerary: CalendarClock,
  due: CalendarClock,
  payment: CreditCard,
}

/** A member arriving or leaving on a day cell: their colour, ringed green for
 *  an arrival and amber for a departure. Kept tiny so the cell stays tap-sized
 *  on mobile; the full "who" is in the day's detail panel below (#286). */
function PresenceDot({ member, kind }: { member: Member; kind: 'arrive' | 'depart' }) {
  return (
    <span
      className={cn(
        'size-3 rounded-full ring-1 ring-inset',
        kind === 'arrive' ? 'ring-success' : 'ring-accent'
      )}
      style={{ backgroundColor: member.color }}
    />
  )
}

/** Presence markers for one day cell — arrivals then departures, capped so a
 *  busy day never overflows the cell; the detail panel lists everyone. */
function DayPresence({ arrivals, departures }: { arrivals: Member[]; departures: Member[] }) {
  if (arrivals.length === 0 && departures.length === 0) return null
  const dots = [
    ...arrivals.map((m) => ({ m, kind: 'arrive' as const })),
    ...departures.map((m) => ({ m, kind: 'depart' as const })),
  ]
  const shown = dots.slice(0, 4)
  const extra = dots.length - shown.length
  const title = [
    arrivals.length && `Arriving: ${arrivals.map((m) => m.display_name).join(', ')}`,
    departures.length && `Leaving: ${departures.map((m) => m.display_name).join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="flex flex-wrap items-center justify-center gap-0.5 px-1" title={title}>
      {shown.map(({ m, kind }) => (
        <PresenceDot key={`${kind}-${m.id}`} member={m} kind={kind} />
      ))}
      {extra > 0 && <span className="text-[9px] leading-none text-faint">+{extra}</span>}
      <span className="sr-only">{title}</span>
    </span>
  )
}

export default function CalendarPage() {
  const { trip, members } = useTripContext()
  const events = useCalendarEvents(trip.id)
  const destinations = useDestinations(trip.id).data ?? []
  const weather = useTripWeather(trip, destinations)
  const { unit } = useTempUnit()
  // Legs that own days (a full date range). Days in a leg's range are tinted
  // with its colour and labelled below; in-trip days in no leg stay neutral
  // ("Unassigned"). Empty for a single-destination trip → calendar unchanged.
  const rangedLegs = destinations.filter(hasRange)
  const [month, setMonth] = React.useState(() =>
    trip.start_date ? parseISO(trip.start_date) : new Date()
  )
  const [selected, setSelected] = React.useState<Date>(() =>
    trip.start_date ? parseISO(trip.start_date) : new Date()
  )

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  })
  const selectedEvents = (events.data ?? []).filter((e) => isSameDay(e.date, selected))
  const selectedIso = format(selected, 'yyyy-MM-dd')
  const selectedArrivals = arrivalsOn(members, selectedIso)
  const selectedDepartures = departuresOn(members, selectedIso)
  const selectedLeg = rangedLegs.length
    ? legForDay(format(selected, 'yyyy-MM-dd'), rangedLegs)
    : null

  return (
    <div>
      <PageHeader
        title="Calendar"
        description="Travel dates, reservations, deadlines and activities in one view."
      />
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{format(month, 'MMMM yyyy')}</h2>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => addMonths(m, -1))} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setMonth(new Date()); setSelected(new Date()) }}>
              Today
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month">
              <ChevronRight />
            </Button>
          </div>
        </div>

        {rangedLegs.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Trip destinations">
            {rangedLegs.map((leg) => (
              <span
                key={leg.id}
                className="flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-xs font-medium text-ink-soft"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: legColor(leg, rangedLegs) }}
                  aria-hidden
                />
                {legHeading(leg)}
              </span>
            ))}
          </div>
        )}

        <div className="grid grid-cols-7 text-center text-xs font-medium text-faint">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="py-1.5">{d}</div>
          ))}
        </div>
        {events.isLoading ? (
          <Skeleton className="h-64" />
        ) : events.isError ? (
          <ErrorState onRetry={() => events.refetch()} isRetrying={events.isFetching} />
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const iso = format(day, 'yyyy-MM-dd')
              const dayEvents = (events.data ?? []).filter((e) => isSameDay(e.date, day))
              const dayArrivals = arrivalsOn(members, iso)
              const dayDepartures = departuresOn(members, iso)
              const dayWeather = weather.data?.get(iso)
              const inTrip =
                trip.start_date && trip.end_date &&
                day >= parseISO(trip.start_date) && day <= parseISO(trip.end_date)
              // Tint the cell by the leg that owns this day (#197); in-trip days
              // in no leg keep the neutral trip-range tint.
              const leg = rangedLegs.length ? legForDay(format(day, 'yyyy-MM-dd'), rangedLegs) : null
              const legTint = leg ? legColor(leg, rangedLegs) : null
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  onClick={() => setSelected(day)}
                  style={legTint ? { backgroundColor: `${legTint}22` } : undefined}
                  title={leg ? legHeading(leg) : undefined}
                  className={cn(
                    // No forced aspect ratio on mobile: with up to 4 event
                    // dots per day, a strict square can be shorter than its
                    // content, spilling dots past the cell into the row
                    // below. min-h-11 keeps a tap-friendly floor and lets
                    // the grid row grow with content instead; sm:aspect-[4/3]
                    // reclaims the neat fixed shape once there's more room.
                    'flex min-h-11 cursor-pointer flex-col items-center justify-start gap-0.5 overflow-hidden rounded-lg pt-1.5 text-sm transition-colors sm:aspect-[4/3]',
                    !isSameMonth(day, month) && 'text-faint/60',
                    inTrip && !legTint && 'bg-primary-faint/60',
                    isSameDay(day, selected) && 'ring-2 ring-primary',
                    'hover:bg-sunken'
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full text-xs',
                      isToday(day) && 'bg-primary font-bold text-on-primary'
                    )}
                  >
                    {format(day, 'd')}
                  </span>
                  <span className="flex flex-wrap justify-center gap-0.5 px-1">
                    {dayEvents.slice(0, 4).map((e) => (
                      <span key={e.id} className={cn('size-1.5 rounded-full', e.color)} />
                    ))}
                  </span>
                  <DayPresence arrivals={dayArrivals} departures={dayDepartures} />
                  {dayWeather && (() => {
                    const { label, Icon } = describeWeather(dayWeather.code)
                    const hi = formatTemp(dayWeather.tempMax, unit)
                    const lo = formatTemp(dayWeather.tempMin, unit)
                    return (
                      <span
                        className="mt-auto flex items-center gap-0.5 pb-0.5 text-[10px] leading-none text-muted"
                        title={`${label} · High ${hi} Low ${lo}`}
                      >
                        <Icon className="size-3 shrink-0" aria-hidden />
                        <span className="tabular-nums">{hi}</span>
                        <span className="sr-only">{`${label}, high ${hi}, low ${lo}`}</span>
                      </span>
                    )
                  })()}
                </button>
              )
            })}
          </div>
        )}
      </Card>

      <ArrivalsBoard members={members} />

      <motion.div
        key={selected.toISOString()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="mt-5"
      >
        <h3 className={cn('font-display font-semibold', !selectedLeg && 'mb-2.5')}>
          {longDate(selected.toISOString())}
        </h3>
        {selectedLeg && (
          <p className="mb-2.5 flex items-center gap-1.5 text-sm text-muted">
            <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden />
            {legHeading(selectedLeg)}
          </p>
        )}
        {(selectedArrivals.length > 0 || selectedDepartures.length > 0) && (
          <Card className="mb-3 divide-y divide-line/60">
            {selectedArrivals.map((m) => (
              <div key={`arr-${m.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-success text-white">
                  <PlaneTakeoff className="size-4" />
                </span>
                <MemberAvatar name={m.display_name} color={m.color} size="sm" />
                <p className="min-w-0 truncate text-sm">
                  <span className="font-medium">{m.display_name}</span>
                  <span className="text-muted"> arrives</span>
                </p>
              </div>
            ))}
            {selectedDepartures.map((m) => (
              <div key={`dep-${m.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-white">
                  <PlaneLanding className="size-4" />
                </span>
                <MemberAvatar name={m.display_name} color={m.color} size="sm" />
                <p className="min-w-0 truncate text-sm">
                  <span className="font-medium">{m.display_name}</span>
                  <span className="text-muted"> leaves</span>
                </p>
              </div>
            ))}
          </Card>
        )}
        {selectedEvents.length === 0 ? (
          selectedArrivals.length === 0 && selectedDepartures.length === 0 && (
            <p className="text-sm text-muted">Nothing on this day.</p>
          )
        ) : (
          <Card className="divide-y divide-line/60">
            {selectedEvents.map((e) => {
              const Icon = KIND_ICON[e.kind]
              return (
                <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn('flex size-8 items-center justify-center rounded-lg text-white', e.color)}>
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{e.label}</p>
                    {e.detail && <p className="text-xs text-muted">{e.detail}</p>}
                  </div>
                </div>
              )
            })}
          </Card>
        )}
      </motion.div>

      <div className="mt-5 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" /> Travel</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-sky-500" /> Itinerary</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" /> Checklist due</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-violet-500" /> Payments</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-surface ring-2 ring-inset ring-success" /> Arrivals</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-surface ring-2 ring-inset ring-accent" /> Departures</span>
      </div>
    </div>
  )
}
