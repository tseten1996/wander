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
