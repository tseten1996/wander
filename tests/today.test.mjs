/**
 * Unit tests for the "during the trip" dashboard helpers
 * (src/features/dashboard/today.ts, issue #281).
 *
 * Pure module, exercised directly with the built-in Node test runner
 * (`node:test` + `node:assert`), matching tests/spans.test.mjs / recap.test.mjs.
 * Node strips the TypeScript types on import, so the module is tested exactly as
 * it ships.
 *
 *   node --test tests/today.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// Same convention as tests/recap.test.mjs: Node's type-stripping loader won't
// append '.ts' to today.ts's extensionless value import of '../itinerary/spans',
// so a resolve hook supplies it.
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
  tripPhase,
  todaysItems,
  nextUpcomingId,
  todaysTimeline,
  nextTimelineId,
  stayTransitionsForDay,
} = await import('../src/features/dashboard/today.ts')

/** Minimal itinerary-item factory — only the fields the helpers read. */
function item(over = {}) {
  return {
    id: 'x',
    day: null,
    end_day: null,
    start_time: null,
    end_time: null,
    position: 0,
    ...over,
  }
}

/** Minimal transport-hop factory — only the fields the helpers read. */
function hop(over = {}) {
  return {
    id: 'h',
    mode: 'train',
    depart_place: null,
    arrive_place: null,
    depart_at: null,
    arrive_at: null,
    ...over,
  }
}

/** Minimal stay factory — only the date window the helpers read. */
function stay(over = {}) {
  return { id: 's', name: 'Stay', check_in: null, check_out: null, ...over }
}

test('tripPhase places today before / during / after the trip', () => {
  assert.equal(tripPhase('2026-08-20', '2026-08-27', '2026-08-19'), 'before')
  assert.equal(tripPhase('2026-08-20', '2026-08-27', '2026-08-23'), 'during')
  assert.equal(tripPhase('2026-08-20', '2026-08-27', '2026-08-28'), 'after')
})

test('tripPhase is inclusive of the first and last day', () => {
  assert.equal(tripPhase('2026-08-20', '2026-08-27', '2026-08-20'), 'during')
  assert.equal(tripPhase('2026-08-20', '2026-08-27', '2026-08-27'), 'during')
})

test('tripPhase is undated when either date is missing', () => {
  assert.equal(tripPhase(null, '2026-08-27', '2026-08-23'), 'undated')
  assert.equal(tripPhase('2026-08-20', null, '2026-08-23'), 'undated')
  assert.equal(tripPhase(null, null, '2026-08-23'), 'undated')
})

test('todaysItems keeps only single-day items scheduled for today', () => {
  const today = '2026-08-23'
  const items = [
    item({ id: 'a', day: today, start_time: '09:00:00', position: 2 }),
    item({ id: 'other-day', day: '2026-08-24', start_time: '10:00:00' }),
    item({ id: 'undated', day: null }),
    // A multi-day span that covers today is excluded — it renders as a band.
    item({ id: 'span', day: '2026-08-22', end_day: '2026-08-25', start_time: '15:00:00' }),
  ]
  assert.deepEqual(
    todaysItems(items, today).map((i) => i.id),
    ['a']
  )
})

test('todaysItems orders timed items ascending, untimed last by position', () => {
  const today = '2026-08-23'
  const items = [
    item({ id: 'noon', day: today, start_time: '12:00:00' }),
    item({ id: 'untimed-2', day: today, start_time: null, position: 5 }),
    item({ id: 'morning', day: today, start_time: '08:30:00' }),
    item({ id: 'untimed-1', day: today, start_time: null, position: 1 }),
  ]
  assert.deepEqual(
    todaysItems(items, today).map((i) => i.id),
    ['morning', 'noon', 'untimed-1', 'untimed-2']
  )
})

test('nextUpcomingId is the first item whose start time has not passed', () => {
  const sorted = [
    item({ id: 'past', start_time: '08:00:00' }),
    item({ id: 'soon', start_time: '14:00:00' }),
    item({ id: 'later', start_time: '18:00:00' }),
  ]
  assert.equal(nextUpcomingId(sorted, '10:30:00'), 'soon')
  // Exactly at a start time counts as still upcoming (>=).
  assert.equal(nextUpcomingId(sorted, '14:00:00'), 'soon')
})

