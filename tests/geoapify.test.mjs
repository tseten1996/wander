/**
 * Geoapify request builders and response mappers (src/server/geo/geoapify.ts).
 *
 * Two things carry real risk here and are covered accordingly:
 *
 *   1. The COORDINATE ORDER. Geoapify's circle/proximity filters take longitude
 *      first, the opposite of every internal helper in this repo. Getting it
 *      backwards does not error — it silently searches the wrong hemisphere.
 *   2. The CATEGORY MAPPING. Geoapify returns a hierarchy, so a pub arrives as
 *      ["catering", "catering.pub"] and a naive `catering` match would file it
 *      under food. Category is what colours the pin, so a wrong bucket is
 *      visible and wrong rather than merely imprecise.
 *
 *   node --test tests/geoapify.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)

const {
  buildPlacesUrl, buildGeocodeUrl, categorizeGeoapify, parseGeoapifyPlaces,
  parseGeoapifySuggestions, parseGeoapifyFirstCoords, formatGeoapifyLabel,
  REQUESTED_CATEGORIES, normalizeQuery,
} = await import('../src/server/geo/geoapify.ts')

const PARIS = { lat: 48.8606, lon: 2.3376 }

const feature = (props) => ({ type: 'Feature', properties: props })

/* ── request building ────────────────────────────────────────────────────── */

test('the circle and bias filters put LONGITUDE first', () => {
  // The single most dangerous detail in this module: reversed, it silently
  // searches a different hemisphere rather than failing.
  const url = new URL(buildPlacesUrl(PARIS, { radiusMeters: 1500, limit: 24 }, 'K'))
  assert.equal(url.searchParams.get('filter'), 'circle:2.3376,48.8606,1500')
  assert.equal(url.searchParams.get('bias'), 'proximity:2.3376,48.8606')
})

test('the key is a parameter, never part of the path', () => {
  const url = new URL(buildPlacesUrl(PARIS, { radiusMeters: 1500, limit: 24 }, 'secret-key'))
  assert.equal(url.searchParams.get('apiKey'), 'secret-key')
  assert.ok(!url.pathname.includes('secret-key'))
})

test('the radius is rounded — Geoapify wants whole metres', () => {
  const url = new URL(buildPlacesUrl(PARIS, { radiusMeters: 1499.7, limit: 24 }, 'K'))
  assert.equal(url.searchParams.get('filter'), 'circle:2.3376,48.8606,1500')
})

test('only categories we can classify are requested', () => {
  // Asking for categories the mapper would drop spends credits on results that
  // are thrown away — Places bills per 20 results returned.
  for (const c of REQUESTED_CATEGORIES.split(',')) {
    assert.ok(categorizeGeoapify([c]), `${c} is requested but not classifiable`)
  }
})

test('autocomplete and single-match hit different endpoints', () => {
  const many = new URL(buildGeocodeUrl('kyoto', { limit: 6, autocomplete: true }, 'K'))
  const one = new URL(buildGeocodeUrl('kyoto', { limit: 1, autocomplete: false }, 'K'))
  assert.match(many.pathname, /autocomplete$/)
  assert.match(one.pathname, /search$/)
  assert.equal(many.searchParams.get('text'), 'kyoto')
  assert.equal(one.searchParams.get('limit'), '1')
})

test('a query with spaces and symbols is encoded, not concatenated', () => {
  const url = new URL(buildGeocodeUrl('18 rue Lepic, Paris & co', { limit: 6, autocomplete: true }, 'K'))
  assert.equal(url.searchParams.get('text'), '18 rue Lepic, Paris & co')
})

/* ── category mapping ────────────────────────────────────────────────────── */

test('the hierarchy is matched at the leaf, so a pub is a drink not a meal', () => {
  assert.equal(categorizeGeoapify(['catering', 'catering.pub']), 'drink')
  assert.equal(categorizeGeoapify(['catering', 'catering.bar']), 'drink')
  assert.equal(categorizeGeoapify(['catering', 'catering.restaurant']), 'eat')
  assert.equal(categorizeGeoapify(['catering', 'catering.cafe']), 'eat')
})

test('sights and museums are "see"', () => {
  assert.equal(categorizeGeoapify(['entertainment', 'entertainment.museum']), 'see')
  assert.equal(categorizeGeoapify(['tourism', 'tourism.sights']), 'see')
  assert.equal(categorizeGeoapify(['tourism.attraction']), 'see')
})

test('a deeper leaf still matches its prefix', () => {
  assert.equal(categorizeGeoapify(['tourism.sights.castle']), 'see')
  assert.equal(categorizeGeoapify(['catering.restaurant.italian']), 'eat')
})

test('food wins over sights, matching the OSM path’s precedence', () => {
  // A museum café should read as somewhere to eat, exactly as categorizePoi
  // resolves amenity before tourism.
  assert.equal(categorizeGeoapify(['entertainment.museum', 'catering.cafe']), 'eat')
})

test('anything unclassifiable is dropped rather than guessed', () => {
  for (const v of [undefined, null, [], ['commercial.supermarket'], ['building'], 'catering', [42]]) {
    assert.equal(categorizeGeoapify(v), null)
  }
})

/* ── places parsing ──────────────────────────────────────────────────────── */

const place = (over = {}) =>
  feature({
    name: 'Café de Flore',
    categories: ['catering', 'catering.cafe'],
    lat: 48.8542,
    lon: 2.3320,
    place_id: 'abc123',
    ...over,
  })

