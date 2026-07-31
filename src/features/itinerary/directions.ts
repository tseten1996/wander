/**
 * "Directions for this day" — a pure link builder (#167). It turns a day's
 * ordered, geocoded stops into a single multi-stop Google Maps Directions URL,
 * so a group can *follow the day's route* (stop 1 → 2 → 3) with real turn-by-turn
 * in the maps app they already use — instead of copying each pin across by hand
 * and rebuilding a sequence Wander already knows.
 *
 * It is a pure function over data the app already holds: no new storage, no
 * network call, no API key (guardrail 5 — no backend, no paid anything). Like
 * `src/lib/geo.ts`, this module imports nothing from `@/types`, so the Node test
 * runner can import it directly after stripping the types.
 */

/** A stop that carries real coordinates — the shape a route waypoint needs. */
export interface RouteStop {
  latitude: number
  longitude: number
}

/**
 * Google Maps' `dir/?api=1` scheme accepts an origin, a destination, and up to
 * nine intermediate `waypoints` — so a single route carries at most eleven
 * stops. A day longer than that is truncated to the first eleven in itinerary
 * order, and callers surface the shortfall (see `buildDayDirections`) rather
 * than silently dropping the tail.
 */
export const MAX_ROUTE_STOPS = 11

/** Travel modes Google Maps understands; driving is the sensible default. */
export type DirectionsTravelMode = 'driving' | 'walking' | 'bicycling' | 'transit'

function isFiniteCoord(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Keep only the items that carry finite coordinates, preserving the order they
 * arrive in (the itinerary is already day-then-position ordered). An item
 * missing either coordinate is dropped, never guessed — the single gate that
 * keeps an unlocated stop out of the route.
 */
export function locatedStops<
  T extends { latitude?: number | null; longitude?: number | null },
>(items: T[]): (T & RouteStop)[] {
  return items.filter(
    (i): i is T & RouteStop => isFiniteCoord(i.latitude) && isFiniteCoord(i.longitude)
  )
}

/** `lat,lng` rounded to ~0.1 m precision — enough to pin a doorway, tidy in a URL. */
function coord(stop: RouteStop): string {
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6
  return `${round6(stop.latitude)},${round6(stop.longitude)}`
}

/**
 * Build a Google Maps multi-stop Directions URL from stops in route order, or
 * `null` when there are fewer than two (no route to draw). Only the first
 * `MAX_ROUTE_STOPS` are used: the first stop is the origin, the last is the
 * destination, and everything between becomes `waypoints`, so the maps app opens
 * the day as one continuous route. Coordinates only contain URL-safe query
 * characters; the sole separator that needs escaping is the waypoint pipe (→ %7C).
 */
export function googleMapsDirectionsUrl(
  stops: RouteStop[],
  travelmode: DirectionsTravelMode = 'driving'
): string | null {
  if (stops.length < 2) return null
  const route = stops.slice(0, MAX_ROUTE_STOPS)
  const origin = coord(route[0])
  const destination = coord(route[route.length - 1])
  const between = route.slice(1, -1).map(coord)

  const params = [
    'api=1',
    `origin=${origin}`,
    `destination=${destination}`,
    `travelmode=${travelmode}`,
  ]
  if (between.length > 0) params.push(`waypoints=${between.join('%7C')}`)
  return `https://www.google.com/maps/dir/?${params.join('&')}`
}

/** A day's route plus an honest count of how much of the day it covers. */
export interface DayDirections {
  /** The multi-stop Google Maps Directions URL for the day, in itinerary order. */
  url: string
  /** Geocoded stops actually placed on the route (capped at `MAX_ROUTE_STOPS`). */
  included: number
  /** Total items on the day, geocoded or not. */
  total: number
  /** True when some items were left off the route (no coordinates, or over the cap). */
  omitted: boolean
}

/**
 * Summarise a day's directions for the UI, or `null` when the day has fewer than
 * two geocoded stops (nothing to route — the action stays hidden). `included`
 * vs `total` lets the caller be honest about a partially-geocoded day instead of
 * silently opening a short route.
 */
export function buildDayDirections<
  T extends { latitude?: number | null; longitude?: number | null },
>(items: T[]): DayDirections | null {
  const located = locatedStops(items)
  const url = googleMapsDirectionsUrl(located)
  if (!url) return null
  const included = Math.min(located.length, MAX_ROUTE_STOPS)
  return {
    url,
    included,
    total: items.length,
    omitted: included < items.length,
  }
}
