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

/**
 * How long to wait for the current mirror before *also* starting the next one
 * (ms), racing them and taking whichever answers first (#251).
 *
 * The old fallback was strictly serial: a slow mirror had to time out before
 * the next was even tried, so a single sluggish server could cost the user the
 * better part of the Overpass query timeout (15 s per the QL) before any pins
 * appeared, and three slow mirrors stacked to ~45 s. Hedging bounds that tail —
 * a mirror that fails outright still advances immediately (no wait), and the
 * hedge only arms a *parallel* request when a mirror is genuinely slow, so it
 * adds load to the volunteer pool only in the case that was already going to
 * cost a long wait. 4 s is comfortably longer than a healthy mirror's typical
 * response yet a fraction of the 15 s worst case it replaces.
 */
export const OVERPASS_HEDGE_MS = 4000

/** Overrides for {@link fetchViaOverpass}. Production passes none; the hedge
 *  and mirror list are seams so the fan-out timing can be tested without real
 *  network or wall-clock waits. */
export interface OverpassDeps {
  endpoints?: readonly string[]
  hedgeMs?: number
  fetchImpl?: typeof fetch
}

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
 * Whether `/api/nearby` has told us it has no key configured (#256).
 *
 * Module-level and sticky for the session, because the answer is a property of
 * the deployment rather than of one search: the GitHub Pages origin has no
 * /api/* at all, and a Cloudflare deployment without GEOAPIFY_KEY will answer
 * the same way every time. Paying a round trip per search to relearn that is
 * pure latency on the path that is already the degraded one.
 */
let endpointUnavailable = false

/** Test seam — the flag is session state, and a test should not inherit it. */
export function resetNearbyEndpointState(): void {
  endpointUnavailable = false
}

/**
 * Try the keyed provider behind our own origin (#256).
 *
 * Returns null — never throws — for every "use the other path" outcome: no
 * endpoint (GitHub Pages), no key, upstream failure, malformed body. An abort
 * is the one thing that propagates, because the caller navigating away must
 * not be answered with a fallback request nobody is waiting for.
 */
async function fetchViaEndpoint(
  center: { lat: number; lon: number },
  { radiusMeters, limit }: { radiusMeters: number; limit: number },
  signal?: AbortSignal,
): Promise<NearbyPlace[] | null> {
  if (endpointUnavailable) return null
  const query = `lat=${center.lat}&lon=${center.lon}&r=${Math.round(radiusMeters)}&limit=${limit}`
  try {
    const res = await fetch(`/api/nearby?${query}`, { signal })
    // 501 is the endpoint saying "no key here" — a settled fact, so stop
    // asking. Any other failure might be transient, so only this one sticks.
    if (res.status === 501) {
      endpointUnavailable = true
      return null
    }
    if (!res.ok) return null
    const body: unknown = await res.json()
    const places =
      body && typeof body === 'object' ? (body as { places?: unknown }).places : undefined
    return Array.isArray(places) ? (places as NearbyPlace[]) : null
  } catch (err) {
    if (signal?.aborted) throw err
    // On GitHub Pages this is a 404 HTML page failing to parse as JSON, which
    // is also a settled fact about the origin rather than a passing blip.
    endpointUnavailable = true
    return null
  }
}

/**
 * Fetch categorized POIs around `center`.
 *
 * Tries `/api/nearby` first — same origin, so no CORS, keyed provider, edge
 * cached — then falls back to the public Overpass mirrors, which is what this
 * function was before #256 and remains for every origin and configuration
 * where the endpoint is not available.
 *
 * Resolves to the parsed places (possibly empty — a real "nothing here");
 * throws only when the endpoint AND every mirror fails, or the request is
 * aborted, so the calling TanStack Query degrades to a quiet "suggestions
 * unavailable" rather than breaking the map.
 */
export async function fetchNearbyPlaces(
  center: { lat: number; lon: number },
  options: NearbyOptions = {},
  signal?: AbortSignal,
): Promise<NearbyPlace[]> {
  const { radiusMeters = 1500, limit = 24 } = options
  const viaEndpoint = await fetchViaEndpoint(center, { radiusMeters, limit }, signal)
  if (viaEndpoint) return viaEndpoint
  return fetchViaOverpass(center, { radiusMeters, limit }, signal)
}

/**
 * The original keyless path: OpenStreetMap via Overpass. Kept deliberately —
 * a free tier can change its terms, a community server cannot send you a bill,
 * and this is what makes losing the key (#256) cost quality rather than the
 * feature.
 *
 * Mirrors are tried with *hedging* rather than strictly in series (#251): the
 * first mirror starts immediately, and if it has not answered within
 * {@link OVERPASS_HEDGE_MS} the next starts in parallel — whichever returns
 * first wins. A mirror that fails outright advances to the next at once, with
 * no wait. This bounds the tail: one slow mirror no longer blocks the whole
 * fallback for its full timeout, and slow mirrors no longer stack serially.
 *
 * Resolves to the parsed places (possibly empty — a real "nothing here");
 * rejects only when every mirror fails, or the request is aborted, so the
 * calling query degrades to a quiet "suggestions unavailable" rather than
 * breaking the map.
 */
export function fetchViaOverpass(
  center: { lat: number; lon: number },
  { radiusMeters = 1500, limit = 24 }: NearbyOptions = {},
  signal?: AbortSignal,
  deps: OverpassDeps = {},
): Promise<NearbyPlace[]> {
  const endpoints = deps.endpoints ?? OVERPASS_ENDPOINTS
  const hedgeMs = deps.hedgeMs ?? OVERPASS_HEDGE_MS
  const doFetch = deps.fetchImpl ?? fetch
  const body = `data=${encodeURIComponent(buildOverpassQuery(center, radiusMeters))}`

  // One mirror attempt: resolves with parsed places, or rejects (a non-ok
  // status, a malformed body, a transport error, or a caller-driven abort).
  const attempt = async (endpoint: string): Promise<NearbyPlace[]> => {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    })
    // 429 (rate-limited) / 504 (busy) are Overpass's "try again elsewhere"
    // signals — treat any non-ok as this mirror failing so we move on.
    if (!res.ok) throw new Error(`Overpass returned ${res.status}`)
    const data: unknown = await res.json()
    const elements =
      data && typeof data === 'object' ? (data as { elements?: unknown }).elements : undefined
    return parseOverpassElements(elements, limit)
  }

  return new Promise<NearbyPlace[]>((resolve, reject) => {
    let next = 0 // index of the next mirror to start
    let outstanding = 0 // attempts still in flight
    let done = false
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined
    let lastError: unknown = new Error('Nearby suggestions unavailable')

    const clearHedge = () => {
      if (hedgeTimer !== undefined) {
        clearTimeout(hedgeTimer)
        hedgeTimer = undefined
      }
    }

    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearHedge()
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    // A caller-driven abort (navigated away / searched elsewhere) must reject
    // immediately, even while we are only waiting on a hedge timer.
    const onAbort = () =>
      finish(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')))

    // Advance the frontier: start the next mirror (if any), or — once none are
    // left to start and none remain in flight — reject with the last failure.
    const advance = () => {
      if (done) return
      clearHedge()
      if (next >= endpoints.length) {
        if (outstanding === 0) {
          finish(() =>
            reject(lastError instanceof Error ? lastError : new Error('Nearby suggestions unavailable')),
          )
        }
        return
      }
      const endpoint = endpoints[next++]
      outstanding++
      attempt(endpoint).then(
        (places) => finish(() => resolve(places)),
        (err) => {
          outstanding--
          if (signal?.aborted) return finish(() => reject(err))
          lastError = err
          advance() // this mirror failed — bring on the next one now, no wait
        },
      )
      // Arm the hedge: if a mirror remains and the one we just started is still
      // silent after hedgeMs, start the next in parallel and race them.
      if (next < endpoints.length) {
        hedgeTimer = setTimeout(advance, hedgeMs)
      }
    }

    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    advance()
  })
}
