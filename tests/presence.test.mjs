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
  absentOn,
  describeAbsence,
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

// --- absentOn / describeAbsence: the itinerary miss-flag (#303) ---

// Named members so the flag wording can be asserted. arrives_on / departs_on
// mirror the `member` helper positions.
function named(id, name, arrives_on = null, departs_on = null) {
  return { id, display_name: name, arrives_on, departs_on }
}

test('an undated member is never absent — no flag on a dateless trip', () => {
  const members = [named('a', 'Ana'), named('b', 'Ben')]
  const absence = absentOn(members, '2026-06-05')
  assert.deepEqual(absence, { arriving: [], departed: [] })
  assert.equal(describeAbsence(absence), null)
})

test('absentOn splits by reason using only the member’s own dates', () => {
  const members = [
    named('ana', 'Ana'), // undated → present, never flagged
    named('ben', 'Ben', '2026-06-06'), // arrives Saturday
    named('pri', 'Priya', null, '2026-06-05'), // leaves after Friday
  ]
  // Thursday: Ben not here yet; Priya still present (leaves Fri).
  const thu = absentOn(members, '2026-06-04')
  assert.deepEqual(thu.arriving.map((m) => m.id), ['ben'])
  assert.deepEqual(thu.departed.map((m) => m.id), [])
  // Sunday: Ben has arrived; Priya has left.
  const sun = absentOn(members, '2026-06-07')
  assert.deepEqual(sun.arriving.map((m) => m.id), [])
  assert.deepEqual(sun.departed.map((m) => m.id), ['pri'])
})

test('a member set to arrive only is never "left" after the trip window', () => {
  // departs_on null = present to the end, so a late day flags nobody as gone.
  const members = [named('ben', 'Ben', '2026-06-05')]
  assert.deepEqual(absentOn(members, '2026-12-31'), { arriving: [], departed: [] })
})

test('describeAbsence reads like a person, singular and plural', () => {
  assert.equal(
    describeAbsence({ arriving: [named('s', 'Sam', '2026-06-06')], departed: [] }),
    "Sam isn't here yet",
  )
  assert.equal(
    describeAbsence({ arriving: [], departed: [named('p', 'Priya', null, '2026-06-04')] }),
    'Priya has left',
  )
  assert.equal(
    describeAbsence({
      arriving: [named('s', 'Sam'), named('a', 'Alex')],
      departed: [],
    }),
    "Sam and Alex aren't here yet",
  )
  // Both reasons on one day are joined into a single quiet line.
  assert.equal(
    describeAbsence({
      arriving: [named('s', 'Sam')],
      departed: [named('p', 'Priya'), named('j', 'Jo')],
    }),
    "Sam isn't here yet · Priya and Jo have left",
  )
  // Three names use the Oxford-free "a, b and c" form.
  assert.equal(
    describeAbsence({
      arriving: [named('s', 'Sam'), named('a', 'Alex'), named('k', 'Kai')],
      departed: [],
    }),
    "Sam, Alex and Kai aren't here yet",
  )
})
