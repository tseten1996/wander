/*
  Geoapify request builders and response mappers (#255).

  Runtime-agnostic and free of I/O on purpose: everything here is a pure
  function from inputs to a URL, or from a parsed body to Wander's own shapes.
  That is what lets the Node test runner cover the category mapping and the
  defensive parsing without a network or a Workers environment — the same
  split that keeps src/server/ai/ testable.

  WHY A KEYED PROVIDER AT ALL. Photon and Overpass are free public instances of
  open-source software, chosen because a static site had nowhere to keep a
  secret. `functions/api/` removed that constraint. Geoapify was picked over a
  larger free tier because its terms permit *storing* results — Wander writes
  geocoded coordinates into Postgres and keeps them, which most commercial
  providers forbid outright.

  The keyless paths are NOT replaced. Every caller falls back to them, so a
  missing key, an exhausted quota or a provider outage costs quality, never the
  feature. See docs/ARCHITECTURE.md and issue #255.
*/
import type { NearbyPlace, PoiCategory } from '../../lib/places'
import type { Coords, PlaceSuggestion } from '../../lib/geocode'

const PLACES_URL = 'https://api.geoapify.com/v2/places'
const AUTOCOMPLETE_URL = 'https://api.geoapify.com/v1/geocode/autocomplete'
const SEARCH_URL = 'https://api.geoapify.com/v1/geocode/search'

/**
 * Geoapify's category namespaces, mapped onto Wander's three buckets.
 *
 * Deliberately a *second* table rather than a replacement for the OSM tag
 * mapping in places.ts: the Overpass fallback still needs the original, and a
 * shared abstraction over two genuinely different vocabularies would be more
 * indirection than either one costs.
 *
 * Matching is by prefix because Geoapify returns a hierarchy — a restaurant
 * comes back as ["catering", "catering.restaurant"] — so `catering.restaurant`
 * matches the leaf and `catering.bar` cannot be mistaken for it.
 */
const CATEGORY_PREFIXES: { prefix: string; bucket: PoiCategory }[] = [
  // Drink is listed before the broader eat prefixes: a pub is `catering.pub`,
  // which would otherwise be swallowed by a bare `catering` match.
  { prefix: 'catering.bar', bucket: 'drink' },
  { prefix: 'catering.pub', bucket: 'drink' },
  { prefix: 'catering.biergarten', bucket: 'drink' },
  { prefix: 'catering.restaurant', bucket: 'eat' },
  { prefix: 'catering.cafe', bucket: 'eat' },
  { prefix: 'catering.fast_food', bucket: 'eat' },
  { prefix: 'catering.food_court', bucket: 'eat' },
  { prefix: 'catering.ice_cream', bucket: 'eat' },
  { prefix: 'entertainment.museum', bucket: 'see' },
  { prefix: 'entertainment.zoo', bucket: 'see' },
  { prefix: 'entertainment.aquarium', bucket: 'see' },
  { prefix: 'entertainment.theme_park', bucket: 'see' },
  { prefix: 'entertainment.culture.gallery', bucket: 'see' },
  { prefix: 'tourism.attraction', bucket: 'see' },
  { prefix: 'tourism.sights', bucket: 'see' },
]

/** The categories requested from the API — exactly the ones we can classify. */
export const REQUESTED_CATEGORIES = CATEGORY_PREFIXES.map((c) => c.prefix).join(',')

/**
 * Classify a Geoapify category list into one of Wander's buckets, or null when
 * it is not a place worth suggesting.
 *
 * Food/drink is resolved before sights so a museum café reads as "eat", which
 * is the same precedence `categorizePoi` applies to OSM tags.
 */
export function categorizeGeoapify(categories: unknown): PoiCategory | null {
  if (!Array.isArray(categories)) return null
  const values = categories.filter((c): c is string => typeof c === 'string')
  for (const { prefix, bucket } of CATEGORY_PREFIXES) {
    if (values.some((v) => v === prefix || v.startsWith(`${prefix}.`))) return bucket
  }
  return null
}

/**
 * The Places request for one snapped centre.
 *
 * NOTE THE COORDINATE ORDER: Geoapify's `circle:` and `proximity:` filters take
 * **longitude first**, the opposite of every internal helper in this repo, which
 * uses `{ lat, lon }` throughout. Getting this backwards does not error — it
 * silently searches the wrong hemisphere — so it is spelled out rather than
 * inlined.
 */
export function buildPlacesUrl(
  center: { lat: number; lon: number },
  { radiusMeters, limit }: { radiusMeters: number; limit: number },
  apiKey: string,
): string {
  const params = new URLSearchParams({
    categories: REQUESTED_CATEGORIES,
    filter: `circle:${center.lon},${center.lat},${Math.round(radiusMeters)}`,
    bias: `proximity:${center.lon},${center.lat}`,
    limit: String(limit),
    apiKey,
  })
  return `${PLACES_URL}?${params}`
}

