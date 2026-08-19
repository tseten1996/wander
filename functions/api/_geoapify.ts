/*
  Shared plumbing for the two Geoapify endpoints (#255).

  Underscore-prefixed so Cloudflare Pages does NOT route it: files under
  functions/ become endpoints by filename, and this is a module, not a route.

  Everything platform-specific about the location endpoints lives here — the
  key lookup, the edge cache, the upstream call — so functions/api/nearby.ts
  and functions/api/geocode.ts stay down to "validate the query, map the body".
  Same reasoning as functions/api/ai.ts: the runtime-specific surface is kept
  small enough that moving platforms is one file, not a rewrite.
*/

/**
 * The Workers cache. Not in the DOM's `CacheStorage`, so it is declared here
 * rather than pulling in @cloudflare/workers-types for one property.
 */
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}
declare const caches: { default: EdgeCache }

export interface GeoEnv {
  /** Geoapify API key. Absent is a supported state — callers fall back. */
  GEOAPIFY_KEY?: string
  /** Kill switch. Set to 'false' to force every caller onto the keyless path. */
  GEOAPIFY_ENABLED?: string
}

export interface GeoContext {
  request: Request
  env: GeoEnv
  /** Lets the cache write outlive the response. */
  waitUntil: (promise: Promise<unknown>) => void
}

/**
 * How long an edge cache entry lives.
 *
 * OSM-derived data changes on a timescale of months, so this is bounded by
 * "how stale may a suggestion be" rather than by correctness. A day is long
 * enough that a group planning together shares one upstream call, and short
 * enough that a corrected place name reaches them the next day.
 */
export const EDGE_TTL_SECONDS = 24 * 60 * 60

const json = (body: unknown, status: number, cacheable: boolean): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheable
        ? `public, max-age=${EDGE_TTL_SECONDS}`
        : 'no-store',
    },
  })

/**
 * The answer when there is no key, or the switch is off.
 *
 * A distinct, cheap, explicitly *uncacheable* refusal rather than an error:
 * the client reads `reason: 'unconfigured'`, stops asking for the rest of the
 * session, and uses the keyless provider. Caching it would pin "AI is off"
 * into the edge for a day after the key is finally added, which is exactly the
 * kind of stale-config trap that cost hours on the /api/ai rollout.
 */
export const unconfigured = (): Response =>
  json({ ok: false, reason: 'unconfigured' }, 501, false)

/** Bad input from the caller. Never cached — it is about the request, not the data. */
export const badRequest = (message: string): Response =>
  json({ ok: false, reason: 'bad_request', message }, 400, false)

/** Upstream failed. Not cached, so a blip is not remembered for a day. */
export const upstreamFailed = (): Response =>
  json({ ok: false, reason: 'upstream' }, 502, false)

export const ok = (body: Record<string, unknown>): Response =>
  json({ ok: true, ...body }, 200, true)

/** The key, or null when this deployment has none. */
export function apiKey(env: GeoEnv): string | null {
  if (env.GEOAPIFY_ENABLED === 'false') return null
  const key = env.GEOAPIFY_KEY?.trim()
  return key ? key : null
}

/**
 * Serve from the edge cache, or build and store.
 *
 * Keyed on the *incoming* request URL, which the client has already snapped to
 * a grid — so a tap three metres from the last one is the same cache entry, and
 * one upstream call serves every member of a trip rather than one browser.
 * That amplification is what makes a 3,000/day free tier comfortable.
 *
 * A cache miss that fails upstream is never stored: `build` returns the
 * response, and only 2xx answers are put back.
 */
export async function withEdgeCache(
  ctx: GeoContext,
  build: () => Promise<Response>,
): Promise<Response> {
  const cacheKey = new Request(ctx.request.url, { method: 'GET' })
  const hit = await caches.default.match(cacheKey).catch(() => undefined)
  if (hit) return hit

  const fresh = await build()
  if (fresh.ok) {
    // clone() before the body is consumed by the client — a Response body can
    // only be read once, and the cache write outlives this handler.
    ctx.waitUntil(caches.default.put(cacheKey, fresh.clone()).catch(() => {}))
  }
  return fresh
}

/**
 * Call Geoapify and parse its JSON, or null on any failure.
 *
 * Never throws: every caller's contract is "fall back to the keyless
 * provider", so a thrown error here would only be caught and discarded one
 * frame up. A timeout is included because an edge function waiting on a slow
 * upstream is worse than a fast fall-through to Overpass.
 */
export async function callGeoapify(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Whether this request came from our own page.
 *
 * These endpoints are public, unauthenticated, and spend a metered credit per
 * call — which means without this, anyone who reads the URL out of devtools can
 * drain a day's quota with a shell loop. That is not a billing risk (the free
 * plan has no card attached, so the worst case is the app degrading to its
 * keyless providers), but it is a trivially avoidable one.
 *
 * `Sec-Fetch-Site` is the primary signal because browsers set it and page
 * JavaScript cannot forge or strip it. Origin and Referer are accepted as
 * fallbacks for older clients, matched on host rather than on the full string
 * so preview deployments and custom domains work without a list to maintain.
 *
 * This is a speed bump, not authentication — the same class of control as the
 * referrer-locked key #191 endorses for credentials whose blast radius is
 * bounded by something other than secrecy. A determined caller can set headers.
 * A drive-by script cannot, and that is the whole threat being addressed.
 */
export function isSameOrigin(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'same-origin') return true

  const self = new URL(request.url).host
  const hostOf = (value: string | null): string | null => {
    if (!value) return null
    try {
      return new URL(value).host
    } catch {
      return null
    }
  }
  const origin = hostOf(request.headers.get('origin'))
  if (origin) return origin === self
  const referer = hostOf(request.headers.get('referer'))
  if (referer) return referer === self

  // Nothing to go on. A same-origin fetch from a modern browser always carries
  // at least one of the three, so this is a script.
  return false
}

/** Refused for coming from somewhere else. Never cached. */
export const notOurs = (): Response =>
  json({ ok: false, reason: 'forbidden' }, 403, false)

/** A finite number from a query string, or null. */
export function numberParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
