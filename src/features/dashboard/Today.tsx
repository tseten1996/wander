import * as React from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { motion } from '@/lib/motion'
import { BedDouble, CalendarClock, MapPin, Navigation } from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { useItinerary } from '@/features/itinerary/api'
import { useDestinations } from '@/features/destinations/api'
import { useStays } from '@/features/stays/api'
import { useTransport } from '@/features/transport/api'
import { MODE_MAP } from '@/features/transport/modes'
import { useTripWeather } from '@/hooks/useWeather'
import { useTempUnit } from '@/hooks/useTempUnit'
import { describeWeather } from '@/lib/weather'
import { formatTemp } from '@/lib/units'
import { ITINERARY_META } from '@/features/itinerary/meta'
import { buildDayDirections } from '@/features/itinerary/directions'
import { spansCovering, spanPosition } from '@/features/itinerary/spans'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/misc'
import { cn, formatTime, longDate } from '@/lib/utils'
import {
  todaysItems,
  todaysTimeline,
  nextTimelineId,
  stayTransitionsForDay,
  type DayEntry,
  type StayTransition,
} from './today'
import type { ItineraryItem } from '@/types'

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

/** A single scheduled item for today; the next upcoming one is lifted with a
 *  primary tint and a "Next" tag so the group sees where they are in the day. */
function TodayRow({ item, isNext }: { item: ItineraryItem; isNext: boolean }) {
  const meta = ITINERARY_META[item.category]
  const when =
    item.start_time &&
    `${formatTime(item.start_time)}${item.end_time ? ` – ${formatTime(item.end_time)}` : ''}`
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl p-2.5',
        isNext && 'bg-primary-faint ring-1 ring-primary/40'
      )}
      aria-current={isNext ? 'true' : undefined}
    >
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', meta.chip)}>
        <meta.icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{item.title}</p>
          {isNext && (
            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-primary">
              Next
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted">
          {[when, item.location].filter(Boolean).join(' · ') || meta.label}
        </p>
      </div>
    </div>
  )
}

/** A multi-day span (#166) that runs through today — a stay, rail pass, or
 *  festival — pinned above the day's rows, showing where in the span today is. */
function TodaySpanRow({ item, day }: { item: ItineraryItem; day: string }) {
  const meta = ITINERARY_META[item.category]
  const pos = spanPosition(item, day)
  const detail =
    [pos && `Day ${pos.index} of ${pos.total}`, item.location].filter(Boolean).join(' · ') ||
    meta.label
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-sunken/60 px-3 py-2">
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', meta.chip)}>
        <meta.icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{item.title}</p>
        <p className="truncate text-xs text-muted">{detail}</p>
      </div>
    </div>
  )
}

/** A check-in / check-out landing on today (#405), pinned with the day's bands.
 *  Stays carry date-only windows, so there is no clock time to show — only which
 *  place the group is leaving this morning or arriving at today. */
function StayTransitionRow({ transition }: { transition: StayTransition }) {
  const checkOut = transition.kind === 'check-out'
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-sunken/60 px-3 py-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-faint text-primary">
        <BedDouble className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">
          {checkOut ? 'Check out' : 'Check in'}
          <span className="font-normal text-muted">{checkOut ? ' of ' : ' to '}</span>
          {transition.stay.name}
        </p>
        <p className="truncate text-xs text-muted">
          {checkOut ? 'Leaving today' : 'Tonight’s stay'}
        </p>
      </div>
    </div>
  )
}

/** A transport hop departing or arriving today (#405), interleaved by wall-clock
 *  time with the day's itinerary rows; the next upcoming one is lifted with the
 *  same primary tint and "Next" tag as TodayRow so the group sees what's next. */
function TodayTransportRow({
  entry,
  isNext,
}: {
  entry: Extract<DayEntry, { kind: 'transport' }>
  isNext: boolean
}) {
  const { hop, direction, time } = entry
  const { Icon, label } = MODE_MAP[hop.mode]
  const route = [hop.depart_place, hop.arrive_place].filter(Boolean).join(' → ') || label
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl p-2.5',
        isNext && 'bg-primary-faint ring-1 ring-primary/40'
      )}
      aria-current={isNext ? 'true' : undefined}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary">
        <Icon className="size-4.5" aria-label={label} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{route}</p>
          {isNext && (
            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-primary">
              Next
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted">
          {`${direction === 'depart' ? 'Departs' : 'Arrives'} ${formatTime(time)}`}
        </p>
      </div>
    </div>
  )
}

/** "Directions" for today's route — the same whole-day hand-off the itinerary
 *  offers (#167), pointing the maps app at today's ordered, geocoded stops. */
