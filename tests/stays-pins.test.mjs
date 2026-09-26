/**
 * Unit tests for the stay map-pin derivation (src/features/stays/pins.ts,
 * issue #371 — pin the stays on the trip map, epic #346).
 *
 * Pure module: it imports only an erased `type`, so the built-in Node test
 * runner exercises it directly (Node strips the TypeScript types on import and
 * never resolves the `@/` alias), matching tests/stays.test.mjs.
 *
 *   node --test tests/stays-pins.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasPin, staysWithPin } from '../src/features/stays/pins.ts'

// Minimal stay factory — only the fields the derivation reads.
const stay = (id, name, latitude, longitude) => ({ id, name, latitude, longitude })

const pinned = stay('a', 'Hotel', 48.8566, 2.3522)
const noPin = stay('b', 'Airbnb (no pin yet)', null, null)
const halfPin = stay('c', 'Half', 48.85, null)

test('hasPin requires both coordinates to be real finite numbers', () => {
  assert.equal(hasPin(pinned), true)
  assert.equal(hasPin(noPin), false)
  assert.equal(hasPin(halfPin), false)
  assert.equal(hasPin(stay('x', 'NaN', Number.NaN, 2)), false)
  assert.equal(hasPin(stay('x', 'Infinity', Infinity, 2)), false)
})

test('the origin (0, 0) is a valid pin', () => {
  // 0 is falsy but a real coordinate — a truthiness check would wrongly drop it.
  assert.equal(hasPin(stay('z', 'Null Island', 0, 0)), true)
})

test('staysWithPin keeps only pinned stays, in input order', () => {
  const result = staysWithPin([pinned, noPin, halfPin])
  assert.deepEqual(
    result.map((s) => s.id),
    ['a'],
  )
})

test('staysWithPin returns an empty array when nothing has a pin', () => {
  assert.deepEqual(staysWithPin([noPin, halfPin]), [])
  assert.deepEqual(staysWithPin([]), [])
})
