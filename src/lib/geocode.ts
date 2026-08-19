/*
  Place lookup for the autocomplete dropdown and for pinning a typed address on
  save (#201).

  Two providers, in order (#257, epic #255):

    1. `/api/geocode` — Geoapify behind our own origin, so the key stays
       server-side and the response is edge-cached.
    2. Photon (komoot's public OpenStreetMap geocoder) — free, keyless, and
       what this module was before #257.

  The second is not a legacy path awaiting removal. It is what makes a missing
  key, an exhausted quota, or the GitHub Pages origin (which has no /api/*)
  cost resolution *quality* rather than the feature. Either way the
  destination/location fields stay plain text underneath, so a slow or
  unreachable geocoder means no dropdown rather than a broken field.
*/

const PHOTON_URL = 'https://photon.komoot.io/api/'

/**
 * The cache key for a place query.
 *
 * Lowercased and whitespace-collapsed so `Kyoto`, `kyoto`, and `  Kyoto ` are
 * one cached lookup instead of three. This is the cheapest credit saving
 * available on a metered provider: within one trip the same few destinations
 * get typed over and over, with different capitalisation every time.
 *
 * It lives here, in the module that already imports nothing, because three
 * separate caches must agree on it — the browser's in-memory suggestion cache,
 * the edge cache keyed on the request URL, and the upstream query itself. Two
 * normalisers that drift would silently halve the hit rate on all of them.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface PlaceSuggestion {
  label: string
  lat: number
  lon: number
}

/** A resolved coordinate pair, in the app's [lat, lon] convention. */
export interface Coords {
  lat: number
  lon: number
}

interface PhotonProperties {
  name?: string
  city?: string
  county?: string
  state?: string
  country?: string
}

/** The `features` array of a Photon FeatureCollection, or [] for junk input. */
function featuresOf(data: unknown): unknown[] {
  return data && typeof data === 'object' && Array.isArray((data as { features?: unknown }).features)
    ? (data as { features: unknown[] }).features
    : []
}

/** Pull a usable [lat, lon] out of one Photon feature, or null if malformed. */
function coordsOf(feature: unknown): Coords | null {
  if (!feature || typeof feature !== 'object') return null
  const { geometry } = feature as { geometry?: unknown }
  const coords =
    geometry && typeof geometry === 'object' ? (geometry as { coordinates?: unknown }).coordinates : undefined
  if (!Array.isArray(coords) || coords.length < 2) return null
  const [lon, lat] = coords
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  return { lat, lon }
}

/**
 * First usable coordinate pair from a Photon response, or null when nothing
 * matched. Pure and network-free so it can be unit-tested directly.
 */
export function parseFirstCoords(data: unknown): Coords | null {
  for (const feature of featuresOf(data)) {
    const coords = coordsOf(feature)
    if (coords) return coords
  }
  return null
}

export function formatPlaceLabel(props: PhotonProperties): string {
  const parts = [props.name, props.city ?? props.county, props.state, props.country]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const part of parts) {
    if (!part || seen.has(part)) continue
    seen.add(part)
    unique.push(part)
  }
  return unique.join(', ')
}

/**
 * Whether `/api/geocode` has told us it has no key configured. Sticky for the
 * session for the same reason as places.ts — it is a fact about the deployment,
 * and re-checking it per keystroke is latency on the degraded path.
 */
let endpointUnavailable = false

/** Test seam — the flag is session state, and a test should not inherit it. */
export function resetGeocodeEndpointState(): void {
  endpointUnavailable = false
}

/**
 * Ask our own endpoint, or null for every "use Photon instead" outcome.
 *
 * Never throws except on abort: a caller that navigated away must not have a
 * fallback request issued on its behalf.
 */
async function viaEndpoint(query: string, params: string, signal?: AbortSignal): Promise<unknown | null> {
  if (endpointUnavailable) return null
  try {
    // Normalised so the edge cache key matches for every capitalisation and
    // spacing of the same place — the provider bills per request, and within
    // one trip the same few destinations get typed over and over.
    const q = encodeURIComponent(normalizeQuery(query))
    const res = await fetch(`/api/geocode?q=${q}&${params}`, { signal })
    if (res.status === 501) {
      endpointUnavailable = true
      return null
    }
    if (!res.ok) return null
    return await res.json()
  } catch (err) {
    if (signal?.aborted) throw err
    endpointUnavailable = true
    return null
  }
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim()
  if (trimmed.length < 3) return []

  const answer = await viaEndpoint(trimmed, 'limit=6', signal)
  if (answer && typeof answer === 'object') {
    const suggestions = (answer as { suggestions?: unknown }).suggestions
    if (Array.isArray(suggestions)) return suggestions as PlaceSuggestion[]
  }

  const url = `${PHOTON_URL}?q=${encodeURIComponent(trimmed)}&limit=6&lang=en`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`)
  const data: unknown = await res.json()

  const seen = new Set<string>()
  const suggestions: PlaceSuggestion[] = []
  for (const feature of featuresOf(data)) {
    const coords = coordsOf(feature)
    if (!coords) continue
    const { properties } = feature as { properties?: unknown }
    const label = formatPlaceLabel((properties ?? {}) as PhotonProperties)
    if (!label || seen.has(label)) continue
    seen.add(label)
    suggestions.push({ label, lat: coords.lat, lon: coords.lon })
  }
  return suggestions
}

/**
 * Best-effort geocode of a free-text address to its single most likely point.
 * Backs "pin a typed address on save" (#201): when a user types a real address
 * but never clicks an autocomplete suggestion, the caller resolves it here so
 * the item still lands on the map. Returns null when nothing matches; throws
 * only on a network/HTTP failure, which the caller treats as "save unpinned".
 */
export async function geocodeFirst(query: string, signal?: AbortSignal): Promise<Coords | null> {
  const trimmed = query.trim()
  if (trimmed.length < 3) return null

  const answer = await viaEndpoint(trimmed, 'mode=one', signal)
  if (answer && typeof answer === 'object') {
    const coords = (answer as { coords?: unknown }).coords
    // `coords: null` is a real answer — "we looked, nothing matched" — and must
    // not fall through to Photon as if the endpoint had failed. Only an absent
    // key or a failed call reaches the fallback.
    if (coords === null) return null
    if (coords && typeof coords === 'object') return coords as Coords
  }

  const url = `${PHOTON_URL}?q=${encodeURIComponent(trimmed)}&limit=1&lang=en`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`)
  return parseFirstCoords(await res.json())
}
