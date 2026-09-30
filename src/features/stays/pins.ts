/**
 * Stay map-pin derivation (#371, epic #346).
 *
 * A trip's `stays` each carry an OPTIONAL geocoded pin — the same Photon/komoot
 * `latitude`/`longitude` the itinerary map uses. This module narrows the list to
 * the stays that can actually be drawn: a stay is "located" only when both
 * coordinates are real, finite numbers. A dateless or address-only stay simply
 * has no pin and is left off the map (no error, no empty marker).
 *
 * Pure module: it imports only an erased `type`, so the built-in Node test runner
 * exercises it directly (`tests/stays-pins.test.mjs`) without resolving the `@/`
 * alias — the same discipline `dates.ts` and `legs.ts` follow.
 */
import type { Stay } from '@/types'

/** A stay with a real, finite geocoded pin — the only ones the map can draw. */
export type LocatedStay = Stay & { latitude: number; longitude: number }

/** Whether a stay carries a real, finite coordinate pair (a drawable pin). */
export function hasPin(stay: Stay): stay is LocatedStay {
  return (
    typeof stay.latitude === 'number' &&
    typeof stay.longitude === 'number' &&
    Number.isFinite(stay.latitude) &&
    Number.isFinite(stay.longitude)
  )
}

/** The subset of stays that have a pin, preserving the input order. */
export function staysWithPin(stays: Stay[]): LocatedStay[] {
  return stays.filter(hasPin)
}
