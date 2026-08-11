/**
 * Unit tests for the keyless Nearby POI source (src/lib/places.ts) that backs
 * the map's "things to do" suggestions (#165, epic #164 slice 1).
 *
 * Like tests/geo.test.mjs, these run against the TypeScript source directly:
 * Node (>= 22.18) strips the types on import, and places.ts imports nothing
 * from `@/types`, so no path alias ever needs resolving. Only the pure,
 * network-free surface is exercised here — categorize, parse, query-build; the
 * `fetch` fan-out over mirrors is covered by the app's smoke/manual paths.
 *
 *   node --test tests/places.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  categorizePoi,
  parseOverpassElements,
  buildOverpassQuery,
  snapCenter,
  NEARBY_SNAP_DP,
  POI_CATEGORY_LABEL,
} from '../src/lib/places.ts'

test('categorizePoi maps amenity/tourism tags to the right bucket', () => {
  assert.equal(categorizePoi({ amenity: 'restaurant' }), 'eat')
  assert.equal(categorizePoi({ amenity: 'cafe' }), 'eat')
  assert.equal(categorizePoi({ amenity: 'bar' }), 'drink')
  assert.equal(categorizePoi({ amenity: 'pub' }), 'drink')
  assert.equal(categorizePoi({ tourism: 'museum' }), 'see')
  assert.equal(categorizePoi({ tourism: 'viewpoint' }), 'see')
})

test('categorizePoi returns null for unknown or missing tags', () => {
  assert.equal(categorizePoi({ amenity: 'parking' }), null)
  assert.equal(categorizePoi({ tourism: 'hotel' }), null)
  assert.equal(categorizePoi({}), null)
  assert.equal(categorizePoi(undefined), null)
})

test('categorizePoi prefers food/drink (amenity) over a co-tagged attraction', () => {
  // A café also tagged tourism=attraction still reads as "eat".
  assert.equal(categorizePoi({ amenity: 'cafe', tourism: 'attraction' }), 'eat')
})

test('parseOverpassElements keeps named, categorizable, located places', () => {
  const places = parseOverpassElements([
    { type: 'node', id: 1, lat: 38.71, lon: -9.14, tags: { name: 'Time Out Market', amenity: 'food_court' } },
    { type: 'way', id: 2, center: { lat: 38.72, lon: -9.13 }, tags: { name: 'Castelo', tourism: 'attraction' } },
  ])
  assert.equal(places.length, 2)
  assert.deepEqual(places[0], {
    id: 'node/1', name: 'Time Out Market', category: 'eat', lat: 38.71, lon: -9.14,
  })
  // A way's coordinate comes from `out center`.
  assert.equal(places[1].id, 'way/2')
  assert.equal(places[1].lat, 38.72)
  assert.equal(places[1].category, 'see')
})

test('parseOverpassElements drops unnamed, uncategorizable, and unlocated elements', () => {
  const places = parseOverpassElements([
    { type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'restaurant' } }, // no name
    { type: 'node', id: 2, lat: 1, lon: 1, tags: { name: 'Car Park', amenity: 'parking' } }, // wrong tag
    { type: 'node', id: 3, tags: { name: 'Ghost', amenity: 'bar' } }, // no coords
    { type: 'node', id: 4, lat: 'x', lon: 2, tags: { name: 'Bad', amenity: 'bar' } }, // non-finite
  ])
  assert.equal(places.length, 0)
})

test('parseOverpassElements de-dupes by id and by name+coarse-coords', () => {
  const places = parseOverpassElements([
    { type: 'node', id: 7, lat: 40.0, lon: 2.0, tags: { name: 'Bar Central', amenity: 'bar' } },
    { type: 'node', id: 7, lat: 40.0, lon: 2.0, tags: { name: 'Bar Central', amenity: 'bar' } }, // same id
    { type: 'way', id: 8, center: { lat: 40.00001, lon: 2.00001 }, tags: { name: 'Bar Central', amenity: 'bar' } }, // same name+spot
  ])
  assert.equal(places.length, 1)
})

test('parseOverpassElements honours the limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    type: 'node', id: i, lat: 10 + i, lon: 20, tags: { name: `Place ${i}`, tourism: 'museum' },
  }))
  assert.equal(parseOverpassElements(many, 5).length, 5)
})

test('parseOverpassElements tolerates a non-array input', () => {
  assert.deepEqual(parseOverpassElements(undefined), [])
  assert.deepEqual(parseOverpassElements(null), [])
  assert.deepEqual(parseOverpassElements({ elements: [] }), [])
})

test('buildOverpassQuery embeds a rounded radius and the point, and asks for centers', () => {
  const q = buildOverpassQuery({ lat: 38.7, lon: -9.14 }, 1500.6)
  assert.match(q, /around:1501,38\.7,-9\.14/)
  assert.match(q, /out center/)
  assert.match(q, /amenity/)
  assert.match(q, /tourism/)
})

test('POI_CATEGORY_LABEL covers every category', () => {
  assert.deepEqual(Object.keys(POI_CATEGORY_LABEL).sort(), ['drink', 'eat', 'see'])
})

/* ── snapCenter: the Nearby cache key (#219) ─────────────────────────────── */

