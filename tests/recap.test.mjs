/**
 * Unit tests for the post-trip **Trip recap** derivations in
 * src/features/dashboard/recap.ts (#206, epic #205 slice 1). The card must
 * summarise a finished trip from already-cached data alone, so these lock down
 * the pure math behind each figure — trip length, stop count, total spend, and
 * the settle-up one-liner — independent of React or the network.
 *
 * Same module-loading convention as tests/settlement.test.mjs: Node's
 * type-stripping loader won't append '.ts' to recap.ts's extensionless value
 * imports of '../budget/amounts' and '../budget/settlement' (nor settlement's
 * own './amounts'), so a resolve hook supplies it.
 *
 *   node --test tests/recap.test.mjs   # or: npm run test:unit
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
const { tripDayCount, stopCount, totalSpend, recapSettlement } = await import(
  '../src/features/dashboard/recap.ts'
)

test('tripDayCount is an inclusive whole-day length', () => {
  assert.equal(tripDayCount('2026-03-14', '2026-03-16'), 3) // Sat–Mon = 3 days
  assert.equal(tripDayCount('2026-03-14', '2026-03-14'), 1) // a day trip is 1
  assert.equal(tripDayCount('2026-03-01', '2026-03-31'), 31) // whole month
})

test('tripDayCount crosses a DST spring-forward without drift', () => {
  // US DST begins 2026-03-08; a UTC-based count must ignore the lost hour.
  assert.equal(tripDayCount('2026-03-07', '2026-03-09'), 3)
})

test('tripDayCount is null when a date is missing or the range is inverted', () => {
  assert.equal(tripDayCount(null, '2026-03-16'), null)
  assert.equal(tripDayCount('2026-03-14', null), null)
  assert.equal(tripDayCount(null, null), null)
  assert.equal(tripDayCount('2026-03-16', '2026-03-14'), null)
})

test('stopCount counts each itinerary row once, spans included', () => {
  assert.equal(stopCount([]), 0)
  // A multi-day stay (end_day set) is a single stop, not one-per-night.
  assert.equal(
    stopCount([
      { day: '2026-03-14', end_day: null },
      { day: '2026-03-15', end_day: '2026-03-18' }, // 4-night stay → still 1 stop
      { day: null, end_day: null }, // an unscheduled idea still counts as a stop
    ]),
    3,
  )
})

test('totalSpend rolls up actual spend in trip currency (converted ?? raw)', () => {
  const spend = totalSpend([
    { actual: 100, actual_converted: null }, // trip-currency entry → 100
    { actual: 50, actual_converted: 40 }, // foreign entry → converted 40 wins
    { actual: null, actual_converted: null }, // estimate-only → contributes 0
  ])
  assert.equal(spend, 140)
})

test('recapSettlement reports "nothing to settle" when no real expenses exist', () => {
  const s = recapSettlement(
    [{ actual: null, actual_converted: null, paid_by: null, participants: null }],
    [{ id: 'a' }, { id: 'b' }],
    [],
  )
  assert.deepEqual(s, { hasData: false, settled: true, transfersLeft: 0 })
})

test('recapSettlement counts outstanding transfers, and nets repayments to settled', () => {
  const members = [{ id: 'a' }, { id: 'b' }]
  const entries = [
    { actual: 100, actual_converted: null, paid_by: 'a', participants: null }, // shared by all
  ]

  const owed = recapSettlement(entries, members, [])
  assert.equal(owed.hasData, true)
  assert.equal(owed.settled, false)
  assert.equal(owed.transfersLeft, 1) // B owes A 50

  const repaid = recapSettlement(entries, members, [
    { from_member: 'b', to_member: 'a', amount: 50, amount_converted: null },
  ])
  assert.deepEqual(repaid, { hasData: true, settled: true, transfersLeft: 0 })
})
