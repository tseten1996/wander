import type { BudgetCategory, ItineraryCategory, ItineraryItem } from '@/types'
import type { BudgetInput } from './api'

/**
 * Best-fit budget category for an itinerary item's category (#151). The two
 * taxonomies don't line up one-to-one — itinerary splits travel into `flight`
 * and `transport`, budget folds both into `transport`; itinerary's `free` time
 * has no money bucket, so it lands in `other`.
 */
const CATEGORY_MAP: Record<ItineraryCategory, BudgetCategory> = {
  flight: 'transport',
  hotel: 'stay',
  activity: 'activities',
  restaurant: 'food',
  transport: 'transport',
  free: 'other',
}

export function itineraryCategoryToBudget(category: ItineraryCategory): BudgetCategory {
  return CATEGORY_MAP[category]
}

/**
 * Build a budget entry pre-filled from an itinerary item's cost, ready to be
 * created and then linked back to the item (#151).
 *
 * Itinerary costs are always entered in the trip currency (the item dialog's
 * Cost field uses `trip.currency`), so the draft is trip-currency only — no FX
 * freezing, none of the `*_converted` machinery. The amount seeds `estimated`
 * (a planned cost), leaving `actual` for what someone really pays later, and
 * the split defaults to everyone, equally (`participants: null`, `shares: null`)
 * exactly like a hand-entered expense.
 */
export function budgetDraftFromItinerary(item: ItineraryItem): BudgetInput {
  return {
    title: item.title,
    category: itineraryCategoryToBudget(item.category),
    estimated: item.cost,
    actual: null,
    currency: null,
    estimated_converted: null,
    actual_converted: null,
    exchange_rate: null,
    participants: null,
    shares: null,
    paid_by: null,
    entry_date: item.day,
    notes: null,
  }
}
