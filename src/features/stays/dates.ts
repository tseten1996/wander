/**
 * Stay-for-a-day derivation (#348, epic #346).
 *
 * A trip's `stays` each carry an OPTIONAL date window. A day belongs to whichever
 * stay's HALF-OPEN `[check_in, check_out)` contains it: you sleep at a place on
 * its check-in night through the night before check-out, but NOT on the
 * check-out morning (that day you sleep at the next place, or nowhere yet). This
 * is the one deliberate difference from `destinations/legs.ts`, whose leg range
 * is inclusive on both ends — a leg is "where you are", a stay is "where you
 * sleep", and the checkout day is the seam between two stays.
 *
 * Pure module: it imports only a `type`, so the built-in Node test runner can
 * exercise it directly (`tests/stays.test.mjs`) without resolving the `@/` alias
 * — the same discipline `legs.ts` follows.
 */
import type { Stay } from '@/types'

/** A stay that can actually cover days — it has both ends of its window. */
export function hasDates(s: Stay): boolean {
  return !!s.check_in && !!s.check_out
}

/**
 * The stay whose `[check_in, check_out)` contains an ISO `day`, or null when no
 * stay does. When windows overlap (a late checkout the same morning as the next
 * check-in cannot overlap under the half-open rule, but hand-entered dates can),
 * the earliest check-in wins, so `stays` is expected pre-sorted by `check_in`.
 * ISO date strings compare correctly with `<=` / `<`.
 */
export function stayForDay(day: string, stays: Stay[]): Stay | null {
  for (const s of stays) {
    if (s.check_in && s.check_out && day >= s.check_in && day < s.check_out) return s
  }
  return null
}
