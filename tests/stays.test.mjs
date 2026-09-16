/**
 * Unit tests for the stay-for-a-day derivation (src/features/stays/dates.ts,
 * issue #348 — trip lodging, epic #346 slice 1).
 *
 * Pure module: it imports only an erased `type`, so the built-in Node test
 * runner exercises it directly (Node strips the TypeScript types on import and
 * never resolves the `@/` alias), matching tests/legs.test.mjs.
 *
 *   node --test tests/stays.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasDates, stayForDay } from '../src/features/stays/dates.ts'

// Minimal stay factory — only the fields the derivation reads.
const stay = (id, name, check_in, check_out) => ({ id, name, check_in, check_out })

const hotel = stay('a', 'Hotel', '2026-08-01', '2026-08-04') // sleep 1,2,3
const airbnb = stay('b', 'Airbnb', '2026-08-04', '2026-08-06') // sleep 4,5

test('hasDates requires both check-in and check-out', () => {
  assert.equal(hasDates(hotel), true)
  assert.equal(hasDates(stay('x', 'None', null, null)), false)
  assert.equal(hasDates(stay('x', 'Half', '2026-08-01', null)), false)
  assert.equal(hasDates(stay('x', 'Half', null, '2026-08-04')), false)
})

test('stayForDay covers check-in through the night before check-out', () => {
  assert.equal(stayForDay('2026-08-01', [hotel]), hotel) // check-in night
  assert.equal(stayForDay('2026-08-02', [hotel]), hotel) // middle
  assert.equal(stayForDay('2026-08-03', [hotel]), hotel) // last night
})

test('stayForDay excludes the check-out morning (half-open range)', () => {
  // The seam: you do NOT sleep at the hotel on the 4th — that's the Airbnb.
  assert.equal(stayForDay('2026-08-04', [hotel]), null)
  assert.equal(stayForDay('2026-08-04', [hotel, airbnb]), airbnb)
})

test('stayForDay returns null outside every window', () => {
  assert.equal(stayForDay('2026-07-31', [hotel, airbnb]), null)
  assert.equal(stayForDay('2026-08-06', [hotel, airbnb]), null) // airbnb check-out morning
  assert.equal(stayForDay('2026-08-10', [hotel, airbnb]), null)
})

test('stayForDay ignores dateless / half-dated stays', () => {
  const named = stay('c', 'Named only', null, null)
  const half = stay('d', 'Half', '2026-08-02', null)
  assert.equal(stayForDay('2026-08-02', [named, half]), null)
})

test('stayForDay: earliest-listed match wins on overlap', () => {
  // Hand-entered dates can overlap; the first in the (check-in-sorted) list wins.
  const early = stay('e', 'Early', '2026-08-01', '2026-08-05')
  const late = stay('f', 'Late', '2026-08-03', '2026-08-06')
  assert.equal(stayForDay('2026-08-04', [early, late]), early)
})

test('stayForDay returns null for an empty list', () => {
  assert.equal(stayForDay('2026-08-01', []), null)
})
