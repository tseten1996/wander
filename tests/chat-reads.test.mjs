/**
 * Unit tests for the chat read-marker gate
 * (src/features/messages/reads.ts, issue #396 — epic #181).
 *
 * Pure module, exercised directly with the built-in Node test runner
 * (`node:test` + `node:assert`), matching tests/mentions.test.mjs. Node strips
 * the TypeScript types on import, so the module is tested exactly as it ships.
 *
 *   node --test tests/chat-reads.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceSeenId } from '../src/features/messages/reads.ts'

test('advanceSeenId tracks the newest message while at the live edge', () => {
  // At the bottom the reader is caught up: the marker follows the newest id.
  assert.equal(advanceSeenId('m1', 'm2', true), 'm2')
  assert.equal(advanceSeenId(undefined, 'm1', true), 'm1')
})

test('advanceSeenId holds while the reader is scrolled up', () => {
  // Scrolled up (the "N new messages" pill showing), an arrival must NOT move
  // the marker past what the reader has actually seen — it keeps its last value.
  assert.equal(advanceSeenId('m1', 'm5', false), 'm1')
  // Even from nothing-seen-yet, a scrolled-up arrival advances nothing.
  assert.equal(advanceSeenId(undefined, 'm5', false), undefined)
})

test('advanceSeenId catches up again when the reader returns to the bottom', () => {
  // Scrolled up through three arrivals, the marker held at m2...
  let seen = 'm2'
  seen = advanceSeenId(seen, 'm3', false)
  seen = advanceSeenId(seen, 'm4', false)
  seen = advanceSeenId(seen, 'm5', false)
  assert.equal(seen, 'm2')
  // ...then scrolling back to the live edge catches it up to the newest.
  seen = advanceSeenId(seen, 'm5', true)
  assert.equal(seen, 'm5')
})

test('advanceSeenId at the live edge of an empty chat stays undefined', () => {
  assert.equal(advanceSeenId(undefined, undefined, true), undefined)
})
