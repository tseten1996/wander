import type { BudgetEntry } from '@/types'

/**
 * A budget entry's amounts expressed in the trip currency, which is what every
 * roll-up (totals, category bars, settlement) must operate on.
 *
 * For a foreign-currency entry the trip-currency value was frozen at entry time
 * in `*_converted`; for a trip-currency entry those are null and the raw amount
 * already is the trip-currency amount — hence `converted ?? raw`.
 */
export const tripEstimated = (e: BudgetEntry): number | null =>
  e.estimated_converted ?? e.estimated

export const tripActual = (e: BudgetEntry): number | null =>
  e.actual_converted ?? e.actual

/** True when the entry was logged in a currency other than the trip's. */
export const isForeignEntry = (e: BudgetEntry, tripCurrency: string): boolean =>
  !!e.currency && e.currency.toUpperCase() !== tripCurrency.toUpperCase()
