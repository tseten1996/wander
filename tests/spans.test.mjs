/**
 * Unit tests for the multi-day span helpers (src/features/itinerary/spans.ts,
 * issue #166 — overnight / multi-day itinerary items).
 *
 * Pure module, exercised directly with the built-in Node test runner
 * (`node:test` + `node:assert`), matching tests/overlap.test.mjs. Node strips
 * the TypeScript types on import, so the module is tested exactly as it ships.
 *
 *   node --test tests/spans.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSpanning,
  coveredDays,
  spanPosition,
  spansCovering,
} from '../src/features/itinerary/spans.ts'

test('isSpanning is true only for a real later end_day', () => {
  assert.equal(isSpanning({ day: '2026-08-15', end_day: '2026-08-18' }), true)
  // Same-day end is not a span.
  assert.equal(isSpanning({ day: '2026-08-15', end_day: '2026-08-15' }), false)
  // A single-day item (no end_day) is not a span.
  assert.equal(isSpanning({ day: '2026-08-15', end_day: null }), false)
  assert.equal(isSpanning({ day: '2026-08-15' }), false)
  // An undated item cannot span.
  assert.equal(isSpanning({ day: null, end_day: '2026-08-18' }), false)
  // An inverted range is not treated as a span (defends the render path even
  // though the DB CHECK and the form both reject one).
  assert.equal(isSpanning({ day: '2026-08-18', end_day: '2026-08-15' }), false)
})

test('coveredDays lists every inclusive day of a span in order', () => {
  assert.deepEqual(coveredDays({ day: '2026-08-15', end_day: '2026-08-18' }), [
    '2026-08-15',
    '2026-08-16',
    '2026-08-17',
    '2026-08-18',
  ])
})

test('coveredDays crosses a month boundary without drift', () => {
  assert.deepEqual(coveredDays({ day: '2026-07-30', end_day: '2026-08-02' }), [
    '2026-07-30',
    '2026-07-31',
    '2026-08-01',
    '2026-08-02',
  ])
})

test('coveredDays of a single-day item is just its day; undated is empty', () => {
  assert.deepEqual(coveredDays({ day: '2026-08-15', end_day: null }), ['2026-08-15'])
  assert.deepEqual(coveredDays({ day: '2026-08-15' }), ['2026-08-15'])
  assert.deepEqual(coveredDays({ day: null }), [])
})

test('spanPosition reports 1-based index and total for a covered day', () => {
  const stay = { day: '2026-08-15', end_day: '2026-08-18' }
  assert.deepEqual(spanPosition(stay, '2026-08-15'), { index: 1, total: 4 })
  assert.deepEqual(spanPosition(stay, '2026-08-17'), { index: 3, total: 4 })
  assert.deepEqual(spanPosition(stay, '2026-08-18'), { index: 4, total: 4 })
  // A day outside the span, or a non-span item, has no position.
  assert.equal(spanPosition(stay, '2026-08-19'), null)
  assert.equal(spanPosition({ day: '2026-08-15', end_day: null }, '2026-08-15'), null)
})

test('spansCovering picks the spans that include a given day', () => {
  const hotel = { id: 'h', day: '2026-08-15', end_day: '2026-08-18' }
  const rail = { id: 'r', day: '2026-08-16', end_day: '2026-08-20' }
  const dinner = { id: 'd', day: '2026-08-17', end_day: null } // single-day, never a band
  const items = [hotel, rail, dinner]
  assert.deepEqual(spansCovering(items, '2026-08-15').map((i) => i.id), ['h'])
  assert.deepEqual(spansCovering(items, '2026-08-17').map((i) => i.id), ['h', 'r'])
  assert.deepEqual(spansCovering(items, '2026-08-20').map((i) => i.id), ['r'])
  assert.deepEqual(spansCovering(items, '2026-08-21').map((i) => i.id), [])
})
