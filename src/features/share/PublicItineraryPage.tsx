import * as React from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CalendarDays, Compass, Link2Off, MapPin, Clock } from 'lucide-react'
import { cn, longDate, dateRange, formatTime, shortDate } from '@/lib/utils'
import { PageLoader, EmptyState, ErrorState } from '@/components/ui/misc'
import { ITINERARY_META } from '@/features/itinerary/meta'
import { usePublicItinerary } from './api'
import type { PublicItinerary, PublicItineraryItem } from '@/types'

/** A day of the itinerary: its ISO date (null = unscheduled) and its items,
 *  already in position order from the RPC. */
interface DayGroup {
  day: string | null
  number: number | null
  items: PublicItineraryItem[]
}

/**
 * Group items into days for display. Items arrive ordered by day (nulls last)
 * then position, so contiguous same-day items form one group in a single pass.
 * Dated days get a stable 1-based "Day N" in chronological order; undated items
 * collect into a trailing "Ideas" group with no number.
 */
function groupByDay(items: PublicItineraryItem[]): DayGroup[] {
  const groups: DayGroup[] = []
  let n = 0
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.day === item.day) {
      last.items.push(item)
      continue
    }
    groups.push({
      day: item.day,
      number: item.day ? (n += 1) : null,
      items: [item],
    })
  }
  return groups
}

export default function PublicItineraryPage() {
  const { token } = useParams<{ token: string }>()
  const { data, isLoading, isError, refetch, isFetching } = usePublicItinerary(token)

  if (isLoading) return <PageLoader />

  if (isError) {
    return (
      <PublicShell>
        <ErrorState
          title="Couldn’t load this itinerary"
          description="We couldn’t reach the server. Check your connection and try again."
          onRetry={() => void refetch()}
          isRetrying={isFetching}
        />
      </PublicShell>
    )
  }

  // A revoked / invalid / absent token returns null (not an error): the honest
  // "this link isn’t available" state — never partial data.
  if (!data) {
    return (
      <PublicShell>
        <EmptyState
          icon={Link2Off}
          title="This link isn’t available"
          description="The share link may have been turned off, or the address is incomplete. Ask whoever shared it for a fresh link."
          action={
            <Link
              to="/"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Go to Wander
            </Link>
          }
        />
      </PublicShell>
    )
  }

  return <PublicItinerary data={data} />
}

/** Centered, theme-aware page frame shared by every state. */
function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:py-14">{children}</div>
    </div>
  )
}

function PublicItinerary({ data }: { data: PublicItinerary }) {
  const { trip, items } = data
  const groups = React.useMemo(() => groupByDay(items), [items])
  const hasDates = !!(trip.start_date || trip.end_date)

  return (
    <PublicShell>
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="mb-8"
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Trip itinerary
        </p>
        <h1 className="mt-1 font-display text-3xl font-bold text-ink">{trip.name}</h1>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          {trip.destination && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-4" /> {trip.destination}
            </span>
          )}
          {hasDates && (
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-4" />
              {dateRange(trip.start_date, trip.end_date)}
            </span>
          )}
        </div>
      </motion.header>

      {items.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="Nothing planned yet"
          description="This trip’s itinerary is still being put together. Check back soon."
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group, i) => (
            <DaySection key={group.day ?? 'unscheduled'} group={group} index={i} />
          ))}
        </div>
      )}

      <footer className="mt-14 border-t border-line pt-6 text-center text-xs text-faint">
        <p>
          A read-only itinerary shared from{' '}
          <Link to="/" className="font-medium text-muted underline-offset-4 hover:underline">
            Wander
          </Link>
          .
        </p>
      </footer>
    </PublicShell>
  )
}

function DaySection({ group, index }: { group: DayGroup; index: number }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut', delay: Math.min(index * 0.04, 0.2) }}
    >
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">
          {group.number ? `Day ${group.number}` : 'Ideas'}
        </h2>
        {group.day && <span className="text-sm text-muted">{longDate(group.day)}</span>}
      </div>
      <ul className="space-y-2">
        {group.items.map((item) => (
          <li key={item.id}>
            <ItineraryRow item={item} />
          </li>
        ))}
      </ul>
    </motion.section>
  )
}

function ItineraryRow({ item }: { item: PublicItineraryItem }) {
  const meta = ITINERARY_META[item.category]
  const Icon = meta.icon
  const timeLabel = timeRange(item)
  // A multi-day span (stay / rail pass) shows its closing date so a read-only
  // viewer understands it runs across days, not just its start day.
  const spanEnd = item.end_day && item.day && item.end_day > item.day ? item.end_day : null

  return (
    <div className="flex gap-3 rounded-2xl border border-line bg-elevated p-4">
      <div
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl',
          meta.chip
        )}
        aria-hidden
      >
        <Icon className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="font-medium text-ink">{item.title}</p>
          <span className="text-xs text-faint">{meta.label}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
          {timeLabel && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" /> {timeLabel}
            </span>
          )}
          {spanEnd && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3.5" /> until {shortDate(spanEnd)}
            </span>
          )}
          {item.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" /> {item.location}
            </span>
          )}
        </div>
        {item.notes && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{item.notes}</p>
        )}
      </div>
    </div>
  )
}

/** "2:30 PM", "2:30 PM – 4:00 PM", or "" — reused format across the app. */
function timeRange(item: PublicItineraryItem): string {
  const start = formatTime(item.start_time)
  const end = formatTime(item.end_time)
  if (start && end) return `${start} – ${end}`
  return start || end
}
