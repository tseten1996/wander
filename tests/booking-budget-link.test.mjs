/**
 * Unit tests for the booking → budget draft builder (#370, epic #346).
 * `src/features/budget/bookingLink.ts` seeds a budget entry from a stay or
 * transport hop's cost, mirroring `itineraryLink.ts`'s draft (#151).
 *
 * Pure module: it imports only an erased `type` plus `toCents` (a pure numeric
 * helper), so the built-in Node test runner exercises it directly.
 *
 *   node --test tests/booking-budget-link.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetDraftFromBooking } from '../src/features/budget/bookingLink.ts'

test('carries the title and category through', () => {
  const draft = budgetDraftFromBooking('Hotel Sunrise', 'stay', 600)
  assert.equal(draft.title, 'Hotel Sunrise')
  assert.equal(draft.category, 'stay')
})

test('seeds the amount into estimated, rounded, leaving actual/paid_by unset', () => {
  const draft = budgetDraftFromBooking('Berlin Airbnb', 'stay', 599.999)
  assert.equal(draft.estimated, 600) // toCents rounds to 2dp
  assert.equal(draft.actual, null)
  // A freshly linked cost is settle-up-neutral: no payer means no debt.
  assert.equal(draft.paid_by, null)
})

test('a null or non-positive amount leaves estimated null (a bare draft)', () => {
  assert.equal(budgetDraftFromBooking('Train', 'transport', null).estimated, null)
})

test('is trip-currency only — no FX freezing machinery', () => {
  const draft = budgetDraftFromBooking('Ferry', 'transport', 42)
  assert.equal(draft.currency, null)
  assert.equal(draft.estimated_converted, null)
  assert.equal(draft.actual_converted, null)
  assert.equal(draft.exchange_rate, null)
})

test('splits evenly by default — no change to who-owes-whom math', () => {
  const draft = budgetDraftFromBooking('Hotel', 'stay', 100)
  assert.equal(draft.participants, null) // null = shared by everyone
  assert.equal(draft.shares, null) // null = equal split
})
