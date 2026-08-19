/*
  GET /api/geocode — address autocomplete and single-best-match geocoding
  (#257, epic #255).

  Backs both call sites in src/lib/geocode.ts: the debounced autocomplete
  dropdown, and the geocode-on-save that pins a typed address (#201). Photon
  stays as the fallback for every failure path, so a missing key or an
  exhausted quota costs resolution quality and nothing else.

  Caching matters more here than on /api/nearby. Autocomplete is the documented
  way to burn a Geoapify free tier — a request per keystroke will do it in
  minutes. The debounce in the UI is the first defence; the edge cache is the
  second, and it is effective because the same few destinations get typed over
  and over within one trip.
*/
import {
  apiKey, badRequest, callGeoapify, isSameOrigin, notOurs, numberParam, ok,
  unconfigured, upstreamFailed, withEdgeCache,
} from './_geoapify'
import type { GeoContext } from './_geoapify'
import {
  buildGeocodeUrl, normalizeQuery, parseGeoapifyFirstCoords, parseGeoapifySuggestions,
} from '../../src/server/geo/geoapify'

/** Long enough for any real address, short enough that it cannot be abused. */
const MAX_QUERY = 200
const MAX_LIMIT = 10

export async function onRequestGet(ctx: GeoContext): Promise<Response> {
  // Checked before the key is even read: a request from somewhere else should
  // cost nothing at all, not a cache lookup.
  if (!isSameOrigin(ctx.request)) return notOurs()

  const key = apiKey(ctx.env)
  if (!key) return unconfigured()

  const params = new URL(ctx.request.url).searchParams
  const query = (params.get('q') ?? '').trim()
  // The same floor the client applies, repeated because the client is not
  // trusted: two characters is not a search, it is a scan.
  if (query.length < 3) return badRequest('Expected a query of at least 3 characters.')
  if (query.length > MAX_QUERY) return badRequest('That query is too long.')

  const limit = Math.min(MAX_LIMIT, Math.max(1, numberParam(params, 'limit') ?? 6))
  // `mode=one` is the save path, which wants the single best match rather than
  // a list. Anything else is the dropdown.
  const single = params.get('mode') === 'one'

  return withEdgeCache(ctx, async () => {
    // Normalised here as well as in the browser: the edge cache is keyed on the
    // incoming URL, and the client already sends a normalised `q`, so this is
    // belt and braces for anything that reaches the endpoint another way.
    const body = await callGeoapify(
      buildGeocodeUrl(normalizeQuery(query), { limit: single ? 1 : limit, autocomplete: !single }, key),
    )
    if (body === null) return upstreamFailed()
    return single
      ? ok({ coords: parseGeoapifyFirstCoords(body) })
      : ok({ suggestions: parseGeoapifySuggestions(body, limit) })
  })
}