test('a well-formed place maps to a NearbyPlace', () => {
  const [p] = parseGeoapifyPlaces({ features: [place()] })
  assert.deepEqual(p, {
    id: 'geoapify/abc123',
    name: 'Café de Flore',
    category: 'eat',
    lat: 48.8542,
    lon: 2.332,
  })
})

test('ids are namespaced so the two sources can never collide', () => {
  // Overpass ids look like "node/123". An unprefixed place_id colliding with
  // one is unlikely and silent, which is the worst combination — the id is
  // both the React key and the de-dupe key.
  const [p] = parseGeoapifyPlaces({ features: [place({ place_id: 'node/123' })] })
  assert.equal(p.id, 'geoapify/node/123')
  assert.ok(p.id.startsWith('geoapify/'))
})

test('unusable features are skipped, not thrown on', () => {
  const places = parseGeoapifyPlaces({
    features: [
      place({ name: '   ' }),                       // unnamed
      place({ categories: ['commercial.shop'] }),   // unclassifiable
      place({ lat: 'north' }),                      // non-finite
      place({ lon: undefined }),
      null,
      'not a feature',
      place(),                                      // the only good one
    ],
  })
  assert.equal(places.length, 1)
  assert.equal(places[0].name, 'Café de Flore')
})

test('a junk body yields no places rather than an exception', () => {
  for (const body of [null, undefined, {}, { features: 'no' }, 42, []]) {
    assert.deepEqual(parseGeoapifyPlaces(body), [])
  }
})

test('duplicates collapse by id and by name-at-a-position', () => {
  const places = parseGeoapifyPlaces({
    features: [
      place(),
      place(),                                                   // same id
      place({ place_id: 'different', name: 'café de flore' }),   // same spot + name
      place({ place_id: 'other', name: 'Le Deux Magots', lat: 48.8539 }),
    ],
  })
  assert.equal(places.length, 2)
})

test('the limit is honoured', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    place({ place_id: `p${i}`, name: `Place ${i}`, lat: 48.85 + i / 1000 }),
  )
  assert.equal(parseGeoapifyPlaces({ features: many }, 24).length, 24)
  assert.equal(parseGeoapifyPlaces({ features: many }, 5).length, 5)
})

/* ── geocoding parsing ───────────────────────────────────────────────────── */

test('suggestions prefer the provider’s formatted label', () => {
  const [s] = parseGeoapifySuggestions({
    features: [feature({ formatted: 'Kyoto, Japan', name: 'Kyoto', lat: 35.01, lon: 135.76 })],
  })
  assert.deepEqual(s, { label: 'Kyoto, Japan', lat: 35.01, lon: 135.76 })
})

test('a missing formatted label is assembled from the parts', () => {
  assert.equal(
    formatGeoapifyLabel({ name: 'Louvre', city: 'Paris', country: 'France' }),
    'Louvre, Paris, France',
  )
  // Repeats collapse, matching what formatPlaceLabel does for Photon.
  assert.equal(formatGeoapifyLabel({ name: 'Paris', city: 'Paris', country: 'France' }), 'Paris, France')
})

test('suggestions de-duplicate by label and respect the limit', () => {
  const dupe = feature({ formatted: 'Kyoto, Japan', lat: 35.01, lon: 135.76 })
  const out = parseGeoapifySuggestions({ features: [dupe, dupe, dupe] })
  assert.equal(out.length, 1)
  // A limit of zero means zero. The endpoint clamps to at least 1 so this
  // cannot happen in production, but a parser that returns one item for a
  // limit of nothing is the kind of latent off-by-one that surfaces later.
  assert.equal(parseGeoapifySuggestions({ features: [dupe] }, 0).length, 0)
  assert.equal(parseGeoapifyPlaces({ features: [place()] }, 0).length, 0)
})

test('the first usable coordinate wins, and junk yields null', () => {
  assert.deepEqual(
    parseGeoapifyFirstCoords({
      features: [feature({ lat: 'x' }), feature({ lat: 48.86, lon: 2.33 })],
    }),
    { lat: 48.86, lon: 2.33 },
  )
  for (const body of [null, {}, { features: [] }, { features: [feature({})] }]) {
    assert.equal(parseGeoapifyFirstCoords(body), null)
  }
})

/* ── credit discipline ───────────────────────────────────────────────────── */

test('the query normaliser collapses the variants people actually type', () => {
  const same = ['Kyoto', 'kyoto', 'KYOTO', '  kyoto  ', 'kyoto']
  const keys = new Set(same.map(normalizeQuery))
  assert.equal(keys.size, 1, 'these must be one cached lookup, not five metered ones')

  assert.equal(normalizeQuery('18  rue   Lepic'), '18 rue lepic', 'inner runs collapse')
  assert.notEqual(normalizeQuery('kyoto'), normalizeQuery('osaka'), 'different places stay different')
})

test('normalising is idempotent — the key cannot drift on a second pass', () => {
  // Three caches apply this independently (browser, edge, upstream query). If
  // it were not idempotent they would disagree and the hit rate would collapse.
  for (const q of ['  Kyoto,  Japan ', 'PARIS', 'a b']) {
    assert.equal(normalizeQuery(normalizeQuery(q)), normalizeQuery(q))
  }
})
