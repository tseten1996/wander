/**
 * Unit tests for the pure surface of the keyless Photon geocoder
 * (src/lib/geocode.ts) that backs "pin a typed address on save" (#201).
 *
 * Like tests/places.test.mjs, these run against the TypeScript source directly:
 * Node (>= 22.18) strips the types on import, and geocode.ts imports nothing
 * from `@/types`, so no path alias ever needs resolving. Only the pure,
 * network-free parser is exercised here — the `fetch` in `geocodeFirst` /
 * `searchPlaces` is covered by the app's smoke/manual paths.
 *
 *   node --test tests/geocode.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFirstCoords, formatPlaceLabel } from '../src/lib/geocode.ts'

const feature = (lon, lat) => ({ geometry: { coordinates: [lon, lat] }, properties: {} })

test('parseFirstCoords returns the first feature as { lat, lon }', () => {
  // Photon emits GeoJSON [lon, lat]; the app convention is { lat, lon }.
  const data = { features: [feature(2.3007, 48.8698), feature(0, 0)] }
  assert.deepEqual(parseFirstCoords(data), { lat: 48.8698, lon: 2.3007 })
})

test('parseFirstCoords treats 0,0 as a real coordinate, not "missing"', () => {
  assert.deepEqual(parseFirstCoords({ features: [feature(0, 0)] }), { lat: 0, lon: 0 })
})

test('parseFirstCoords skips malformed features and takes the first usable one', () => {
  const data = {
    features: [
      null,
      { geometry: {} }, // no coordinates
      { geometry: { coordinates: [1] } }, // too short
      { geometry: { coordinates: ['x', 2] } }, // non-numeric
      feature(-9.14, 38.71),
    ],
  }
  assert.deepEqual(parseFirstCoords(data), { lat: 38.71, lon: -9.14 })
})

test('parseFirstCoords returns null for no matches or junk input', () => {
  assert.equal(parseFirstCoords({ features: [] }), null)
  assert.equal(parseFirstCoords({}), null)
  assert.equal(parseFirstCoords(null), null)
  assert.equal(parseFirstCoords(undefined), null)
  assert.equal(parseFirstCoords({ features: 'nope' }), null)
})

test('formatPlaceLabel joins unique, present parts', () => {
  assert.equal(
    formatPlaceLabel({ name: 'Louvre', city: 'Paris', country: 'France' }),
    'Louvre, Paris, France',
  )
  // Duplicate parts collapse (name === city).
  assert.equal(formatPlaceLabel({ name: 'Paris', city: 'Paris', country: 'France' }), 'Paris, France')
})
