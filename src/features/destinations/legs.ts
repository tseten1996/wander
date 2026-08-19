/**
 * Leg-grouping derivation for multi-destination trips (#197, epic #196).
 *
 * A trip's `destinations` are ordered legs, each with an OPTIONAL date range.
 * A scheduled day belongs to whichever leg's `[start_date, end_date]` contains
 * it. This module is the single, pure source of that mapping so the itinerary
 * timeline and the calendar group days identically — "one derivation, two
 * views", the same discipline `days.ts` follows for day numbering.
 *
 * Pure module: it imports only a `type`, so the built-in Node test runner can
 * exercise it directly (`tests/legs.test.mjs`) — Node strips the erased type
 * import and never has to resolve the `@/` alias. Label/colour formatting that
 * needs `@/lib` helpers lives in `route.ts`, keeping this file dependency-free.
 */
import type { Destination } from '@/types'
import type { DailyWeather } from '@/lib/weather'

/** A leg that can actually contain calendar days — it has a full date range.
 *  A leg with a name but no (or half a) range is still shown in the route, but
 *  can't own any day. */
export function hasRange(d: Destination): boolean {
  return !!d.start_date && !!d.end_date
}

/** True when the trip has at least one leg that owns days — the switch that
 *  turns on leg grouping in the itinerary and calendar. */
export function hasLegs(destinations: Destination[]): boolean {
  return destinations.some(hasRange)
}

/**
 * The leg whose `[start_date, end_date]` contains an ISO `day`, or null when no
 * leg does. `destinations` is expected pre-sorted by `position`; the first
 * match wins if ranges overlap, so the earlier leg in the route takes the day.
 * ISO date strings compare correctly with `<=` / `>=`.
 */
export function legForDay(day: string, destinations: Destination[]): Destination | null {
  for (const d of destinations) {
    if (d.start_date && d.end_date && day >= d.start_date && day <= d.end_date) return d
  }
  return null
}

export interface DayLegGroup {
  /** Stable React key for the group. */
  key: string
  /** The leg these days belong to, or null for an "Unassigned" run. */
  leg: Destination | null
  /** The ISO day strings in this run, in the order they were given. */
  days: string[]
}

/**
 * Groups an ordered list of ISO day strings into consecutive runs by the leg
 * that contains each day.
 *
 * - When no leg defines a usable range (`hasLegs` is false), returns a single
 *   null-leg group holding every day, so callers render a FLAT list exactly as
 *   before — the backward-compatibility contract.
 * - Otherwise, each maximal run of same-leg days becomes a group, and days that
 *   fall in no leg's range collect into "Unassigned" runs (`leg: null`). No day
 *   is ever dropped.
 *
 * Callers decide whether to show a header per group by checking `hasLegs`
 * themselves: a flat trip shows none; a legged trip labels every group.
 */
export function groupDaysByLeg(sortedDays: string[], destinations: Destination[]): DayLegGroup[] {
  if (!hasLegs(destinations)) {
    return sortedDays.length ? [{ key: 'all', leg: null, days: [...sortedDays] }] : []
  }
  const groups: DayLegGroup[] = []
  for (const day of sortedDays) {
    const leg = legForDay(day, destinations)
    const last = groups[groups.length - 1]
    // Same leg as the previous day (both null counts as the same Unassigned
    // run) extends the current group; anything else starts a new one.
    if (last && (last.leg?.id ?? null) === (leg?.id ?? null)) {
      last.days.push(day)
    } else {
      groups.push({ key: leg ? `leg-${leg.id}-${day}` : `unassigned-${day}`, leg, days: [day] })
    }
  }
  return groups
}

/** One leg's fetched forecast — the ranged, geocoded legs paired with their
 *  daily weather (empty when the leg's window fell outside the forecast
 *  horizon). */
export interface LegForecast {
  leg: Destination
  days: DailyWeather[]
}

/**
 * Merge per-leg forecasts and the single trip-destination forecast into one
 * `YYYY-MM-DD → DailyWeather` map, so a day in Kyoto shows Kyoto's weather
 * rather than the trip's one destination (#249, epic #196).
 *
 * The rules, in priority order:
 * - A day owned by a leg takes **that leg's** forecast. `legForecasts` is in
 *   route order, so the earliest leg wins any overlap (matching `legForDay`).
 * - A day owned by any ranged leg **never** borrows the trip default — a leg
 *   with no coordinates, or one whose days fall beyond the ~16-day horizon,
 *   simply has no entry (the UI reads "weather unavailable") instead of
 *   silently showing a different city's forecast.
 * - A day in no leg's range falls back to the trip-destination forecast (or,
 *   if that too has no entry, to nothing).
 *
 * With no ranged legs this returns exactly the trip-default map, so a
 * single-destination (or legless) trip behaves precisely as before.
 */
export function mergeLegWeather(
  tripDays: DailyWeather[],
  legForecasts: LegForecast[],
  rangedLegs: Destination[],
): Map<string, DailyWeather> {
  const map = new Map<string, DailyWeather>()
  // Legs first, in route order — the earliest leg claims a shared day.
  for (const { days } of legForecasts) {
    for (const d of days) {
      if (!map.has(d.date)) map.set(d.date, d)
    }
  }
  // Trip default fills only the days no ranged leg owns; a leg-owned day with
  // no forecast stays absent rather than borrowing another leg's city.
  for (const d of tripDays) {
    if (map.has(d.date)) continue
    if (rangedLegs.length && legForDay(d.date, rangedLegs)) continue
    map.set(d.date, d)
  }
  return map
}