test('nextUpcomingId is null once every timed item has started', () => {
  const sorted = [
    item({ id: 'a', start_time: '08:00:00' }),
    item({ id: 'b', start_time: '09:00:00' }),
  ]
  assert.equal(nextUpcomingId(sorted, '23:00:00'), null)
})

test('nextUpcomingId ignores untimed items', () => {
  const sorted = [item({ id: 'untimed', start_time: null })]
  assert.equal(nextUpcomingId(sorted, '10:00:00'), null)
})

// --- Logistics on the day-of card (#405) ------------------------------------

test('stayTransitionsForDay surfaces only check-in and check-out edge days', () => {
  const stays = [
    stay({ id: 's1', name: 'Hôtel A', check_in: '2026-08-20', check_out: '2026-08-23' }),
    stay({ id: 's2', name: 'Villa B', check_in: '2026-08-23', check_out: '2026-08-27' }),
  ]
  // On the 23rd under the half-open rule: check OUT of A, check IN to B — the
  // morning you leave one place and arrive at the next. Check-outs come first.
  assert.deepEqual(
    stayTransitionsForDay('2026-08-23', stays).map((t) => `${t.kind}:${t.stay.id}`),
    ['check-out:s1', 'check-in:s2']
  )
  // A day that merely falls inside a stay yields no transition.
  assert.deepEqual(stayTransitionsForDay('2026-08-21', stays), [])
  // A dateless stay never transitions.
  assert.deepEqual(
    stayTransitionsForDay('2026-08-23', [stay({ id: 'x', check_in: null, check_out: null })]),
    []
  )
})

test('todaysTimeline merges transport into the day in happen-order', () => {
  const today = '2026-08-23'
  const items = [
    item({ id: 'morning', day: today, start_time: '08:30:00' }),
    item({ id: 'evening', day: today, start_time: '19:00:00' }),
    item({ id: 'untimed', day: today, start_time: null, position: 3 }),
    // A multi-day span covering today is excluded (renders as a band).
    item({ id: 'span', day: '2026-08-22', end_day: '2026-08-25', start_time: '10:00:00' }),
    // Another day's item is excluded.
    item({ id: 'other', day: '2026-08-24', start_time: '09:00:00' }),
  ]
  const hops = [
    // Departs today 14:30, arrives the next day (one entry today).
    hop({ id: 'train', depart_at: `${today}T14:30`, arrive_at: '2026-08-24T07:00' }),
    // Departed yesterday, arrives today 06:00 (one entry today).
    hop({ id: 'ferry', depart_at: '2026-08-22T22:00', arrive_at: `${today}T06:00` }),
  ]
  assert.deepEqual(
    todaysTimeline(items, hops, today).map((e) => e.id),
    ['ferry:arrive', 'morning', 'train:depart', 'evening', 'untimed']
  )
})

test('todaysTimeline sorts a hop ahead of a same-minute itinerary item', () => {
  const today = '2026-08-23'
  const items = [item({ id: 'noon-item', day: today, start_time: '12:00:00', position: 0 })]
  const hops = [hop({ id: 'noon-hop', depart_at: `${today}T12:00` })]
  assert.deepEqual(
    todaysTimeline(items, hops, today).map((e) => e.id),
    ['noon-hop:depart', 'noon-item']
  )
})

test('todaysTimeline tags each entry so the card can render item vs transport', () => {
  const today = '2026-08-23'
  const tl = todaysTimeline(
    [item({ id: 'walk', day: today, start_time: '09:00:00' })],
    [hop({ id: 'bus', mode: 'bus', depart_at: `${today}T10:00`, depart_place: 'A', arrive_place: 'B' })],
    today
  )
  assert.deepEqual(tl.map((e) => e.kind), ['item', 'transport'])
  const transport = tl.find((e) => e.kind === 'transport')
  assert.equal(transport.direction, 'depart')
  assert.equal(transport.time, '10:00')
  assert.equal(transport.hop.mode, 'bus')
})

test('nextTimelineId marks the next entry, item or hop, still ahead of now', () => {
  const today = '2026-08-23'
  const tl = todaysTimeline(
    [item({ id: 'done', day: today, start_time: '08:00:00' })],
    [hop({ id: 'train', depart_at: `${today}T14:30` })],
    today
  )
  // At 10:00 the 08:00 item is past; the 14:30 train is the next thing up.
  assert.equal(nextTimelineId(tl, '10:00:00'), 'train:depart')
  // Once every timed entry has passed, nothing is next.
  assert.equal(nextTimelineId(tl, '23:00:00'), null)
})
