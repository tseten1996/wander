/**
 * Poll open/close + reopen logic (#411).
 *
 * Node (>= 22.18) strips the TypeScript types from `status.ts` on import, so the
 * module is exercised exactly as it ships. The file is deliberately
 * dependency-free (only an elided `import type`) so it loads here without the
 * Supabase / react-query stack that `polls/api.ts` pulls in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPollOpen, reopenPatch } from '../src/features/polls/status.ts'

const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

test('isPollOpen: a plain poll with no close time is open', () => {
  assert.equal(isPollOpen({ closed: false, closes_at: null }), true)
})

test('isPollOpen: a manually-closed poll is closed', () => {
  assert.equal(isPollOpen({ closed: true, closes_at: null }), false)
})

test('isPollOpen: a future close time is still open', () => {
  assert.equal(isPollOpen({ closed: false, closes_at: FUTURE }), true)
})

test('isPollOpen: a past close time has auto-expired', () => {
  assert.equal(isPollOpen({ closed: false, closes_at: PAST }), false)
})

test('reopenPatch: an expired poll also clears the past close time', () => {
  // The bug (#411): without clearing closes_at the poll stays dead and the
  // Reopen button is a silent no-op. The patch must null it out.
  const patch = reopenPatch({ closes_at: PAST })
  assert.deepEqual(patch, { closed: false, closes_at: null })
  // And the result is genuinely open again — votes accepted.
  assert.equal(isPollOpen({ closed: patch.closed, closes_at: patch.closes_at }), true)
})

test('reopenPatch: a manually-closed poll with a future close time keeps it', () => {
  // Reopening here just lifts the manual close; the scheduled expiry stands,
  // so closes_at is deliberately left untouched.
  const patch = reopenPatch({ closes_at: FUTURE })
  assert.deepEqual(patch, { closed: false })
  assert.equal('closes_at' in patch, false)
  assert.equal(isPollOpen({ closed: patch.closed, closes_at: FUTURE }), true)
})

test('reopenPatch: a poll with no close time just reopens', () => {
  assert.deepEqual(reopenPatch({ closes_at: null }), { closed: false })
})

test('reopenPatch: the past/future boundary is taken against the injected now', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')
  assert.deepEqual(
    reopenPatch({ closes_at: '2026-06-15T11:59:00.000Z' }, now),
    { closed: false, closes_at: null },
  )
  assert.deepEqual(
    reopenPatch({ closes_at: '2026-06-15T12:01:00.000Z' }, now),
    { closed: false },
  )
})
