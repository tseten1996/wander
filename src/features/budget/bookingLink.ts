import type { BudgetCategory } from '@/types'
import type { BudgetInput } from './api'

/** Round a major-currency amount to 2 decimal places, mirroring `toCents` in
 *  `@/lib/rates`. Inlined (not imported) so this stays a type-only-import module
 *  the Node test runner can exercise directly, like `itineraryLink.ts`. */
const round2 = (amount: number): number => Math.round((amount + Number.EPSILON) * 100) / 100

/**
 * Build a budget entry pre-filled from a booking's cost, ready to be created and
 * then linked back to the stay or transport hop that it paid for (#370, epic
 * #346). The counterpart to `budgetDraftFromItinerary` (#151).
 *
 * A booking cost is entered in the trip currency (the link control's amount box
 * uses `trip.currency`), so the draft is trip-currency only — no FX freezing,
 * none of the `*_converted` machinery. The amount seeds `estimated` (a recorded
 * planning figure), leaving `actual` and `paid_by` for the group to complete on
 * the Budget page — so a freshly linked cost is settle-up-neutral (an entry with
 * no `paid_by` owes no one, per settlement.ts) until someone says who paid. The
 * split defaults to everyone, equally (`participants: null`, `shares: null`),
 * exactly like a hand-entered expense.
 */
export function budgetDraftFromBooking(
  title: string,
  category: BudgetCategory,
  amount: number | null,
): BudgetInput {
  return {
    title,
    category,
    estimated: amount == null ? null : round2(amount),
    actual: null,
    currency: null,
    estimated_converted: null,
    actual_converted: null,
    exchange_rate: null,
    participants: null,
    shares: null,
    paid_by: null,
    entry_date: null,
    notes: null,
  }
}
