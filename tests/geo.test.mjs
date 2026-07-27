/**
 * Unit tests for src/lib/geo.ts — the zero-cost itinerary-leg estimates added
 * for the Map epic slice 3 (#123): haversine distance, the mode/time heuristic,
 * and the display formatters. Pure functions, no network, no browser.
 *
 * Same convention as tests/overlap.test.mjs: Node (>= 22.18) strips the
 * TypeScript types on import, and geo.ts is a leaf module whose only exports
 * consumed here are runtime values, so the `@/` alias never needs resolving.
 *
 *   node --test tests/geo.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  haversineKm,
  estimateLeg,
  formatDistance,
  formatDuration,
} from '../src/lib/geo.ts'

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected} (±${tol})`)

test('haversineKm: identical points are zero distance', () => {
  assert.equal(haversineKm({ latitude: 48.85, longitude: 2.35 }, { latitude: 48.85, longitude: 2.35 }), 0)
})

test('haversineKm: one degree ≈ 111 km, and it is symmetric', () => {
  const a = { latitude: 0, longitude: 0 }
  const b = { latitude: 0, longitude: 1 }
  near(haversineKm(a, b), 111.19, 0.5, 'one degree of longitude at the equator')
  assert.equal(haversineKm(a, b), haversineKm(b, a))
})

test('haversineKm: a known city pair (Paris → London ≈ 344 km)', () => {
  const paris = { latitude: 48.8566, longitude: 2.3522 }
  const london = { latitude: 51.5074, longitude: -0.1278 }
  near(haversineKm(paris, london), 344, 5, 'Paris to London great-circle')
})

test('estimateLeg: a short hop reads as a walk', () => {
  // ~0.56 km apart — under the walk threshold.
  const leg = estimateLeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.005 })
  assert.equal(leg.mode, 'walk')
  assert.ok(leg.distanceKm < 1.5)
  near(leg.minutes, (leg.distanceKm / 4.8) * 60, 1e-6, 'walk minutes from 4.8 km/h')
  assert.ok(leg.minutes > 0)
})

test('estimateLeg: a longer hop reads as a drive', () => {
  // ~11 km apart — above the walk threshold.
  const leg = estimateLeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.1 })
  assert.equal(leg.mode, 'drive')
  assert.ok(leg.distanceKm > 1.5)
  near(leg.minutes, (leg.distanceKm / 32) * 60, 1e-6, 'drive minutes from 32 km/h')
})

test('formatDistance: metres under 1 km, one decimal under 10 km, whole beyond', () => {
  assert.equal(formatDistance(0.82), '820 m')
  assert.equal(formatDistance(0.0), '0 m')
  assert.equal(formatDistance(4.23), '4.2 km')
  assert.equal(formatDistance(9.4), '9.4 km')
  assert.equal(formatDistance(37.4), '37 km')
})

test('formatDuration: sub-minute, minutes, and hours', () => {
  assert.equal(formatDuration(0.5), '<1 min')
  assert.equal(formatDuration(12.4), '12 min')
  assert.equal(formatDuration(59.6), '1 h')
  assert.equal(formatDuration(65), '1 h 5 min')
  assert.equal(formatDuration(120), '2 h')
})
