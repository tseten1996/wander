/**
 * Unit tests for the pre-trip **readiness** derivations in
 * src/features/dashboard/readiness.ts (#414). The card must answer "what still
 * isn't ready before we go?" from already-cached data alone, so these lock down
 * the pure count behind each signal — members with no dates, nights without
 * lodging, open/unassigned tasks, and open polls the viewer hasn't voted in —
 * independent of React or the network, plus the all-clear case.
 *
 * Same module-loading convention as tests/recap.test.mjs: Node's type-stripping
 * loader won't append '.ts' to readiness.ts's extensionless value import of
 * '../stays/dates', so a resolve hook supplies it.
 *
 *   node --test tests/readiness.test.mjs
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
const { tripReadiness } = await import('../src/features/dashboard/readiness.ts')

// A fixed "now" so the open-poll comparison is deterministic regardless of when
// the suite runs.
const NOW = new Date('2026-04-01T12:00:00Z')

/** A trip with no outstanding readiness signals — the all-clear baseline each
 *  test perturbs one axis of. One member who set both dates, both nights
 *  covered by a stay, no open tasks, and the one open poll already voted on. */
function clearInput(overrides = {}) {
  return {
    startDate: '2026-05-01',
    endDate: '2026-05-03', // nights: 05-01, 05-02
    members: [{ id: 'me', arrives_on: '2026-05-01', departs_on: '2026-05-03' }],
    stays: [{ id: 's1', check_in: '2026-05-01', check_out: '2026-05-03' }],
    checklist: [{ id: 't1', done: true, assignee_id: 'me' }],
    polls: [{ closed: false, closes_at: null, votes: [{ member_id: 'me' }] }],
    myMemberId: 'me',
    now: NOW,
    ...overrides,
  }
}

const kinds = (signals) => signals.map((s) => s.kind)
const byKind = (signals, kind) => signals.find((s) => s.kind === kind)

test('an all-ready trip yields no signals (positive empty state)', () => {
  assert.deepEqual(tripReadiness(clearInput()), [])
})

test('counts members who shared neither arrival nor departure', () => {
  const signals = tripReadiness(
    clearInput({
      members: [
        { id: 'a', arrives_on: null, departs_on: null }, // said nothing → counts
        { id: 'b', arrives_on: '2026-05-01', departs_on: null }, // set one → engaged
        { id: 'c', arrives_on: null, departs_on: '2026-05-03' }, // set one → engaged
        { id: 'd', arrives_on: null, departs_on: null }, // said nothing → counts
      ],
    }),
  )
  const sig = byKind(signals, 'member-dates')
  assert.equal(sig.count, 2)
  assert.equal(sig.unassigned, 0)
})

test('counts trip nights with no covering stay, half-open [start, end)', () => {
  // A 4-day trip (05-01..05-04) has 3 nights: 01, 02, 03. A stay covering
  // [05-01, 05-03) leaves the night of the 3rd uncovered; the checkout morning
  // (the 4th, departure day) is not a night and never counts.
  const signals = tripReadiness(
    clearInput({
      startDate: '2026-05-01',
      endDate: '2026-05-04',
      stays: [{ id: 's1', check_in: '2026-05-01', check_out: '2026-05-03' }],
    }),
  )
  assert.equal(byKind(signals, 'lodging').count, 1)
})

test('a fully-covered trip surfaces no lodging signal', () => {
  const signals = tripReadiness(
    clearInput({ stays: [{ id: 's1', check_in: '2026-05-01', check_out: '2026-05-03' }] }),
  )
  assert.equal(byKind(signals, 'lodging'), undefined)
})

test('a single-day trip has no nights, so no lodging signal even with no stays', () => {
  const signals = tripReadiness(
    clearInput({ startDate: '2026-05-01', endDate: '2026-05-01', stays: [] }),
  )
  assert.equal(byKind(signals, 'lodging'), undefined)
})

test('an undated trip skips the lodging signal entirely', () => {
  const signals = tripReadiness(clearInput({ startDate: null, endDate: null, stays: [] }))
  assert.equal(byKind(signals, 'lodging'), undefined)
})

test('open tasks count, and unassigned among them is reported separately', () => {
  const signals = tripReadiness(
    clearInput({
      checklist: [
        { id: 't1', done: false, assignee_id: null }, // open, no owner
        { id: 't2', done: false, assignee_id: 'me' }, // open, owned
        { id: 't3', done: false, assignee_id: null }, // open, no owner
        { id: 't4', done: true, assignee_id: null }, // done → ignored
      ],
    }),
  )
  const sig = byKind(signals, 'checklist')
  assert.equal(sig.count, 3)
  assert.equal(sig.unassigned, 2)
})

test('all tasks done surfaces no checklist signal', () => {
  const signals = tripReadiness(
    clearInput({ checklist: [{ id: 't1', done: true, assignee_id: 'me' }] }),
  )
  assert.equal(byKind(signals, 'checklist'), undefined)
})

test('counts open polls the viewer has not voted in', () => {
  const signals = tripReadiness(
    clearInput({
      polls: [
        { closed: false, closes_at: null, votes: [] }, // open, I haven't voted → counts
        { closed: false, closes_at: null, votes: [{ member_id: 'me' }] }, // I voted → no
        { closed: true, closes_at: null, votes: [] }, // closed → no
        { closed: false, closes_at: null, votes: [{ member_id: 'other' }] }, // open, someone else → counts
      ],
    }),
  )
  assert.equal(byKind(signals, 'polls').count, 2)
})

test('a poll past its closes_at is not awaiting a vote', () => {
  const signals = tripReadiness(
    clearInput({
      // closes_at before NOW → effectively closed, so an un-voted one does not count.
      polls: [{ closed: false, closes_at: '2026-03-01T00:00:00Z', votes: [] }],
    }),
  )
  assert.equal(byKind(signals, 'polls'), undefined)
})

test('a poll closing in the future still awaits the viewer’s vote', () => {
  const signals = tripReadiness(
    clearInput({
      polls: [{ closed: false, closes_at: '2026-12-31T00:00:00Z', votes: [] }],
    }),
  )
  assert.equal(byKind(signals, 'polls').count, 1)
})

test('signals come in a stable display order: people, lodging, tasks, polls', () => {
  const signals = tripReadiness(
    clearInput({
      members: [{ id: 'a', arrives_on: null, departs_on: null }],
      stays: [],
      checklist: [{ id: 't1', done: false, assignee_id: null }],
      polls: [{ closed: false, closes_at: null, votes: [] }],
      myMemberId: 'a',
    }),
  )
  assert.deepEqual(kinds(signals), ['member-dates', 'lodging', 'checklist', 'polls'])
})
