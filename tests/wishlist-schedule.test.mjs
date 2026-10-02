/**
 * Unit tests for the schedule-from-wishlist helpers
 * (src/features/wishlist/schedule.ts, #377 — epic #164 slice 3).
 *
 * Pure module (it imports only date-fns + erased types), so the built-in Node
 * test runner exercises it directly — Node strips the TypeScript types on
 * import, matching tests/spans.test.mjs.
 *
 *   node --test tests/wishlist-schedule.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WISHLIST_TO_ITINERARY,
  itineraryCategoryFor,
  tripScheduleDays,
} from '../src/features/wishlist/schedule.ts'

test('wishlist categories map to sensible itinerary types', () => {
  // Mirrors slice 1's map "Add to itinerary": a sight is an activity, an
  // eatery/bar is a restaurant stop.
  assert.equal(itineraryCategoryFor('eat'), 'restaurant')
  assert.equal(itineraryCategoryFor('drink'), 'restaurant')
  assert.equal(itineraryCategoryFor('see'), 'activity')
  assert.equal(itineraryCategoryFor('other'), 'activity')
  // The mapping table covers every wishlist bucket.
  assert.deepEqual(Object.keys(WISHLIST_TO_ITINERARY).sort(), ['drink', 'eat', 'other', 'see'])
})

test('a null (uncategorised) save prefills the generic activity type', () => {
  assert.equal(itineraryCategoryFor(null), 'activity')
})

test('every mapped itinerary type is a real itinerary category', () => {
  const valid = new Set(['flight', 'hotel', 'activity', 'restaurant', 'transport', 'free'])
  for (const type of Object.values(WISHLIST_TO_ITINERARY)) assert.ok(valid.has(type))
})

test('tripScheduleDays enumerates the trip range inclusively, in order', () => {
  assert.deepEqual(tripScheduleDays('2026-10-05', '2026-10-08'), [
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
  ])
})

test('tripScheduleDays returns a single day for a one-day trip', () => {
  assert.deepEqual(tripScheduleDays('2026-10-05', '2026-10-05'), ['2026-10-05'])
})

test('tripScheduleDays is empty for a dateless or half-dated trip', () => {
  assert.deepEqual(tripScheduleDays(null, null), [])
  assert.deepEqual(tripScheduleDays('2026-10-05', null), [])
  assert.deepEqual(tripScheduleDays(null, '2026-10-08'), [])
  assert.deepEqual(tripScheduleDays(undefined, undefined), [])
})

test('tripScheduleDays rejects an inverted range rather than throwing', () => {
  assert.deepEqual(tripScheduleDays('2026-10-08', '2026-10-05'), [])
})
