/*
  Zero-cost, keyless geo estimates for itinerary legs — slice 3 of the Map
  epic (#60). Everything here is pure client math: no network call, no API key,
  nothing to rate-limit or fail. The distance is a straight-line great-circle
  (haversine) estimate and the time is a coarse mode-based guess, so a leg hint
  can render the instant two consecutive stops both have coordinates.

  This is deliberately approximate. Straight-line distance under-reads real road
  distance, and a single average speed can't know traffic — the goal is only to
  answer "is stop 3 next door or across town?" while planning, the question the
  epic names as its North Star. A future slice can upgrade a single leg to real
  OSRM road routing behind this same shape; nothing here assumes it won't.
*/

export interface Coordinates {
  latitude: number
  longitude: number
}

/** How a leg is assumed to be travelled, chosen purely from its distance. */
export type TravelMode = 'walk' | 'drive'

export interface LegEstimate {
  /** Straight-line great-circle distance in kilometres. */
  distanceKm: number
  /** Rough travel time in minutes from the mode's average speed. */
  minutes: number
  mode: TravelMode
}

const EARTH_RADIUS_KM = 6371

// Below this straight-line distance a leg reads as walkable; above it we assume
// driving. A coarse split — the point is the order of magnitude, not precision.
const WALK_MAX_KM = 1.5
// Average speeds tuned to feel right for in-city planning. They're intentionally
// modest so the time doesn't read as optimistic against straight-line distance,
// which always under-reads the real route.
const WALK_SPEED_KMH = 4.8
const DRIVE_SPEED_KMH = 32

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * Great-circle distance in kilometres between two lat/lon points (haversine).
 * Symmetric and always ≥ 0; returns 0 for identical points.
 */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude)
  const dLon = toRadians(b.longitude - a.longitude)
  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  // Clamp to 1 before asin to stay finite against floating-point drift.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Estimate the leg between two located stops: straight-line distance plus a
 * coarse time from a mode-based average speed. Pure — no network, never throws.
 */
export function estimateLeg(from: Coordinates, to: Coordinates): LegEstimate {
  const distanceKm = haversineKm(from, to)
  const mode: TravelMode = distanceKm <= WALK_MAX_KM ? 'walk' : 'drive'
  const speed = mode === 'walk' ? WALK_SPEED_KMH : DRIVE_SPEED_KMH
  const minutes = (distanceKm / speed) * 60
  return { distanceKm, minutes, mode }
}

/** "820 m" under 1 km, "4.2 km" under 10, "37 km" beyond — no false precision. */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  if (km < 10) return `${km.toFixed(1)} km`
  return `${Math.round(km)} km`
}

/** "12 min", "<1 min" for a hair, "1 h 5 min" past the hour. */
export function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1 min'
  const rounded = Math.round(minutes)
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const mins = rounded % 60
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`
}
