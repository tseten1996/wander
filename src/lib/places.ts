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

    const place: NearbyPlace = {
      id: `${el.type ?? 'node'}/${el.id ?? `${lat},${lon}`}`,
      name, category, lat, lon,
    }
    const [idKey, spotKey] = placeDedupeKeys(place)
    if (seen.has(idKey) || seen.has(spotKey)) continue
    seen.add(idKey)
    seen.add(spotKey)

    places.push(place)
    if (places.length >= limit) break
  }
  return places
}

/**
 * The two identities a place de-duplicates on: its OSM id, and its
 * name+coarse-coords (a way and its node sharing a spot, or a chain
 * duplicate). Shared between a single response's parse and the cross-response
 * merge so the two can never disagree about what "the same place" means.
 */
function placeDedupeKeys(p: NearbyPlace): [string, string] {
  return [p.id, `${p.category}:${p.name.toLowerCase()}@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`]
}

/**
 * Union two result sets into one de-duplicated list, `first` before `second`,
 * capped at `limit`. Order is the contract: the caller passes the inner-ring
 * results first so pins already on screen keep their identity and position
 * when the wider ring lands, and the closest places win the cap.
 */
export function mergeNearbyPlaces(
  first: NearbyPlace[],
  second: NearbyPlace[],
  limit = 24,
): NearbyPlace[] {
  const seen = new Set<string>()
  const merged: NearbyPlace[] = []
  for (const place of [...first, ...second]) {
    const [idKey, spotKey] = placeDedupeKeys(place)
    if (seen.has(idKey) || seen.has(spotKey)) continue
    seen.add(idKey)
    seen.add(spotKey)
    merged.push(place)
    if (merged.length >= limit) break
  }
  return merged
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

/**
 * Decimal places the search centre is rounded to before it becomes a cache key.
 *
 * 3 dp is ~111 m of latitude, and ~73–90 m of longitude at the latitudes people
 * actually plan trips for (Paris ~73 m, Tokyo ~90 m). The worst case — a tap on
 * a cell corner — puts the cached centre ~67 m away at those latitudes, and ~79 m
 * at the equator where longitude degrees are widest. Against a 1500 m radius
 * that is ~5%: materially the same disc of places, which is what makes reusing
 * the response honest rather than merely convenient.
 *
 * Note this bounds the *error*, not the hit rate. Two taps 20 m apart still miss
 * each other if they straddle a cell boundary — grid snapping cuts the number of
 * distinct keys by orders of magnitude, it does not guarantee any single pair
 * collides. That is the right trade: a coarser grid would buy more hits at the
 * cost of searching further from where the user actually pointed.
 */
export const NEARBY_SNAP_DP = 3

/** Longitude normalised into [-180, 180), so a panned-past-the-edge map and the
 *  same physical place don't produce two different cache keys. */
function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/**
 * Quantise a search centre onto a fixed grid, so nearby taps collapse onto one
 * cache entry instead of each issuing its own Overpass request.
 *
 * This exists because the map's search centre is a *tap* — continuous floats —
 * so keying a query on it directly means a tap three metres from the last one is
 * a fresh round trip to a volunteer-run mirror. Pure and total: the same input
 * always yields the same cell, which is the property the cache key depends on.
 *
 * Callers should keep measuring distances from the user's real tap, not from the
 * snapped centre — this is a key, not a correction to what the user meant.
 */
export function snapCenter(
  center: { lat: number; lon: number },
  decimals: number = NEARBY_SNAP_DP,
): { lat: number; lon: number } {
  const factor = 10 ** decimals
  // `Object.is` guard: -0.0001 rounds to -0, which is a different key from 0
  // under some hashers even though it is the same meridian.
  const round = (v: number) => {
    const r = Math.round(v * factor) / factor
    return Object.is(r, -0) ? 0 : r
  }
  // Clamp before rounding: a latitude outside the sphere is meaningless to
  // Overpass, and clamping first keeps the returned cell inside the grid.
  const lat = round(Math.min(90, Math.max(-90, center.lat)))
  const lon = round(wrapLongitude(center.lon))
  // Rounding can push a longitude just short of the antimeridian up onto +180,
  // which names the same meridian as -180 — canonicalise so the wrap doesn't
  // split one place across two keys.
  return { lat, lon: lon === 180 ? -180 : lon }
}

export interface NearbyOptions {
  /** Search radius in metres (default 1500 — a walkable neighbourhood). */
  radiusMeters?: number
  /** Cap on suggestions returned after categorize + de-dupe (default 24). */
  limit?: number
}

/**
 * How long a mirror gets to itself before a competitor is started (#251).
 * The old serial fallback waited out each mirror's full [timeout:15] before
 * trying the next — up to ~45 s of spinner across three mirrors. Hedging
 * bounds that tail: a mirror that hasn't answered in this window is probably
 * queued or overloaded, so the next one starts *alongside* it and whichever
 * answers first wins. The extra request only ever exists when a mirror is
 * actually slow, which keeps the added load on these volunteer-run instances
 * marginal.
 */
export const MIRROR_HEDGE_MS = 4000

/**
 * Race `attempts` with staggered starts: the first begins immediately, each
 * subsequent one after `hedgeDelayMs` — or right away when a running attempt
 * fails, since a definite failure shouldn't leave the user waiting out the
 * hedge timer. First fulfillment wins and aborts the rest (via the
 * per-attempt signal); rejects with the last error only when every attempt
 * has failed. `signal` is the caller's abort — it cancels everything.
 */
export function hedgedRace<T>(
  attempts: Array<(signal: AbortSignal) => Promise<T>>,
  hedgeDelayMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = []
    let started = 0
    let running = 0
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastError: unknown = new Error('Nearby suggestions unavailable')

    const finish = (settle: () => void) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      for (const c of controllers) c.abort()
      settle()
    }
    const onAbort = () =>
      finish(() =>
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError'),
        ),
      )

    const armHedge = () => {
      if (done || started >= attempts.length) return
      timer = setTimeout(() => {
        startNext()
        armHedge()
      }, hedgeDelayMs)
    }
    const startNext = () => {
      if (done || started >= attempts.length) return
      const controller = new AbortController()
      controllers.push(controller)
      running++
      attempts[started++](controller.signal).then(
        (value) => finish(() => resolve(value)),
        (err) => {
          running--
          if (done) return
          lastError = err
          if (started < attempts.length) {
            if (timer) clearTimeout(timer)
            startNext()
            armHedge()
          } else if (running === 0) {
            finish(() => reject(lastError))
          }
        },
      )
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    startNext()
    armHedge()
  })
}

