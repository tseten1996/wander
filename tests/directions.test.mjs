/**
 * Unit tests for the "Directions for this day" link builder
 * (src/features/itinerary/directions.ts, #167) — the multi-stop Google Maps
 * Directions URL over a day's ordered, geocoded stops.
 *
 * Like tests/geo.test.mjs, these run against the TypeScript source directly:
 * Node (>= 22.18) strips the types on import, and directions.ts imports nothing
 * from `@/types`, so no path alias ever needs resolving.
 *
 *   node --test tests/directions.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  locatedStops,
  googleMapsDirectionsUrl,
  buildDayDirections,
  MAX_ROUTE_STOPS,
} from '../src/features/itinerary/directions.ts'

const stop = (latitude, longitude, extra = {}) => ({ latitude, longitude, ...extra })

test('locatedStops keeps only finite coordinates, in order', () => {
  const items = [
    stop(1, 1, { id: 'a' }),
    { id: 'b', latitude: null, longitude: 2 },
    stop(3, 3, { id: 'c' }),
    { id: 'd', latitude: 4 }, // longitude missing
    stop(0, 0, { id: 'e' }), // equator/prime meridian are valid, not "missing"
  ]
  assert.deepEqual(
    locatedStops(items).map((i) => i.id),
    ['a', 'c', 'e']
  )
})

test('locatedStops rejects NaN and Infinity coordinates', () => {
  const items = [
    stop(NaN, 1, { id: 'a' }),
    stop(1, Infinity, { id: 'b' }),
    stop(2, 2, { id: 'c' }),
  ]
  assert.deepEqual(
    locatedStops(items).map((i) => i.id),
    ['c']
  )
})

test('googleMapsDirectionsUrl returns null for fewer than two stops', () => {
  assert.equal(googleMapsDirectionsUrl([]), null)
  assert.equal(googleMapsDirectionsUrl([stop(1, 1)]), null)
})

test('two stops become origin + destination with no waypoints', () => {
  const url = googleMapsDirectionsUrl([stop(35.6, 139.7), stop(35.7, 139.8)])
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1'))
  assert.ok(url.includes('origin=35.6,139.7'))
  assert.ok(url.includes('destination=35.7,139.8'))
  assert.ok(url.includes('travelmode=driving'))
  assert.ok(!url.includes('waypoints='))
})

test('intermediate stops become pipe-encoded waypoints in order', () => {
  const url = googleMapsDirectionsUrl([
    stop(1, 1),
    stop(2, 2),
    stop(3, 3),
    stop(4, 4),
  ])
  assert.ok(url.includes('origin=1,1'))
  assert.ok(url.includes('destination=4,4'))
  // The two middle stops, in order, joined by an encoded pipe.
  assert.ok(url.includes('waypoints=2,2%7C3,3'), url)
})

test('travelmode is honoured when overridden', () => {
  const url = googleMapsDirectionsUrl([stop(1, 1), stop(2, 2)], 'walking')
  assert.ok(url.includes('travelmode=walking'))
})

test('coordinates are rounded to ~0.1 m so URLs stay tidy', () => {
  const url = googleMapsDirectionsUrl([stop(1.123456789, -2.987654321), stop(3, 3)])
  assert.ok(url.includes('origin=1.123457,-2.987654'), url)
})

test('a route longer than the Google cap is truncated to the first MAX_ROUTE_STOPS', () => {
  const many = Array.from({ length: MAX_ROUTE_STOPS + 3 }, (_, i) => stop(i, i))
  const url = googleMapsDirectionsUrl(many)
  // Origin is the first stop; destination is the LAST stop within the cap, not
  // the true last stop — the tail is dropped rather than mis-routed.
  assert.ok(url.includes('origin=0,0'))
  assert.ok(url.includes(`destination=${MAX_ROUTE_STOPS - 1},${MAX_ROUTE_STOPS - 1}`))
  const waypointCount = url.match(/%7C/g).length + 1
  assert.equal(waypointCount, MAX_ROUTE_STOPS - 2) // stops between origin and destination
})

test('buildDayDirections returns null when fewer than two stops are geocoded', () => {
  assert.equal(buildDayDirections([]), null)
  assert.equal(buildDayDirections([stop(1, 1)]), null)
  assert.equal(
    buildDayDirections([stop(1, 1), { latitude: null, longitude: null }]),
    null
  )
})

test('buildDayDirections reports full coverage when every stop is located', () => {
  const d = buildDayDirections([stop(1, 1), stop(2, 2), stop(3, 3)])
  assert.equal(d.included, 3)
  assert.equal(d.total, 3)
  assert.equal(d.omitted, false)
  assert.ok(d.url.includes('waypoints=2,2'))
})

test('buildDayDirections flags omitted stops when some lack coordinates', () => {
  const d = buildDayDirections([
    stop(1, 1),
    { latitude: null, longitude: null }, // no location yet
    stop(3, 3),
  ])
  assert.equal(d.included, 2)
  assert.equal(d.total, 3)
  assert.equal(d.omitted, true)
})

test('buildDayDirections flags omission when the day exceeds the cap', () => {
  const many = Array.from({ length: MAX_ROUTE_STOPS + 2 }, (_, i) => stop(i, i))
  const d = buildDayDirections(many)
  assert.equal(d.included, MAX_ROUTE_STOPS)
  assert.equal(d.total, MAX_ROUTE_STOPS + 2)
  assert.equal(d.omitted, true)
})
