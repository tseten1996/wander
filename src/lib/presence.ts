import type { Member, Trip } from '@/types'

/*
  Member arrival/departure dates (#286). Pure date helpers shared by the
  calendar day cells, the "who's here today" header, and any future presence
  surface. Dates are `yyyy-MM-dd` strings, which compare correctly with plain
  string `<=`/`>=`, so no Date parsing is needed here.

  A member with no dates set means "here for the whole trip", so their
  effective window falls back to the trip's own [start_date, end_date]. A null
  bound (member or trip) is treated as unbounded on that side.
*/

/** True once at least one member has set an arrival or departure date. Until
 *  then every presence surface stays hidden, so a trip that never uses dates
 *  looks exactly as it did before this feature. */
export function hasPresenceDates(members: Member[]): boolean {
  return members.some((m) => m.arrives_on || m.departs_on)
}

type TripRange = Pick<Trip, 'start_date' | 'end_date'>

/** Members present on a given `yyyy-MM-dd`, each bounded by their own dates or,
 *  where unset, by the trip's range. A member with no dates on a trip with no
 *  dates counts as always present. */
export function presentOn(members: Member[], day: string, trip: TripRange): Member[] {
  return members.filter((m) => {
    const from = m.arrives_on ?? trip.start_date
    const to = m.departs_on ?? trip.end_date
    return (from === null || from <= day) && (to === null || day <= to)
  })
}

/**
 * The participants to pre-select for an expense dated `day` (#304, epic #285
 * slice 2). Returns the ids — in member order — of the members present on that
 * date, so a cost logged on a staggered day defaults to whoever was actually
 * there instead of the whole group.
 *
 * Falls back to *all* members — the historic "shared by everyone" default
 * (`participants: null` in `settlement.ts`) — whenever the answer isn't
 * knowable or wouldn't narrow anything: no `day`, no member has set dates, or
 * the date lands outside every member's window (an empty split would be an
 * invalid, un-saveable selection). This keeps a trip that never uses presence
 * dates behaving exactly as before.
 *
 * Purely a suggestion: the caller seeds an overridable picker with it and writes
 * nothing until the user saves.
 */
export function suggestedParticipants(
  members: Member[],
  day: string | null | undefined,
  trip: TripRange,
): string[] {
  const all = members.map((m) => m.id)
  if (!day || !hasPresenceDates(members)) return all
  const present = presentOn(members, day, trip).map((m) => m.id)
  return present.length > 0 ? present : all
}

/** Members whose explicit arrival is exactly `day` (undated members excluded —
 *  an arrival is only shown when someone actually stated it). */
export function arrivalsOn(members: Member[], day: string): Member[] {
  return members.filter((m) => m.arrives_on === day)
}

/** Members whose explicit departure is exactly `day`. */
export function departuresOn(members: Member[], day: string): Member[] {
  return members.filter((m) => m.departs_on === day)
}
