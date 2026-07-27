/**
 * Unit tests for the zero-cost geo helpers (src/lib/geo.ts) that back the
 * itinerary "leg distance & rough travel time" hint (#123, Map epic slice 3).
 *
 * Like tests/overlap.test.mjs, these run against the TypeScript source directly:
 * Node (>= 22.18) strips the types on import, and geo.ts imports nothing from
 * `@/types`, so no path alias ever needs resolving.
 *
 *   node --test tests/geo.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  haversineKm,
  estimateLeg,
  toGeoPoint,
  formatLeg,
} from '../src/lib/geo.ts'

const p = (latitude, longitude) => ({ latitude, longitude })

test('haversineKm is zero for identical points', () => {
  assert.equal(haversineKm(p(35.6, 139.7), p(35.6, 139.7)), 0)
})

test('haversineKm ≈ 111.19 km for one degree of latitude', () => {
  const d = haversineKm(p(0, 0), p(1, 0))
  assert.ok(Math.abs(d - 111.19) < 0.1, `expected ~111.19, got ${d}`)
})

test('haversineKm matches a known city pair (London → Paris ≈ 343 km)', () => {
  const d = haversineKm(p(51.5074, -0.1278), p(48.8566, 2.3522))
  assert.ok(Math.abs(d - 343) < 5, `expected ~343 km, got ${d}`)
})

test('haversineKm is symmetric', () => {
  const a = p(40.7128, -74.006)
  const b = p(34.0522, -118.2437)
  assert.equal(haversineKm(a, b), haversineKm(b, a))
})

test('estimateLeg assumes walking for a short hop and computes minutes from km', () => {
  // ~0.5 km apart (0.0045° of latitude ≈ 500 m).
  const est = estimateLeg(p(0, 0), p(0.0045, 0))
  assert.equal(est.mode, 'walk')
  assert.ok(est.km < 1, `expected < 1 km, got ${est.km}`)
  // minutes = km / 4.8 km/h * 60 — internally consistent with the returned km.
  assert.ok(Math.abs(est.minutes - (est.km / 4.8) * 60) < 1e-9)
})

test('estimateLeg assumes driving for a longer hop', () => {
  // ~5.5 km apart (0.05° of latitude).
  const est = estimateLeg(p(0, 0), p(0.05, 0))
  assert.equal(est.mode, 'drive')
  assert.ok(est.km > 1.5, `expected > 1.5 km, got ${est.km}`)
  assert.ok(Math.abs(est.minutes - (est.km / 30) * 60) < 1e-9)
})

test('toGeoPoint accepts finite coordinates', () => {
  assert.deepEqual(toGeoPoint({ latitude: 12.3, longitude: -45.6 }), {
    latitude: 12.3,
    longitude: -45.6,
  })
  // Zero is a valid coordinate (the equator / prime meridian), not "missing".
  assert.deepEqual(toGeoPoint({ latitude: 0, longitude: 0 }), {
    latitude: 0,
    longitude: 0,
  })
})

test('toGeoPoint rejects missing, null, and non-finite coordinates', () => {
  assert.equal(toGeoPoint({ latitude: null, longitude: 2 }), null)
  assert.equal(toGeoPoint({ latitude: 1, longitude: null }), null)
  assert.equal(toGeoPoint({ latitude: 1 }), null)
  assert.equal(toGeoPoint({}), null)
  assert.equal(toGeoPoint({ latitude: NaN, longitude: 2 }), null)
  assert.equal(toGeoPoint({ latitude: 1, longitude: Infinity }), null)
})

test('formatLeg shows metres under a kilometre and km at or above', () => {
  assert.equal(formatLeg({ km: 0.42, minutes: 5, mode: 'walk' }).distance, '420 m')
  assert.equal(formatLeg({ km: 0.023, minutes: 1, mode: 'walk' }).distance, '20 m')
  assert.equal(formatLeg({ km: 4.23, minutes: 12, mode: 'drive' }).distance, '4.2 km')
  // A hair under a metre still reads as a positive distance, never "0 m".
  assert.equal(formatLeg({ km: 0.0004, minutes: 0.1, mode: 'walk' }).distance, '1 m')
})

test('formatLeg reads minutes, rolls into hours past 60, and floors at 1 min', () => {
  assert.equal(formatLeg({ km: 4, minutes: 12, mode: 'drive' }).duration, '12 min')
  assert.equal(formatLeg({ km: 0.1, minutes: 0.2, mode: 'walk' }).duration, '1 min')
  assert.equal(formatLeg({ km: 60, minutes: 75, mode: 'drive' }).duration, '1 h 15 min')
  assert.equal(formatLeg({ km: 96, minutes: 120, mode: 'drive' }).duration, '2 h')
})