/** The `features` array of a GeoJSON FeatureCollection, or [] for junk input. */
function featuresOf(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return []
  const features = (data as { features?: unknown }).features
  return Array.isArray(features) ? features : []
}

function propsOf(feature: unknown): Record<string, unknown> | null {
  if (!feature || typeof feature !== 'object') return null
  const props = (feature as { properties?: unknown }).properties
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Turn a Places FeatureCollection into Wander's own `NearbyPlace[]`.
 *
 * Defensive in the same way `parseOverpassElements` is: anything unnamed,
 * uncategorizable or missing finite coordinates is skipped, so a surprising
 * response degrades to fewer suggestions rather than throwing.
 *
 * Ids are prefixed `geoapify/` because the two sources must never collide. A
 * cached Geoapify response and an Overpass fallback response can both be on
 * screen across a session, and `NearbyPlace.id` is the React key and the
 * de-dupe key — an unprefixed `place_id` colliding with an OSM `node/123` is
 * unlikely but silent, which is the worst combination.
 */
export function parseGeoapifyPlaces(data: unknown, limit = 24): NearbyPlace[] {
  // Checked up front, not just after each push: a post-push break returns one
  // item for a limit of zero, which reads as "one is the minimum" rather than
  // as the caller's cap being honoured.
  if (limit <= 0) return []
  const seen = new Set<string>()
  const places: NearbyPlace[] = []

  for (const feature of featuresOf(data)) {
    const props = propsOf(feature)
    if (!props) continue

    const name = typeof props.name === 'string' ? props.name.trim() : ''
    if (!name) continue

    const category = categorizeGeoapify(props.categories)
    if (!category) continue

    const { lat, lon } = props
    if (!finite(lat) || !finite(lon)) continue

    const rawId = typeof props.place_id === 'string' ? props.place_id : `${lat},${lon}`
    const id = `geoapify/${rawId}`
    // Same second key as the Overpass path: chains and duplicate records share
    // a name and a rounded position even when their ids differ.
    const dedupeKey = `${category}:${name.toLowerCase()}@${lat.toFixed(4)},${lon.toFixed(4)}`
    if (seen.has(id) || seen.has(dedupeKey)) continue
    seen.add(id)
    seen.add(dedupeKey)

    places.push({ id, name, category, lat, lon })
    if (places.length >= limit) break
  }
  return places
}

/* ── geocoding (#257) ────────────────────────────────────────────────────── */

/** Autocomplete (many suggestions) or forward search (one best match). */
export function buildGeocodeUrl(
  query: string,
  { limit, autocomplete }: { limit: number; autocomplete: boolean },
  apiKey: string,
): string {
  const params = new URLSearchParams({
    text: query,
    limit: String(limit),
    lang: 'en',
    apiKey,
  })
  return `${autocomplete ? AUTOCOMPLETE_URL : SEARCH_URL}?${params}`
}

/**
 * Geoapify supplies `formatted` — a ready-made display string.
 *
 * Preferred over rebuilding a label from parts the way `formatPlaceLabel` must
 * for Photon: it is already localised and de-duplicated upstream, and matching
 * Photon's exact comma-joining would be imitating an implementation detail
 * rather than a contract. Falls back to assembling the parts when absent.
 */
export function formatGeoapifyLabel(props: Record<string, unknown>): string {
  const formatted = props.formatted
  if (typeof formatted === 'string' && formatted.trim()) return formatted.trim()

  const parts = [props.name, props.city ?? props.county, props.state, props.country]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string' || !part || seen.has(part)) continue
    seen.add(part)
    unique.push(part)
  }
  return unique.join(', ')
}

/** Labelled suggestions for the autocomplete dropdown. */
export function parseGeoapifySuggestions(data: unknown, limit = 6): PlaceSuggestion[] {
  if (limit <= 0) return []
  const seen = new Set<string>()
  const out: PlaceSuggestion[] = []
  for (const feature of featuresOf(data)) {
    const props = propsOf(feature)
    if (!props) continue
    const { lat, lon } = props
    if (!finite(lat) || !finite(lon)) continue
    const label = formatGeoapifyLabel(props)
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push({ label, lat, lon })
    if (out.length >= limit) break
  }
  return out
}

/** The single most likely point, or null when nothing usable came back. */
export function parseGeoapifyFirstCoords(data: unknown): Coords | null {
  for (const feature of featuresOf(data)) {
    const props = propsOf(feature)
    if (!props) continue
    const { lat, lon } = props
    if (finite(lat) && finite(lon)) return { lat, lon }
  }
  return null
}
