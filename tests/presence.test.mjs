/**
 * Unit tests for the member-presence helpers (src/lib/presence.ts), focused on
 * `suggestedParticipants` — the presence-aware expense default (#304, epic #285
 * slice 2) — with a couple of guards on the `presentOn` window it builds on.
 *
 * Pure date module, exercised directly with the built-in Node test runner
 * (`node:test` + `node:assert`), matching tests/overlap.test.mjs. Node strips
 * the TypeScript types on import, and the `import type` of Member/Trip from
 * `@/types` is erased, so the module is tested exactly as it ships with no path
 * alias to resolve.
 *
 *   node --test tests/presence.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  suggestedParticipants,
  presentOn,
  hasPresenceDates,
} from '../src/lib/presence.ts'

// Minimal member rows: the helpers read only id / arrives_on / departs_on.
function member(id, arrives_on = null, departs_on = null) {
  return { id, arrives_on, departs_on }
}

// A trip spanning Thu–Sun. Staggered arrivals land inside it.
const TRIP = { start_date: '2026-06-04', end_date: '2026-06-07' }

const ANA = member('ana') // no dates → whole trip
const BEN = member('ben', '2026-06-05') // arrives Friday
const CID = member('cid', '2026-06-06', '2026-06-06') // only Saturday

test('with no date set, the suggestion is everyone (historic default)', () => {
  const members = [ANA, BEN, CID]
  assert.deepEqual(suggestedParticipants(members, '', TRIP), ['ana', 'ben', 'cid'])
  assert.deepEqual(suggestedParticipants(members, null, TRIP), ['ana', 'ben', 'cid'])
  assert.deepEqual(suggestedParticipants(members, undefined, TRIP), ['ana', 'ben', 'cid'])
})

test('when no member has dates set, every date suggests everyone', () => {
  const members = [member('ana'), member('ben')]
  assert.equal(hasPresenceDates(members), false)
  assert.deepEqual(suggestedParticipants(members, '2026-06-05', TRIP), ['ana', 'ben'])
})

test('a staggered day pre-selects only who was present, in member order', () => {
  const members = [ANA, BEN, CID]
  // Thursday: only Ana (undated → whole trip). Ben lands Friday, Cid Saturday.
  assert.deepEqual(suggestedParticipants(members, '2026-06-04', TRIP), ['ana'])
  // Friday: Ana + Ben. Cid not yet.
  assert.deepEqual(suggestedParticipants(members, '2026-06-05', TRIP), ['ana', 'ben'])
  // Saturday: everyone's window covers it.
  assert.deepEqual(suggestedParticipants(members, '2026-06-06', TRIP), ['ana', 'ben', 'cid'])
  // Sunday: Cid already departed Saturday.
  assert.deepEqual(suggestedParticipants(members, '2026-06-07', TRIP), ['ana', 'ben'])
})

test('a date outside every window falls back to everyone, never an empty split', () => {
  // Two dated members, both arriving Friday; a Thursday expense matches nobody.
  const members = [member('ben', '2026-06-05'), member('cid', '2026-06-05')]
  assert.deepEqual(presentOn(members, '2026-06-04', TRIP), [])
  assert.deepEqual(suggestedParticipants(members, '2026-06-04', TRIP), ['ben', 'cid'])
})

test('null trip bounds leave a dated member unbounded on that side', () => {
  // Open-ended trip: only the member arrival narrows presence.
  const openTrip = { start_date: null, end_date: null }
  const members = [member('ana'), member('ben', '2026-06-05')]
  // Before Ben arrives: only Ana (undated, and trip is unbounded → always here).
  assert.deepEqual(suggestedParticipants(members, '2026-06-04', openTrip), ['ana'])
  // On/after: both.
  assert.deepEqual(suggestedParticipants(members, '2026-06-05', openTrip), ['ana', 'ben'])
})