function TodayDirections({ items }: { items: ItineraryItem[] }) {
  const directions = React.useMemo(() => buildDayDirections(items), [items])
  if (!directions) return null
  const { url, included, total, omitted } = directions
  const stops = included === 1 ? 'stop' : 'stops'
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button asChild variant="secondary" size="sm" data-tap-target>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={
            `Open today as a ${included}-${stops} route in Google Maps` +
            (omitted ? `; ${total - included} without a location left off` : '')
          }
        >
          <Navigation aria-hidden />
          Directions
        </a>
      </Button>
      {omitted && (
        <span className="text-xs text-faint" aria-hidden>
          {included} of {total} stops
        </span>
      )}
    </div>
  )
}

/**
 * The **Today** card (#281) — shown in place of the planning-progress card while
 * the group is actually on the trip (`tripPhase === 'during'`). It leads with
 * today's itinerary in time order, marks the next stop, pins any multi-day span
 * running through today, shows the weather for the leg that owns today (#249),
 * and offers the whole-day directions hand-off (#167). Every figure comes from
 * queries TanStack Query already caches for the trip (`useItinerary`,
 * `useDestinations`, `useTripWeather`), so it dedupes against the live cache
 * rather than starting a new query storm — the same discipline as `TripRecap`.
 */
export function Today({ today }: { today: string }) {
  const { trip } = useTripContext()
  const itinerary = useItinerary(trip.id)
  const destinations = useDestinations(trip.id).data ?? []
  const weather = useTripWeather(trip, destinations)
  const { unit } = useTempUnit()
  // Logistics (#405): already cached for the trip by the calendar/search — reused
  // here, not re-fetched, so the card dedupes against the live cache like the rest.
  const stays = useStays(trip.id).data ?? []
  const transport = useTransport(trip.id).data ?? []

  const items = itinerary.data ?? []
  const dayItems = React.useMemo(() => todaysItems(items, today), [items, today])
  const spans = React.useMemo(() => spansCovering(items, today), [items, today])
  // Itinerary items and today's transport hops, merged in the order they happen.
  const timeline = React.useMemo(
    () => todaysTimeline(items, transport, today),
    [items, transport, today]
  )
  const stayTransitions = React.useMemo(
    () => stayTransitionsForDay(today, stays),
    [stays, today]
  )
  // "Now" only needs recomputing each render — there's no live clock elsewhere
  // in the app; a refetch or reopen re-marks the next stop, which is enough.
  const nextId = nextTimelineId(timeline, format(new Date(), 'HH:mm'))
  const todayWeather = weather.data.get(today)
  const empty = timeline.length === 0 && spans.length === 0 && stayTransitions.length === 0

  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }}>
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <CalendarClock className="size-4 text-primary" aria-hidden /> Today
            <span className="text-sm font-normal text-muted">{longDate(today)}</span>
            {todayWeather && (() => {
              const { label, Icon } = describeWeather(todayWeather.code)
              const hi = formatTemp(todayWeather.tempMax, unit)
              const lo = formatTemp(todayWeather.tempMin, unit)
              return (
                <span
                  className="ml-auto flex items-center gap-1 self-center rounded-full bg-sunken px-2 py-0.5 text-xs font-normal text-muted"
                  title={`${label} · High ${hi} Low ${lo}`}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="tabular-nums">{hi} / {lo}</span>
                  <span className="sr-only">{`${label}, high ${hi}, low ${lo}`}</span>
                </span>
              )
            })()}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {itinerary.isLoading ? (
            <Skeleton className="h-24" />
          ) : empty ? (
            <div className="flex items-start gap-3 rounded-xl bg-sunken/60 p-4">
              <MapPin className="mt-0.5 size-5 shrink-0 text-faint" aria-hidden />
              <p className="text-sm text-muted">
                Nothing planned for today — enjoy it, or{' '}
                <Link to="itinerary" className="font-medium text-primary hover:underline">
                  add something to the itinerary
                </Link>
                .
              </p>
            </div>
          ) : (
            <>
              {(spans.length > 0 || stayTransitions.length > 0) && (
                <div className="space-y-2">
                  {spans.map((s) => (
                    <TodaySpanRow key={s.id} item={s} day={today} />
                  ))}
                  {stayTransitions.map((t) => (
                    <StayTransitionRow key={`${t.kind}-${t.stay.id}`} transition={t} />
                  ))}
                </div>
              )}
              {timeline.length > 0 ? (
                <div className="space-y-1.5">
                  {timeline.map((entry) =>
                    entry.kind === 'item' ? (
                      <TodayRow key={entry.id} item={entry.item} isNext={entry.id === nextId} />
                    ) : (
                      <TodayTransportRow key={entry.id} entry={entry} isNext={entry.id === nextId} />
                    )
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No timed plans today — just what&rsquo;s running above.
                </p>
              )}
              {dayItems.length > 0 && <TodayDirections items={dayItems} />}
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
