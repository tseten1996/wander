import type { ItineraryItem } from '@/types'

/**
 * Multi-day itinerary items (#166). Lodging that spans several nights — and any
 * continuous multi-day thing (a rail pass, a car rental, a festival) — carries
 * an optional `end_day` beyond its start `day`. This module is the single place
 * that answers "does this item span days, and which days does it cover", so the
 * list, the map, the overlap check, and the leg-distance math all agree.
 *
 * Pure and dependency-free (only the erased `import type`), so the Node test
 * runner imports it directly after stripping the types — matching `days.ts` /
 * `overlap.ts`.
 */

/** Shape the span helpers read — the temporal-extent fields of an item. */
export interface Span {
  day: string | null
  end_day?: string | null
}

/**
 * A defence-in-depth ceiling on how many days one item may cover. A real trip
 * is at most a few weeks; this only exists so a typo'd `end_day` (year 3000)
 * can never build an unbounded array. ISO date strings compare lexically, so
 * the loop below also stops at `end_day` — the cap is the backstop, not the
 * normal exit.
 */
const MAX_SPAN_DAYS = 366

/** True when the item occupies more than its start day (a real multi-day span). */
export function isSpanning(item: Span): boolean {
  return !!item.day && !!item.end_day && item.end_day > item.day
}

/** Shift an ISO `YYYY-MM-DD` by whole days in UTC, so no DST/TZ drift. */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/**
 * Every ISO day this item occupies, inclusive and in chronological order:
 * a single-day dated item → `[day]`; a spanning item → `[day … end_day]`; an
 * undated item → `[]`. Capped at `MAX_SPAN_DAYS` so a bad end_day can't produce
 * an unbounded array.
 */
export function coveredDays(item: Span): string[] {
  if (!item.day) return []
  if (!isSpanning(item)) return [item.day]
  const end = item.end_day as string
  const days: string[] = []
  let cur = item.day
  for (let i = 0; i < MAX_SPAN_DAYS && cur <= end; i++) {
    days.push(cur)
    cur = addDays(cur, 1)
  }
  return days
}

/** Where a covered `day` sits within a spanning item: 1-based `index` of
 *  `total` covered days. `null` when the item is single-day or doesn't cover
 *  `day` — the caller then renders it as an ordinary row, not a span band. */
export function spanPosition(
  item: Span,
  day: string
): { index: number; total: number } | null {
  if (!isSpanning(item)) return null
  const days = coveredDays(item)
  const index = days.indexOf(day)
  if (index === -1) return null
  return { index: index + 1, total: days.length }
}

/** The spanning items (if any) that cover `day`, in the order they arrive. */
export function spansCovering(items: ItineraryItem[], day: string): ItineraryItem[] {
  return items.filter((i) => isSpanning(i) && coveredDays(i).includes(day))
}
