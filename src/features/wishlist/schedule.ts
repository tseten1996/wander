import { eachDayOfInterval, format, parseISO } from 'date-fns'
import type { ItineraryCategory, WishlistCategory } from '@/types'

/**
 * Scheduling a wishlist place onto a day (#377, epic #164 slice 3) — the pure
 * helpers behind the "Add to a day" action. Kept free of React/Supabase so the
 * mapping and the day enumeration can be exercised directly by the Node test
 * runner (types are erased on import), matching the itinerary's own `spans.ts`.
 */

/**
 * How a saved place's category seeds the created itinerary item's type. The
 * wishlist buckets (`eat` / `see` / `drink` / `other`) are coarser than the
 * itinerary's types, so this mirrors slice 1's map "Add to itinerary" choice
 * (`see → activity`, a found eatery → `restaurant`) and extends it: a `drink`
 * spot is a place you sit down at, so `restaurant`; an `other`/uncategorised
 * save has no better signal than a generic `activity`. It is only a *prefill* —
 * the day picker lets the scheduler change the type before confirming.
 */
export const WISHLIST_TO_ITINERARY: Record<WishlistCategory, ItineraryCategory> = {
  eat: 'restaurant',
  drink: 'restaurant',
  see: 'activity',
  other: 'activity',
}

/** The itinerary type to prefill for a saved place; `activity` for a null (truly
 *  uncategorised) save, the safe generic. */
export function itineraryCategoryFor(category: WishlistCategory | null): ItineraryCategory {
  return category ? WISHLIST_TO_ITINERARY[category] : 'activity'
}

/**
 * The trip's days as `yyyy-MM-dd` strings, in chronological order, for the day
 * picker. Empty when either end of the trip's range is unset (a dateless trip
 * has no days to enumerate — the picker falls back to a free date field) or the
 * range is inverted (defensive: the create flow guards against it too).
 */
export function tripScheduleDays(
  start: string | null | undefined,
  end: string | null | undefined,
): string[] {
  if (!start || !end) return []
  const from = parseISO(start)
  const to = parseISO(end)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return []
  return eachDayOfInterval({ start: from, end: to }).map((d) => format(d, 'yyyy-MM-dd'))
}
