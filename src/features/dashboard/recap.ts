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
