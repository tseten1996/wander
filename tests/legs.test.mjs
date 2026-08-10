/**
 * Unit tests for the leg-grouping derivation (src/features/destinations/legs.ts,
 * issue #197 — multi-destination trips, epic #196).
 *
 * Pure module: it imports only an erased `type`, so the built-in Node test
 * runner exercises it directly (Node strips the TypeScript types on import and
 * never resolves the `@/` alias), matching tests/overlap.test.mjs and
 * tests/spans.test.mjs.
 *
 *   node --test tests/legs.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasRange, hasLegs, legForDay, groupDaysByLeg } from '../src/features/destinations/legs.ts'

// Minimal leg factory — only the fields the derivation reads.
const leg = (id, name, start_date, end_date, position = 0) => ({
  id, name, start_date, end_date, position,
})

const paris = leg('a', 'Paris', '2026-08-01', '2026-08-03', 1)
const amsterdam = leg('b', 'Amsterdam', '2026-08-04', '2026-08-06', 2)
const berlin = leg('c', 'Berlin', '2026-08-07', '2026-08-09', 3)

test('hasRange requires both dates', () => {
  assert.equal(hasRange(paris), true)
  assert.equal(hasRange(leg('x', 'Nowhere', null, null)), false)
  assert.equal(hasRange(leg('x', 'Half', '2026-08-01', null)), false)
  assert.equal(hasRange(leg('x', 'Half', null, '2026-08-01')), false)
})

test('hasLegs is true only when a leg owns days', () => {
  assert.equal(hasLegs([]), false)
  assert.equal(hasLegs([leg('x', 'Named only', null, null)]), false)
  assert.equal(hasLegs([paris]), true)
})

test('legForDay matches inclusive range boundaries', () => {
  assert.equal(legForDay('2026-08-01', [paris, amsterdam]), paris) // start boundary
  assert.equal(legForDay('2026-08-03', [paris, amsterdam]), paris) // end boundary
  assert.equal(legForDay('2026-08-05', [paris, amsterdam]), amsterdam)
  assert.equal(legForDay('2026-08-20', [paris, amsterdam]), null) // no leg
})

test('legForDay: first (earlier) leg wins on overlap', () => {
  const early = leg('e', 'Early', '2026-08-01', '2026-08-05', 1)
  const late = leg('l', 'Late', '2026-08-04', '2026-08-08', 2)
  assert.equal(legForDay('2026-08-04', [early, late]), early)
})

test('groupDaysByLeg with no legs returns one flat headerless group', () => {
  const days = ['2026-08-01', '2026-08-02', '2026-08-03']
  const groups = groupDaysByLeg(days, [])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].leg, null)
  assert.deepEqual(groups[0].days, days)
})

test('groupDaysByLeg with no days returns nothing', () => {
  assert.deepEqual(groupDaysByLeg([], [paris]), [])
  assert.deepEqual(groupDaysByLeg([], []), [])
})

test('groupDaysByLeg buckets consecutive days under their leg', () => {
  const days = [
    '2026-08-01', '2026-08-02', '2026-08-03', // Paris
    '2026-08-04', '2026-08-05', '2026-08-06', // Amsterdam
    '2026-08-07', '2026-08-08', '2026-08-09', // Berlin
  ]
  const groups = groupDaysByLeg(days, [paris, amsterdam, berlin])
  assert.equal(groups.length, 3)
  assert.deepEqual(groups.map((g) => g.leg?.name), ['Paris', 'Amsterdam', 'Berlin'])
  assert.deepEqual(groups[1].days, ['2026-08-04', '2026-08-05', '2026-08-06'])
})

test('groupDaysByLeg collects gap days into an Unassigned run, dropping nothing', () => {
  const days = [
    '2026-08-01', '2026-08-02', // Paris
    '2026-08-11', '2026-08-12', // gap — no leg
    '2026-08-07',               // Berlin
  ]
  const groups = groupDaysByLeg(days, [paris, amsterdam, berlin])
  assert.deepEqual(groups.map((g) => g.leg?.name ?? 'Unassigned'), ['Paris', 'Unassigned', 'Berlin'])
  assert.deepEqual(groups[1].days, ['2026-08-11', '2026-08-12'])
  // Every input day appears exactly once across the groups.
  assert.deepEqual(groups.flatMap((g) => g.days).sort(), [...days].sort())
})

test('groupDaysByLeg starts a fresh group each time the leg changes', () => {
  // Same leg revisited after an Unassigned day makes two separate Paris runs —
  // a timeline reads top-to-bottom, so runs, not identity, define the groups.
  const days = ['2026-08-01', '2026-08-20', '2026-08-02']
  const groups = groupDaysByLeg(days, [paris])
  assert.deepEqual(groups.map((g) => g.leg?.name ?? 'Unassigned'), ['Paris', 'Unassigned', 'Paris'])
})
