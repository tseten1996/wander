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
