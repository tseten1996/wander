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

interface PhotonProperties {
  name?: string
  city?: string
  county?: string
  state?: string
  country?: string
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
  const features =
    data && typeof data === 'object' && Array.isArray((data as { features?: unknown }).features)
      ? (data as { features: unknown[] }).features
      : []

  const seen = new Set<string>()
  const suggestions: PlaceSuggestion[] = []
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue
    const { geometry, properties } = feature as { geometry?: unknown; properties?: unknown }
    const coords =
      geometry && typeof geometry === 'object' ? (geometry as { coordinates?: unknown }).coordinates : undefined
    if (!Array.isArray(coords) || coords.length < 2) continue
    const [lon, lat] = coords
    if (typeof lon !== 'number' || typeof lat !== 'number') continue

    const label = formatPlaceLabel((properties ?? {}) as PhotonProperties)
    if (!label || seen.has(label)) continue
    seen.add(label)
    suggestions.push({ label, lat, lon })
  }
  return suggestions
}
