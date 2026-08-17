import * as React from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from '@/lib/motion'
import {
  ArrowRight, CalendarDays, Hourglass, Link2Off, MapPin, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn, dateRange } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageLoader, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { ITINERARY_META } from '@/features/itinerary/meta'
// The recap's day count reuses the same pure derivation the private #206 card
// uses (tripDayCount), rather than re-deriving trip length here — the aggregate
// counts (stops, travelers) are computed server-side in the whitelisted
// projection, since an outsider can't see the rows they roll up. `locatedStops`
// picks the pinned stops the map draws, from the same projection.
import { locatedStops, tripDayCount } from '@/features/dashboard/recap'

// Read-only places-visited map (#248, epic #205 slice 3), lazy-loaded so Leaflet
// + its CSS stay in their own async chunk and never enter the public page's
// initial bundle. Fed from the share-token projection's coordinates — no new
// public read, no member PII.
const RecapMap = React.lazy(() => import('@/features/itinerary/RecapMap'))
import { usePublicRecap } from './api'
import type { PublicRecap, PublicRecapPlace, PublicTripMeta } from '@/types'

export default function RecapPage() {
  const { token } = useParams<{ token: string }>()
  const { data, isLoading, isError, refetch, isFetching } = usePublicRecap(token)

  if (isLoading) return <PageLoader />

  if (isError) {
    return (
      <PublicShell>
        <ErrorState
          title="Couldn’t load this recap"
          description="We couldn’t reach the server. Check your connection and try again."
          onRetry={() => void refetch()}
          isRetrying={isFetching}
        />
      </PublicShell>
    )
  }

  // A revoked / invalid / not-shared token returns null (not an error): the
  // honest "this link isn’t available" state — never partial data.
  if (!data) {
    return (
      <PublicShell>
        <EmptyState
          icon={Link2Off}
          title="This link isn’t available"
          description="The recap link may have been turned off, or the address is incomplete. Ask whoever shared it for a fresh link."
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

  // A valid, shared link whose trip hasn’t ended yet — gated exactly like the
  // #206 card. A friendly "not ready" state, distinct from a dead link.
  if (data.status === 'pending') {
    return (
      <PublicShell>
        <EmptyState
          icon={Hourglass}
          title="This recap isn’t ready yet"
          description={
            data.trip.name
              ? `“${data.trip.name}” hasn’t wrapped up yet. Once the trip ends, its recap will appear here.`
              : 'This trip hasn’t wrapped up yet. Once it ends, its recap will appear here.'
          }
          action={<PlanYourOwnLink subtle />}
        />
      </PublicShell>
    )
  }

  return <Recap data={data} />
}

/** Centered, theme-aware page frame shared by every state. */
function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:py-14">{children}</div>
    </div>
  )
}

function Recap({ data }: { data: Extract<PublicRecap, { status: 'ready' }> }) {
  const { trip, stats, places } = data
  const days = tripDayCount(trip.start_date, trip.end_date)
  // The pinned stops that draw the route. Fewer than 2 renders no map, so the
  // recap degrades to stats + the "Where they went" list with no empty frame.
  const mapStops = React.useMemo(() => locatedStops(places), [places])

  return (
    <PublicShell>
      <Header trip={trip} />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut', delay: 0.05 }}
        className="grid grid-cols-3 gap-3"
      >
        <Stat icon={CalendarDays} value={days ?? '—'} label={days === 1 ? 'day' : 'days'} />
        <Stat icon={MapPin} value={stats.stops} label={stats.stops === 1 ? 'stop' : 'stops'} />
        <Stat
          icon={Users}
          value={stats.travelers}
          label={stats.travelers === 1 ? 'traveler' : 'travelers'}
        />
      </motion.div>

      {places.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-lg font-semibold text-ink">Where they went</h2>
          {mapStops.length >= 2 && (
            <div className="mt-3">
              <React.Suspense
                fallback={<Skeleton className="h-[20rem] rounded-2xl sm:h-[26rem]" />}
              >
                <RecapMap stops={mapStops} />
              </React.Suspense>
            </div>
          )}
          <ul className="mt-3 space-y-2">
            {places.map((place, i) => (
              <PlaceRow key={place.id} place={place} index={i} />
            ))}
          </ul>
        </section>
      )}

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut', delay: 0.1 }}
        className="mt-12 rounded-3xl gradient-travel-soft p-6 text-center"
      >
        <h2 className="font-display text-xl font-bold text-ink">Plan your own trip</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
          Wander turns a group chat into a real plan — itinerary, budget and
          packing, with friends joining in seconds. No account needed to look around.
        </p>
        <div className="mt-4 flex justify-center">
          <PlanYourOwnLink />
        </div>
      </motion.div>

      <footer className="mt-14 border-t border-line pt-6 text-center text-xs text-faint">
        <p>
          A read-only trip recap shared from{' '}
          <Link to="/" className="font-medium text-muted underline-offset-4 hover:underline">
            Wander
          </Link>
          .
        </p>
      </footer>
    </PublicShell>
  )
}

function Header({ trip }: { trip: PublicTripMeta }) {
  const hasDates = !!(trip.start_date || trip.end_date)
  return (
    <motion.header
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="mb-8"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Trip recap</p>
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
  )
}

function Stat({
  icon: Icon,
  value,
  label,
}: {
  icon: LucideIcon
  value: React.ReactNode
  label: string
}) {
  return (
    <div className="rounded-2xl bg-sunken p-4 text-center sm:text-left">
      <Icon className="mx-auto size-5 text-primary sm:mx-0" aria-hidden />
      <p className="mt-2 font-display text-2xl font-bold leading-none">{value}</p>
      <p className="mt-1.5 text-xs text-muted">{label}</p>
    </div>
  )
}

function PlaceRow({ place, index }: { place: PublicRecapPlace; index: number }) {
  const meta = ITINERARY_META[place.category]
  const Icon = meta.icon
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(index * 0.03, 0.2) }}
      className="flex items-center gap-3 rounded-2xl border border-line bg-elevated p-3.5"
    >
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', meta.chip)}
        aria-hidden
      >
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{place.title}</p>
        {place.location && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-muted">
            <MapPin className="size-3.5 shrink-0" /> {place.location}
          </p>
        )}
      </div>
    </motion.li>
  )
}

/** The epic's growth CTA: a first-time visitor with no account into the
 *  create-trip flow (the app home, where "New trip" lives). */
function PlanYourOwnLink({ subtle = false }: { subtle?: boolean }) {
  if (subtle) {
    return (
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Plan your own trip with Wander <ArrowRight className="size-4" />
      </Link>
    )
  }
  return (
    <Button asChild className="rounded-full px-6">
      <Link to="/">
        Plan your own trip <ArrowRight className="size-4" />
      </Link>
    </Button>
  )
}
