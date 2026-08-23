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
const { tripPhase, todaysItems, nextUpcomingId } = await import(
  '../src/features/dashboard/today.ts'
)

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
