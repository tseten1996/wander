/*
  Nearby "things to do" — keyless POI discovery around a coordinate. Slice 1 of
  the "Discover things to do" epic (#164): turn the map from a mirror of what
  you already typed into a place you can *find* things to add.

  Free, no API key, no paid tier — the same zero-cost/no-key posture as the
  Photon geocoder (`geocode.ts`) and Open-Meteo weather (`weather.ts`); see
  docs/ARCHITECTURE.md §"No backend, no paid anything".

  Source decision — resolving epic #164's open question:
    OpenStreetMap via the **Overpass API**. Overpass returns rich, categorized
    POI tags around a point in a single bounded-radius query — exactly the
    "what's around here?" shape this needs — whereas Photon's categorized
    search is text-query-first and thin on "everything near this coordinate".
    Overpass's one real risk is that shared public instances rate-limit; we
    address that the keyless way the epic asked for by trying a short list of
    public mirrors in turn. If they all fail, every path throws so the caller's
    query lands in an error state the UI renders as a quiet "suggestions
    unavailable" — the map stays fully usable, exactly like weather/rates/
    geocode degrade today. Suggestions are always additive, never blocking.
*/

/** The three coarse buckets a found place falls into on the map. */
export type PoiCategory = 'eat' | 'see' | 'drink'

export interface NearbyPlace {
  /** Stable OSM identity ("node/123") — used as a React/marker key and to de-dupe. */
  id: string
  name: string
  category: PoiCategory
  lat: number
  lon: number
}

/** Short, human labels for the preview card (colour alone never carries meaning). */
export const POI_CATEGORY_LABEL: Record<PoiCategory, string> = {
  eat: 'Food',
  see: 'Sight',
  drink: 'Drinks',
}

// OSM tag → our bucket. Kept small and legible; anything unmatched is dropped
// rather than shown as an ambiguous pin. (Tag values per the OSM wiki.)
const EAT_AMENITY = new Set(['restaurant', 'cafe', 'fast_food', 'food_court', 'ice_cream'])
const DRINK_AMENITY = new Set(['bar', 'pub', 'biergarten'])
const SEE_TOURISM = new Set([
  'attraction', 'museum', 'viewpoint', 'gallery', 'artwork', 'zoo', 'theme_park', 'aquarium',
])

/**
 * Classify an OSM tag bag into one of our buckets, or null when it is not a
 * place worth suggesting. `amenity` (food/drink) is checked before `tourism`
 * so a café that is also tagged as an attraction still reads as "eat".
 */
export function categorizePoi(tags: Record<string, string> | undefined): PoiCategory | null {
  if (!tags) return null
  const { amenity, tourism } = tags
  if (amenity && EAT_AMENITY.has(amenity)) return 'eat'
  if (amenity && DRINK_AMENITY.has(amenity)) return 'drink'
  if (tourism && SEE_TOURISM.has(tourism)) return 'see'
  return null
}

interface OverpassElement {
  type?: string
  id?: number
  lat?: number
  lon?: number
  /** Ways/relations carry no top-level lat/lon; `out center` adds this. */
  center?: { lat?: number; lon?: number }
  tags?: Record<string, string>
}

/**
 * Turn a raw Overpass `elements` array into named, categorized, de-duplicated
 * places. Pure and defensive: any element that is unnamed, uncategorizable, or
 * missing finite coordinates is skipped, so a malformed response degrades to
 * fewer suggestions rather than throwing. De-dupes by OSM id and by
 * name+coarse-coords (chains, or a way and its node sharing a spot).
 */
export function parseOverpassElements(elements: unknown, limit = 24): NearbyPlace[] {
  if (!Array.isArray(elements)) return []
  const seen = new Set<string>()
  const places: NearbyPlace[] = []
  for (const raw of elements) {
    if (!raw || typeof raw !== 'object') continue
    const el = raw as OverpassElement
    const name = el.tags?.name?.trim()
    if (!name) continue
    const category = categorizePoi(el.tags)
    if (!category) continue

    const lat = typeof el.lat === 'number' ? el.lat : el.center?.lat
    const lon = typeof el.lon === 'number' ? el.lon : el.center?.lon
    if (
      typeof lat !== 'number' || typeof lon !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lon)
    ) continue

    const id = `${el.type ?? 'node'}/${el.id ?? `${lat},${lon}`}`
    const dedupeKey = `${category}:${name.toLowerCase()}@${lat.toFixed(4)},${lon.toFixed(4)}`
    if (seen.has(id) || seen.has(dedupeKey)) continue
    seen.add(id)
    seen.add(dedupeKey)

    places.push({ id, name, category, lat, lon })
    if (places.length >= limit) break
  }
  return places
}

/** Build the bounded-radius Overpass QL for eat/see/drink POIs around a point. */
export function buildOverpassQuery(
  { lat, lon }: { lat: number; lon: number },
  radiusMeters: number,
): string {
  const near = `(around:${Math.round(radiusMeters)},${lat},${lon})`
  return [
    '[out:json][timeout:15];',
    '(',
    `  nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|biergarten)$"]${near};`,
    `  nwr["tourism"~"^(attraction|museum|viewpoint|gallery|artwork|zoo|theme_park|aquarium)$"]${near};`,
    ');',
    'out center 80;',
  ].join('\n')
}

// Public, keyless Overpass mirrors, tried in order. When one rate-limits or is
// unreachable we fall through to the next; only when all fail does the caller
// see an error (→ "suggestions unavailable").
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

export interface NearbyOptions {
  /** Search radius in metres (default 1500 — a walkable neighbourhood). */
  radiusMeters?: number
  /** Cap on suggestions returned after categorize + de-dupe (default 24). */
  limit?: number
}

/**
 * Fetch categorized POIs around `center` from OpenStreetMap via Overpass,
 * trying each public mirror until one answers. Resolves to the parsed places
 * (possibly empty — a real "nothing here"); throws only when every mirror
 * fails or the request is aborted, so the calling TanStack Query degrades to a
 * quiet "suggestions unavailable" rather than breaking the map.
 */
export async function fetchNearbyPlaces(
  center: { lat: number; lon: number },
  { radiusMeters = 1500, limit = 24 }: NearbyOptions = {},
  signal?: AbortSignal,
): Promise<NearbyPlace[]> {
  const body = `data=${encodeURIComponent(buildOverpassQuery(center, radiusMeters))}`
  let lastError: unknown = new Error('Nearby suggestions unavailable')

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      })
      // 429 (rate-limited) / 504 (busy) are Overpass's "try again elsewhere"
      // signals — fall through to the next mirror instead of failing outright.
      if (!res.ok) {
        lastError = new Error(`Overpass returned ${res.status}`)
        continue
      }
      const data: unknown = await res.json()
      const elements =
        data && typeof data === 'object' ? (data as { elements?: unknown }).elements : undefined
      return parseOverpassElements(elements, limit)
    } catch (err) {
      // A caller-driven abort (navigated away / searched elsewhere) must
      // propagate immediately, not be masked as a mirror failure.
      if (signal?.aborted) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Nearby suggestions unavailable')
}