/**
 * Fetch categorized POIs around `center` from OpenStreetMap via Overpass,
 * hedging across the public mirrors (see `hedgedRace`). Resolves to the
 * parsed places (possibly empty — a real "nothing here"); throws only when
 * every mirror fails or the request is aborted, so the calling TanStack Query
 * degrades to a quiet "suggestions unavailable" rather than breaking the map.
 */
export async function fetchNearbyPlaces(
  center: { lat: number; lon: number },
  { radiusMeters = 1500, limit = 24 }: NearbyOptions = {},
  signal?: AbortSignal,
): Promise<NearbyPlace[]> {
  const body = `data=${encodeURIComponent(buildOverpassQuery(center, radiusMeters))}`
  return hedgedRace(
    OVERPASS_ENDPOINTS.map((endpoint) => async (attemptSignal: AbortSignal) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: attemptSignal,
      })
      // 429 (rate-limited) / 504 (busy) are Overpass's "try elsewhere" signals
      // — throwing hands this mirror's loss to the race, which starts the next.
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`)
      const data: unknown = await res.json()
      const elements =
        data && typeof data === 'object' ? (data as { elements?: unknown }).elements : undefined
      return parseOverpassElements(elements, limit)
    }),
    MIRROR_HEDGE_MS,
    signal,
  )
}