test('snapCenter collapses taps within a cell onto one key', () => {
  // The regression: the query keyed on raw tap floats, so two taps a few metres
  // apart were two cache misses and two requests to a volunteer Overpass mirror.
  const a = snapCenter({ lat: 48.85662, lon: 2.35221 })
  const b = snapCenter({ lat: 48.85655, lon: 2.35238 })
  assert.deepEqual(a, b, 'taps within one cell must share a key')
  assert.deepEqual(a, { lat: 48.857, lon: 2.352 })
})

test('snapCenter bounds the error, not the hit rate — boundary taps still miss', () => {
  // Honest about what grid snapping does and does not buy: these two points are
  // ~19 m apart but sit either side of a latitude cell boundary, so they remain
  // separate keys. The win is statistical — orders of magnitude fewer distinct
  // keys — not a guarantee about any particular pair. A coarser grid would trade
  // more hits for searching further from where the user actually tapped.
  const a = snapCenter({ lat: 48.85661, lon: 2.35222 })
  const b = snapCenter({ lat: 48.85644, lon: 2.35222 })
  assert.notDeepEqual(a, b)
})

test('snapCenter keeps genuinely different neighbourhoods apart', () => {
  const louvre = snapCenter({ lat: 48.8606, lon: 2.3376 })
  const eiffel = snapCenter({ lat: 48.8584, lon: 2.2945 })
  assert.notDeepEqual(louvre, eiffel)
})

test('snapCenter is pure and idempotent — the property the cache key rests on', () => {
  const once = snapCenter({ lat: 35.68, lon: 139.7649 })
  assert.deepEqual(snapCenter(once), once)
  assert.deepEqual(snapCenter({ lat: 35.68, lon: 139.7649 }), once)
})

test('snapCenter never returns -0, which would key differently from 0', () => {
  const { lat, lon } = snapCenter({ lat: -0.0001, lon: -0.0002 })
  assert.ok(Object.is(lat, 0), 'latitude -0 normalised')
  assert.ok(Object.is(lon, 0), 'longitude -0 normalised')
})

test('snapCenter canonicalises the antimeridian to one key', () => {
  // +180 and -180 name the same meridian; a wrap must not split one place in two.
  assert.deepEqual(snapCenter({ lat: -16.5, lon: 179.99991 }).lon, -180)
  assert.deepEqual(snapCenter({ lat: -16.5, lon: -179.99991 }).lon, -180)
})

test('snapCenter wraps a map panned past the edge of the world', () => {
  // Leaflet can hand back a longitude outside [-180, 180) after repeated panning.
  // 362.352° is the same place as 2.352° and must not get its own cache entry.
  assert.deepEqual(snapCenter({ lat: 48.8566, lon: 362.3522 }), snapCenter({ lat: 48.8566, lon: 2.3522 }))
  assert.deepEqual(snapCenter({ lat: 48.8566, lon: -357.6478 }), snapCenter({ lat: 48.8566, lon: 2.3522 }))
})

test('snapCenter clamps an impossible latitude rather than passing it to Overpass', () => {
  assert.equal(snapCenter({ lat: 95, lon: 0 }).lat, 90)
  assert.equal(snapCenter({ lat: -95, lon: 0 }).lat, -90)
})

test('snapCenter cell stays small against the 1500 m search radius', () => {
  // The honesty check behind the whole approach: worst case is a tap on a cell
  // corner, half a diagonal from the centre we actually search around. Widest at
  // the equator, where a degree of longitude is as long as a degree of latitude —
  // ~79 m, about 5% of the radius. Pinned so coarsening the grid has to be a
  // deliberate decision with this number re-checked, not a silent one-char edit.
  const metresPerDegree = 111_320
  const cell = 10 ** -NEARBY_SNAP_DP * metresPerDegree
  const worstOffset = (cell * Math.SQRT2) / 2
  assert.ok(worstOffset < 100, `worst-case offset ${worstOffset.toFixed(0)} m must stay under 100 m`)
  assert.ok(worstOffset / 1500 < 0.06, 'and under 6% of the search radius')
})
