/**
 * Unit tests for the itinerary overlap contract (src/features/itinerary/overlap.ts).
 *
 * These exercise the pure `overlapsByItem` derivation directly — no browser, no
 * Supabase, no preview server — using the built-in Node test runner (`node:test`
 * + `node:assert`), matching the "no heavy test dependency" convention of the
 * existing `tests/smoke.mjs` Playwright harness.
 *
 * Node (>= 22.18) strips the TypeScript types from `overlap.ts` on import, so
 * the module is tested exactly as it ships. The `import type` of `ItineraryItem`
 * in that module is erased, so its `@/types` path alias never needs resolving.
 *
 *   node --test tests/overlap.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { overlapsByItem } from '../src/features/itinerary/overlap.ts'

// Minimal itinerary rows: `overlapsByItem` reads only id / start_time / end_time.
let seq = 0
function item(start, end, id) {
  return { id: id ?? `i${++seq}`, start_time: start ?? null, end_time: end ?? null }
}

/** Sorted ids that `overlapsByItem` reports as conflicting with `id`. */
function conflictIds(map, id) {
  return (map.get(id) ?? []).map((it) => it.id).sort()
}

test('items with a missing or empty start_time are never matched', () => {
  const a = item(null, null, 'a') // no start at all
  const b = item('', '10:00', 'b') // empty start
  const c = item('10:00', '11:00', 'c') // the only timed item, alone
  const map = overlapsByItem([a, b, c])
  assert.equal(map.size, 0)
})

test('a missing end_time is a zero-length point: flagged inside an interval, ignored outside', () => {
  const point = item('15:00', null, 'point') // 3:00 PM, no end → point at 15:00
  const around = item('14:00', '16:00', 'around') // 2–4 PM range contains the point
  const after = item('16:00', '17:00', 'after') // 4–5 PM, point falls outside
  const map = overlapsByItem([point, around, after])
  assert.deepEqual(conflictIds(map, 'point'), ['around'])
  assert.deepEqual(conflictIds(map, 'around'), ['point'])
  assert.equal(map.has('after'), false)
})

test('two points conflict only on the same instant', () => {
  const noon1 = item('12:00', null, 'noon1')
  const noon2 = item('12:00', null, 'noon2')
  const one = item('13:00', null, 'one')
  const map = overlapsByItem([noon1, noon2, one])
  assert.deepEqual(conflictIds(map, 'noon1'), ['noon2'])
  assert.deepEqual(conflictIds(map, 'noon2'), ['noon1'])
  assert.equal(map.has('one'), false)
})

test('touching endpoints do not overlap (back-to-back 2–3 PM / 3–4 PM)', () => {
  const first = item('14:00', '15:00', 'first')
  const second = item('15:00', '16:00', 'second')
  const map = overlapsByItem([first, second])
  assert.equal(map.size, 0)
})

test('a point exactly on an interval boundary does not conflict (half-open)', () => {
  const range = item('15:00', '16:00', 'range')
  const atStart = item('15:00', null, 'atStart')
  const atEnd = item('16:00', null, 'atEnd')
  const map = overlapsByItem([range, atStart, atEnd])
  assert.equal(map.size, 0)
})

test('a malformed end-before-start is clamped to a point', () => {
  // start 10:00, end 09:00 → clamped up to a point at 10:00.
  const inverted = item('10:00', '09:00', 'inverted')
  const covering = item('09:30', '10:30', 'covering') // contains the clamped point
  const disjoint = item('10:30', '11:00', 'disjoint') // point falls outside
  const map = overlapsByItem([inverted, covering, disjoint])
  assert.deepEqual(conflictIds(map, 'inverted'), ['covering'])
  assert.deepEqual(conflictIds(map, 'covering'), ['inverted'])
  assert.equal(map.has('disjoint'), false)
})

test('overlapping intervals are flagged and the map is bidirectional', () => {
  const museum = item('14:00', '16:00', 'museum') // 2–4 PM
  const lunch = item('15:00', '16:00', 'lunch') // 3–4 PM, overlaps museum
  const map = overlapsByItem([museum, lunch])
  assert.deepEqual(conflictIds(map, 'museum'), ['lunch'])
  assert.deepEqual(conflictIds(map, 'lunch'), ['museum'])
})

test('a three-way same-interval overlap lists all others per item', () => {
  const a = item('09:00', '10:00', 'a')
  const b = item('09:00', '10:00', 'b')
  const c = item('09:00', '10:00', 'c')
  const map = overlapsByItem([a, b, c])
  assert.deepEqual(conflictIds(map, 'a'), ['b', 'c'])
  assert.deepEqual(conflictIds(map, 'b'), ['a', 'c'])
  assert.deepEqual(conflictIds(map, 'c'), ['a', 'b'])
})
