/**
 * Zero-cost geo helpers — slice 3 of the Map epic (#60). These answer the
 * epic's North Star ("how far apart is everything?") for a leg between two
 * consecutive itinerary stops, using only straight-line math and a coarse
 * speed heuristic. No network call, no API key, nothing that can rate-limit
 * or fail (guardrail 5: no backend, no paid anything).
 *
 * The distance is a great-circle (haversine) straight line — deliberately an
 * *estimate*, always rendered with a "~". A real road-routing upgrade (e.g. the
 * free OSRM demo endpoint) can later replace `estimateLeg` for a single leg
 * without touching its callers — that seam is why the display strings live in
 * `formatLeg` and the math is isolated here.
 *
 * This module intentionally imports nothing from `@/types` (it defines its own
 * `GeoPoint`) so it stays a pure, dependency-free unit the Node test runner can
 * import directly after stripping its types.
 */

/** A finite latitude/longitude pair, in decimal degrees. */
export interface GeoPoint {
  latitude: number
  longitude: number
}

/** How we assume a leg is travelled — drives the icon and the speed estimate. */
export type TravelMode = 'walk' | 'drive'

export interface LegEstimate {
  /** Great-circle distance in kilometres. */
  km: number
  /** Rough travel time in minutes (distance ÷ mode speed). */
  minutes: number
  /** Assumed mode of travel for this leg. */
  mode: TravelMode
}

const EARTH_RADIUS_KM = 6371

// Coarse average speeds. Deliberately conservative: a straight-line distance
// under-counts real roads, and a low urban speed compensates so the *time*
// estimate isn't wildly optimistic. These are heuristics, not promises — the
// "~" in the UI owns that.
const WALK_KMH = 4.8
const DRIVE_KMH = 30
// At or below this straight-line distance we assume you'd walk it.
const WALK_MAX_KM = 1.5

const toRad = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance between two points in kilometres (haversine). Pure
 * trig — no network, can't fail. Returns 0 for identical points.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Estimate the distance and rough travel time of a leg. Short hops are assumed
 * walked, longer ones driven; the time is straight-line distance over that
 * mode's average speed. Coarse by design (see module note).
 */
export function estimateLeg(from: GeoPoint, to: GeoPoint): LegEstimate {
  const km = haversineKm(from, to)
  const mode: TravelMode = km <= WALK_MAX_KM ? 'walk' : 'drive'
  const speedKmh = mode === 'walk' ? WALK_KMH : DRIVE_KMH
  const minutes = (km / speedKmh) * 60
  return { km, minutes, mode }
}

/**
 * Narrow a record with nullable coordinates to a finite `GeoPoint`, or `null`
 * when either coordinate is missing or non-finite. This is the single gate that
 * keeps unlocated items from ever producing a fabricated estimate.
 */
export function toGeoPoint(p: {
  latitude?: number | null
  longitude?: number | null
}): GeoPoint | null {
  const { latitude, longitude } = p
  if (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude)
  ) {
    return { latitude, longitude }
  }
  return null
}

/**
 * Human-readable strings for a leg estimate. Distance drops to metres under a
 * kilometre; time reads as minutes, rolling into hours past 60. Callers prefix
 * the "~" so the approximation is explicit and consistent.
 */
export function formatLeg(est: LegEstimate): { distance: string; duration: string } {
  const distance =
    est.km < 1
      ? `${Math.max(1, Math.round(est.km * 1000 / 10) * 10)} m`
      : `${est.km.toFixed(1)} km`

  const mins = Math.max(1, Math.round(est.minutes))
  let duration: string
  if (mins < 60) {
    duration = `${mins} min`
  } else {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    duration = m === 0 ? `${h} h` : `${h} h ${m} min`
  }
  return { distance, duration }
}
