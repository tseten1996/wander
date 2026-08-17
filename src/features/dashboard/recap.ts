import type { BudgetEntry, ItineraryItem, Member, Repayment } from '@/types'
import { tripActual } from '../budget/amounts'
import {
  computeBalances,
  hasSettlementData,
  isAllSettled,
  minimalTransfers,
} from '../budget/settlement'

/**
 * Pure derivations for the post-trip **Trip recap** card (#206, epic #205
 * slice 1). Every figure is computed from data TanStack Query has already
 * cached for the trip — no new tables, no migration, no server code. Kept in a
 * dependency-light module (only the erased `import type` plus relative budget
 * helpers) so the Node test runner can import it after type-stripping, matching
 * `spans.ts` / `settlement.ts`.
 */

/**
 * One located stop for the recap map (#248, epic #205 slice 3): the minimal
 * whitelisted shape both recap surfaces plot — the private dashboard card (from
 * cached `ItineraryItem`s) and the public page (from the `get_public_recap`
 * projection). Just an id, a name and finite coordinates; no times, cost or
 * authorship reach the map.
 */
export interface RecapStop {
  id: string
  title: string
  latitude: number
  longitude: number
}

/**
 * The located stops among `items`, in the order given (both sources already
 * arrive in `(day, position)` visit order), keeping only those with two real,
 * finite coordinates — the exact set the recap map can pin and connect. Generic
 * over any coordinate-bearing row (`ItineraryItem` or the public projection's
 * `PublicRecapPlace`) so one filter feeds both surfaces. Fewer than 2 results is
 * the signal to degrade to the stats-only recap with no empty map frame.
 */
export function locatedStops(
  items: Array<{
    id: string
    title: string
    latitude: number | null
    longitude: number | null
  }>,
): RecapStop[] {
  const out: RecapStop[] = []
  for (const it of items) {
    if (
      typeof it.latitude === 'number' &&
      Number.isFinite(it.latitude) &&
      typeof it.longitude === 'number' &&
      Number.isFinite(it.longitude)
    ) {
      out.push({ id: it.id, title: it.title, latitude: it.latitude, longitude: it.longitude })
    }
  }
  return out
}

/** The settle-up state of the trip, as the recap summarises it in one line. */
export interface RecapSettlement {
  /** At least one real, member-attributed expense exists to settle. */
  hasData: boolean
  /** Every member's net balance is effectively zero (nothing left to square up). */
  settled: boolean
  /** Minimal transfers still outstanding; 0 when settled or there's nothing to settle. */
  transfersLeft: number
}

/**
 * Inclusive whole-day length of the trip — a Fri–Sun trip is 3 days. `null`
 * when either endpoint is missing. Computed with plain UTC calendar math (like
 * `spans.ts`) so no DST/timezone drift and no date-fns dependency in the tested
 * module. A malformed range where `end` precedes `start` yields `null` rather
 * than a negative count.
 */
export function tripDayCount(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const toUTC = (iso: string): number => {
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  const ms = toUTC(end) - toUTC(start)
  if (ms < 0) return null
  return Math.round(ms / 86_400_000) + 1
}

/**
 * How many stops the trip had. Each `itinerary_items` row is exactly one stop,
 * however many days it spans — a multi-day stay (`end_day` set, see `spans.ts`)
 * is a single stop, not one-per-night. Counting rows therefore already excludes
 * the span double-counting that summing `coveredDays` across items would cause.
 */
export function stopCount(items: ItineraryItem[]): number {
  return items.length
}

/**
 * Total actually-spent across the trip, in the trip currency. Reuses the same
 * `tripActual` (`converted ?? raw`) roll-up as the Budget page and settle-up, so
 * a multi-currency trip totals correctly and the two screens can never disagree.
 * Only real (`actual`) spend counts — estimates are plans, not what the trip cost.
 */
export function totalSpend(entries: BudgetEntry[]): number {
  return entries.reduce((sum, e) => sum + (tripActual(e) ?? 0), 0)
}

/**
 * One-line settle-up state for the recap, derived from the same `computeBalances`
 * the Budget page settles on. When there's nothing member-attributed to settle,
 * the trip reads as settled with zero transfers rather than fabricating a debt.
 */
export function recapSettlement(
  entries: BudgetEntry[],
  members: Member[],
  repayments: Repayment[],
): RecapSettlement {
  if (!hasSettlementData(entries)) {
    return { hasData: false, settled: true, transfersLeft: 0 }
  }
  const balances = computeBalances(entries, members, repayments)
  const settled = isAllSettled(balances)
  return {
    hasData: true,
    settled,
    transfersLeft: settled ? 0 : minimalTransfers(balances).length,
  }
}
