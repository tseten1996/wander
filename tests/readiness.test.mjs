/**
 * Unit tests for the pre-trip **Before you go** readiness derivations in
 * src/features/dashboard/readiness.ts (#414). The card must summarise what's
 * still not ready from already-cached data alone, so these lock down the pure
 * logic behind each signal — members with no dates, nights with no lodging,
 * open tasks, and open polls the viewer hasn't voted in — plus the all-clear
 * case, independent of React or the network.
 *
 * Same module-loading convention as tests/today.test.mjs / recap.test.mjs:
 * Node's type-stripping loader won't append '.ts' to readiness.ts's
 * extensionless value import of '../stays/dates', so a resolve hook supplies it.
 *
 *   node --test tests/readiness.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)
const {
  tripReadiness,
  membersMissingDates,
  nightsWithoutLodging,
  openChecklistCount,
  pendingPolls,
} = await import('../src/features/dashboard/readiness.ts')

// A fixed "now" so poll closes_at boundaries are deterministic.
const NOW = Date.UTC(2026, 2, 1, 12, 0, 0) // 2026-03-01T12:00:00Z

test('membersMissingDates counts members with neither date set', () => {
  assert.equal(membersMissingDates([]), 0)
  assert.equal(
    membersMissingDates([
      { arrives_on: null, departs_on: null }, // hasn't said → counts
      { arrives_on: '2026-03-14', departs_on: null }, // stated arrival → doesn't
      { arrives_on: null, departs_on: '2026-03-18' }, // stated departure → doesn't
      { arrives_on: '2026-03-14', departs_on: '2026-03-18' }, // both → doesn't
    ]),
    1,
  )
})

test('nightsWithoutLodging excludes the departure day and honours the half-open stay window', () => {
  // Fri 14th → Mon 17th: nights are 14, 15, 16 (you leave on the 17th).
  const start = '2026-03-14'
  const end = '2026-03-17'

  // No stays → every night is uncovered.
  assert.equal(nightsWithoutLodging(start, end, []), 3)

  // A stay [14, 16) covers nights 14 and 15, leaving night 16 uncovered.
  assert.equal(
    nightsWithoutLodging(start, end, [{ check_in: '2026-03-14', check_out: '2026-03-16' }]),
    1,
  )

  // A stay spanning the whole trip [14, 17) covers all three nights.
  assert.equal(
    nightsWithoutLodging(start, end, [{ check_in: '2026-03-14', check_out: '2026-03-17' }]),
    0,
  )

  // A dateless stay covers nothing.
  assert.equal(
    nightsWithoutLodging(start, end, [{ check_in: null, check_out: null }]),
    3,
  )
})

test('nightsWithoutLodging is 0 for an undated or single-day trip', () => {
  assert.equal(nightsWithoutLodging(null, '2026-03-17', []), 0)
  assert.equal(nightsWithoutLodging('2026-03-14', null, []), 0)
  // A day trip (start === end) has no nights, so nothing to flag.
  assert.equal(nightsWithoutLodging('2026-03-14', '2026-03-14', []), 0)
})

test('nightsWithoutLodging crosses a DST spring-forward without drift', () => {
  // US DST begins 2026-03-08; a UTC-based night walk must not gain/lose a day.
  // 2026-03-07 → 2026-03-10 is 3 nights (07, 08, 09).
  assert.equal(nightsWithoutLodging('2026-03-07', '2026-03-10', []), 3)
})

test('openChecklistCount counts only unfinished items', () => {
  assert.equal(openChecklistCount([]), 0)
  assert.equal(
    openChecklistCount([{ done: false }, { done: true }, { done: false }]),
    2,
  )
})

test('pendingPolls counts open polls the viewer has not voted in', () => {
  const polls = [
    // open, viewer hasn't voted → pending
    { closed: false, closes_at: null, votes: [{ member_id: 'other' }] },
    // open, viewer already voted → not pending
    { closed: false, closes_at: null, votes: [{ member_id: 'me' }] },
    // explicitly closed → not pending even without the viewer's vote
    { closed: true, closes_at: null, votes: [] },
    // past its close time → not pending
    { closed: false, closes_at: '2026-02-01T00:00:00Z', votes: [] },
    // closes in the future, no vote → pending
    { closed: false, closes_at: '2026-04-01T00:00:00Z', votes: [] },
  ]
  assert.equal(pendingPolls(polls, 'me', NOW), 2)
})

test('tripReadiness returns each fired signal, in order, with its deep-link target', () => {
  const signals = tripReadiness({
    startDate: '2026-03-14',
    endDate: '2026-03-17',
    members: [{ arrives_on: null, departs_on: null }],
    stays: [],
    checklist: [{ done: false }],
    polls: [{ closed: false, closes_at: null, votes: [] }],
    viewerId: 'me',
    now: NOW,
  })
  assert.deepEqual(signals, [
    { key: 'member-dates', count: 1, to: 'me' },
    { key: 'lodging', count: 3, to: 'calendar' },
    { key: 'checklist', count: 1, to: 'checklist' },
    { key: 'polls', count: 1, to: 'polls' },
  ])
})

test('tripReadiness omits cleared signals and returns [] when all set', () => {
  // Everything resolved: dates set, lodging covers every night, no open tasks,
  // the only poll already voted in.
  const signals = tripReadiness({
    startDate: '2026-03-14',
    endDate: '2026-03-17',
    members: [{ arrives_on: '2026-03-14', departs_on: '2026-03-17' }],
    stays: [{ check_in: '2026-03-14', check_out: '2026-03-17' }],
    checklist: [{ done: true }],
    polls: [{ closed: false, closes_at: null, votes: [{ member_id: 'me' }] }],
    viewerId: 'me',
    now: NOW,
  })
  assert.deepEqual(signals, [])
})
