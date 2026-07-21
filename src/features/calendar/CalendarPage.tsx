import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay,
  isSameMonth, isToday, parseISO, startOfMonth, startOfWeek,
} from 'date-fns'
import { CalendarClock, ChevronLeft, ChevronRight, CreditCard, Plane } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useTripContext } from '@/hooks/useTrip'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ErrorState, Skeleton } from '@/components/ui/misc'
import { cn, formatTime, longDate } from '@/lib/utils'
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

export default function CalendarPage() {
  const { trip } = useTripContext()
  const events = useCalendarEvents(trip.id)
  const [month, setMonth] = React.useState(() =>
    trip.start_date ? parseISO(trip.start_date) : new Date()
  )
  const [selected, setSelected] = React.useState<Date>(new Date())

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  })
  const selectedEvents = (events.data ?? []).filter((e) => isSameDay(e.date, selected))

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
              const dayEvents = (events.data ?? []).filter((e) => isSameDay(e.date, day))
              const inTrip =
                trip.start_date && trip.end_date &&
                day >= parseISO(trip.start_date) && day <= parseISO(trip.end_date)
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  onClick={() => setSelected(day)}
                  className={cn(
                    // No forced aspect ratio on mobile: with up to 4 event
                    // dots per day, a strict square can be shorter than its
                    // content, spilling dots past the cell into the row
                    // below. min-h-11 keeps a tap-friendly floor and lets
                    // the grid row grow with content instead; sm:aspect-[4/3]
                    // reclaims the neat fixed shape once there's more room.
                    'flex min-h-11 cursor-pointer flex-col items-center justify-start gap-0.5 overflow-hidden rounded-lg pt-1.5 text-sm transition-colors sm:aspect-[4/3]',
                    !isSameMonth(day, month) && 'text-faint/60',
                    inTrip && 'bg-primary-faint/60',
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
                </button>
              )
            })}
          </div>
        )}
      </Card>

      <motion.div
        key={selected.toISOString()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="mt-5"
      >
        <h3 className="mb-2.5 font-display font-semibold">{longDate(selected.toISOString())}</h3>
        {selectedEvents.length === 0 ? (
          <p className="text-sm text-muted">Nothing on this day.</p>
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
      </div>
    </div>
  )
}
