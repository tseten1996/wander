/*
  GET /api/nearby — categorized places around a point (#256, epic #255).

  Same origin as the app, so there is no CORS layer to fail. That is the
  headline fix: overpass-api.de answers its own rate limits without an
  Access-Control-Allow-Origin header, so a 429 reached the browser as a CORS
  violation and filled the console with a misleading error.

  This endpoint never *replaces* Overpass — src/lib/places.ts falls back to the
  mirror rotation whenever this answers anything but 200, including the
  deliberate 501 when no key is configured. A deployment with no key, an
  exhausted quota, and the GitHub Pages origin (which has no /api/* at all) all
  behave exactly as they did before this existed.
*/
import {
  apiKey, badRequest, callGeoapify, numberParam, ok, unconfigured,
  upstreamFailed, withEdgeCache,
} from './_geoapify'
import type { GeoContext } from './_geoapify'
import { buildPlacesUrl, parseGeoapifyPlaces } from '../../src/server/geo/geoapify'

/** Mirrors NEARBY_RADIUS_M's neighbourhood scale; a cap, not a default. */
const MAX_RADIUS_M = 5000
const MAX_LIMIT = 50

export async function onRequestGet(ctx: GeoContext): Promise<Response> {
  const key = apiKey(ctx.env)
  if (!key) return unconfigured()

  const params = new URL(ctx.request.url).searchParams
  const lat = numberParam(params, 'lat')
  const lon = numberParam(params, 'lon')
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return badRequest('Expected a finite lat and lon.')
  }

  // Bounded rather than defaulted-silently: an unbounded radius is a way to
  // turn one request into an expensive one, and this endpoint is public.
  const radiusMeters = Math.min(MAX_RADIUS_M, Math.max(1, numberParam(params, 'r') ?? 1500))
  const limit = Math.min(MAX_LIMIT, Math.max(1, numberParam(params, 'limit') ?? 24))

  return withEdgeCache(ctx, async () => {
    // The URL is assembled here from validated numbers — the caller supplies
    // coordinates, never a query, a category list or a URL. This is a place
    // lookup, not a proxy for whatever someone points at it.
    const body = await callGeoapify(buildPlacesUrl({ lat, lon }, { radiusMeters, limit }, key))
    if (body === null) return upstreamFailed()
    return ok({ places: parseGeoapifyPlaces(body, limit) })
  })
}
