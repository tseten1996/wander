/**
 * Unit tests for the transport-for-a-day derivation
 * (src/features/transport/dates.ts, issue #350 — trip transport, epic #346
 * slice 2).
 *
 * Pure module: it imports only an erased `type`, so the built-in Node test
 * runner exercises it directly (Node strips the TypeScript types on import and
 * never resolves the `@/` alias), matching tests/stays.test.mjs.
 *
 *   node --test tests/transport.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  arrivingOn, dayOf, departingOn, hasTransportOn,
} from '../src/features/transport/dates.ts'

// Minimal hop factory — only the fields the derivation reads.
const hop = (id, mode, depart_at, arrive_at) => ({ id, mode, depart_at, arrive_at })

// A same-day Paris→Amsterdam train and an overnight ferry that crosses midnight.
const train = hop('a', 'train', '2026-06-01T14:30', '2026-06-01T17:45')
const ferry = hop('b', 'ferry', '2026-06-03T22:00', '2026-06-04T06:30')
const tbd = hop('c', 'bus', null, null) // mode known, times TBD

test('dayOf takes the date prefix, timezone-immune', () => {
  assert.equal(dayOf('2026-06-01T14:30'), '2026-06-01')
  assert.equal(dayOf('2026-06-03T22:00:00'), '2026-06-03') // trailing seconds tolerated
  assert.equal(dayOf(null), null)
})

test('departingOn matches the departure day only', () => {
  assert.deepEqual(departingOn('2026-06-01', [train, ferry]), [train])
  assert.deepEqual(departingOn('2026-06-03', [train, ferry]), [ferry])
  // The ferry ARRIVES on the 4th but does not DEPART then.
  assert.deepEqual(departingOn('2026-06-04', [train, ferry]), [])
})

test('arrivingOn matches the arrival day only', () => {
  assert.deepEqual(arrivingOn('2026-06-01', [train, ferry]), [train])
  assert.deepEqual(arrivingOn('2026-06-04', [train, ferry]), [ferry])
  assert.deepEqual(arrivingOn('2026-06-03', [train, ferry]), [])
})

test('an overnight hop surfaces on both its depart and arrive days', () => {
  assert.deepEqual(departingOn('2026-06-03', [ferry]), [ferry])
  assert.deepEqual(arrivingOn('2026-06-04', [ferry]), [ferry])
})

test('hasTransportOn is true on any depart or arrive day', () => {
  assert.equal(hasTransportOn('2026-06-01', [train, ferry]), true) // train depart+arrive
  assert.equal(hasTransportOn('2026-06-03', [train, ferry]), true) // ferry depart
  assert.equal(hasTransportOn('2026-06-04', [train, ferry]), true) // ferry arrive
  assert.equal(hasTransportOn('2026-06-02', [train, ferry]), false) // gap day
})

test('a time-TBD hop is on no day', () => {
  assert.deepEqual(departingOn('2026-06-01', [tbd]), [])
  assert.deepEqual(arrivingOn('2026-06-01', [tbd]), [])
  assert.equal(hasTransportOn('2026-06-01', [tbd]), false)
})

test('empty list yields nothing', () => {
  assert.deepEqual(departingOn('2026-06-01', []), [])
  assert.deepEqual(arrivingOn('2026-06-01', []), [])
  assert.equal(hasTransportOn('2026-06-01', []), false)
})
