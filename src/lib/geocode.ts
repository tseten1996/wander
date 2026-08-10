/*
  Free, keyless place lookup via Photon (komoot's public OpenStreetMap
  geocoder — https://photon.komoot.io). Used only for debounced autocomplete
  suggestions; the destination/location fields stay plain text underneath,
  so a slow, rate-limited, or unreachable geocoder just means no dropdown
  rather than a broken field.
*/

const PHOTON_URL = 'https://photon.komoot.io/api/'

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

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim()
  if (trimmed.length < 3) return []

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

  const url = `${PHOTON_URL}?q=${encodeURIComponent(trimmed)}&limit=1&lang=en`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`)
  return parseFirstCoords(await res.json())
}
