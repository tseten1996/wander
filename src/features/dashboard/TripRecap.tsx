import * as React from 'react'
import { motion } from '@/lib/motion'
import { CalendarDays, CheckCircle2, CopyPlus, MapPin, Sparkles, Users, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { useBudget, useRepayments } from '@/features/budget/api'
import { useItinerary } from '@/features/itinerary/api'
import { useDestinations } from '@/features/destinations/api'
import { routeText } from '@/features/destinations/route'
import { DuplicateTripDialog } from '@/features/trips/DuplicateTripDialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/misc'
import { dateRange, formatMoney } from '@/lib/utils'
import { useDashboard, planningProgress } from './api'
import {
  locatedStops,
  recapSettlement,
  stopCount,
  totalSpend,
  tripDayCount,
  type RecapSettlement,
} from './recap'

// Read-only places-visited map (#248, epic #205 slice 3), lazy-loaded so Leaflet
// + its CSS stay in their own async chunk and never enter the initial bundle.
const RecapMap = React.lazy(() => import('@/features/itinerary/RecapMap'))

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
}

/** The settle-up state as one calm line under the total spend. */
function settlementLabel(s: RecapSettlement): string {
  if (!s.hasData) return 'total spent'
  if (s.settled) return 'all settled'
  return `${s.transfersLeft} transfer${s.transfersLeft === 1 ? '' : 's'} left`
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
    <div className="rounded-2xl bg-sunken p-4">
      <Icon className="size-5 text-primary" aria-hidden />
      <p className="mt-2 font-display text-2xl font-bold leading-none">{value}</p>
      <p className="mt-1.5 text-xs text-muted">{label}</p>
    </div>
  )
}

/**
 * Post-trip **Trip recap** card (#206, epic #205 slice 1). Once the trip's end
 * date has passed the dashboard shows this calm, screenshot-worthy summary in
 * place of the (now meaningless) countdown/progress area. Every figure is
 * derived from queries TanStack Query already caches for the trip — the same
 * hooks the Budget, Itinerary and dashboard pages use, so they dedupe against
 * the live cache rather than starting a new query storm. It is only mounted
 * once the trip has ended, so nothing here runs (or fetches) beforehand.
 */
export function TripRecap() {
  const { trip, members } = useTripContext()
  // The recap's "do it again" hook (#352). Reuses the shipped `duplicate_trip`
  // RPC via the same `DuplicateTripDialog` Settings mounts — no new RPC/table/
  // policy — pre-seeded from this trip. Because `TripRecap` only mounts once the
  // trip has ended (DashboardPage gates it to `phase === 'after'`), this entry
  // point inherits that gate and never competes with in-trip planning.
  const [duplicateOpen, setDuplicateOpen] = React.useState(false)
  const dash = useDashboard(trip.id)
  const budget = useBudget(trip.id)
  const repayments = useRepayments(trip.id)
  const itinerary = useItinerary(trip.id)
  const route = routeText(useDestinations(trip.id).data ?? [], trip.destination)

  const loading =
    dash.isLoading || budget.isLoading || repayments.isLoading || itinerary.isLoading

  const days = tripDayCount(trip.start_date, trip.end_date)
  const stops = itinerary.data ? stopCount(itinerary.data) : null
  // The located stops that plot the route. Fewer than 2 renders no map (below),
  // so the stats-only recap never shows an empty map frame.
  const mapStops = React.useMemo(
    () => (itinerary.data ? locatedStops(itinerary.data) : []),
    [itinerary.data],
  )
  const spend = budget.data ? totalSpend(budget.data) : null
  const settlement = budget.data
    ? recapSettlement(budget.data, members, repayments.data ?? [])
    : null
  const planning = dash.data ? planningProgress(dash.data) : null

  const subtitle = [route, dateRange(trip.start_date, trip.end_date)]
    .filter(Boolean)
    .join(' · ')

  return (
    <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }}>
      <Card className="gradient-travel-soft overflow-hidden" aria-label="Trip recap">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden /> Trip recap
          </CardTitle>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-[92px]" />
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                <Stat icon={CalendarDays} value={days ?? '—'} label={days === 1 ? 'day' : 'days'} />
                <Stat icon={MapPin} value={stops ?? '—'} label={stops === 1 ? 'stop' : 'stops'} />
                <Stat
                  icon={Wallet}
                  value={spend != null ? formatMoney(spend, trip.currency) : '—'}
                  label={settlement ? settlementLabel(settlement) : 'total spent'}
                />
                <Stat
                  icon={CheckCircle2}
                  value={planning ? `${planning.pct}%` : '—'}
                  label="planned"
                />
                <Stat
                  icon={Users}
                  value={members.length}
                  label={members.length === 1 ? 'traveler' : 'travelers'}
                />
              </div>

              {mapStops.length >= 2 && (
                <div className="mt-4">
                  <p className="mb-2 text-sm font-medium text-muted">Where you went</p>
                  <React.Suspense
                    fallback={<Skeleton className="h-[20rem] rounded-2xl sm:h-[26rem]" />}
                  >
                    <RecapMap stops={mapStops} />
                  </React.Suspense>
                </div>
              )}

              {/* The retention hook (#352): from "that was great" to "let's do it
                  again" in one tap, right at the emotional peak. Any member can
                  use it — `duplicate_trip` deliberately allows non-owners. */}
              <div className="mt-5 flex flex-col items-start gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted">
                  Loved this one? Start your next trip with the same crew.
                </p>
                <Button
                  variant="soft"
                  size="lg"
                  className="h-auto min-h-12 w-full whitespace-normal py-2.5 text-center leading-snug sm:w-auto"
                  onClick={() => setDuplicateOpen(true)}
                >
                  <CopyPlus /> Plan your next trip from this one
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <DuplicateTripDialog trip={trip} open={duplicateOpen} onOpenChange={setDuplicateOpen} />
    </motion.div>
  )
}
