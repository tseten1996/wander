/**
 * "During the trip" dashboard derivations (#281). When today falls inside a
 * trip's dates the dashboard leads with a Today card instead of the planning
 * countdown; these pure helpers decide the trip phase and pick today's items in
 * the order they happen. Kept dependency-light (only the erased `import type`
 * plus the pure span helpers) so the Node test runner imports it directly after
 * type-stripping, matching `spans.ts` / `recap.ts`.
 */
import type { ItineraryItem } from '@/types'
import { isSpanning } from '../itinerary/spans'

/**
 * Where an ISO `today` (`YYYY-MM-DD`) sits relative to a trip's dates. `during`
 * is inclusive of both the start and end day — the group is on the trip. A trip
 * missing either date is `undated` and keeps the planning view unchanged. ISO
 * date strings compare lexicographically, so plain `<` / `>` are calendar-correct.
 */
export type TripPhase = 'before' | 'during' | 'after' | 'undated'

export function tripPhase(
  startDate: string | null,
  endDate: string | null,
  today: string,
): TripPhase {
  if (!startDate || !endDate) return 'undated'
  if (today < startDate) return 'before'
  if (today > endDate) return 'after'
  return 'during'
}

/**
 * Single-day itinerary items scheduled for `today`, in the order they happen:
 * timed items first in ascending start-time order, then untimed items in their
 * saved position. Multi-day spans (#166) are excluded — they render as their
 * own bands above the list, exactly as on the itinerary page.
 */
export function todaysItems(items: ItineraryItem[], today: string): ItineraryItem[] {
  return items
    .filter((i) => !isSpanning(i) && i.day === today)
    .sort(byTimeThenPosition)
}

function byTimeThenPosition(a: ItineraryItem, b: ItineraryItem): number {
  if (a.start_time && b.start_time) {
    return a.start_time.localeCompare(b.start_time) || a.position - b.position
  }
  // A timed item sorts before an untimed one; two untimed keep their position.
  if (a.start_time) return -1
  if (b.start_time) return 1
  return a.position - b.position
}

/**
 * The id of the next item still ahead of `nowTime` (an ISO `HH:mm[:ss]`) among
 * today's items, or null when every timed item has already started (or none
 * carries a time). `items` is expected pre-sorted by `todaysItems`, so the
 * first item whose start time hasn't passed is the next one up.
 */
export function nextUpcomingId(items: ItineraryItem[], nowTime: string): string | null {
  const next = items.find((i) => i.start_time != null && i.start_time >= nowTime)
  return next?.id ?? null
}
