/**
 * Unit tests for the realtime reconnect re-sync state machine
 * (src/lib/realtimeResync.ts, issue #332).
 *
 * These pin the two properties the fix rests on:
 *   1. A catch-up re-sync fires ONLY when the channel reconnects after a real
 *      drop (or a visibility/online regain while a drop is pending) — so a
 *      backgrounded tab picks up everything CDC didn't replay on resume.
 *   2. A healthy, never-dropped socket NEVER re-syncs — the initial connect and
 *      redundant SUBSCRIBED/visibility churn are no-ops, so the refetch-on-focus
 *      storms ARCHITECTURE §6 warns against are not reintroduced.
 *
 * Node strips the TypeScript types on import; realtimeResync.ts has no runtime
 * imports, so it loads with no deps.
 *
 *   node --test tests/realtime-resync.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialResyncState,
  reduceStatus,
  reduceRegain,
} from '../src/lib/realtimeResync.ts'

// Convenience: fold a status into a state and return the ResyncResult.
const sub = (state) => reduceStatus(state, true)
const drop = (state) => reduceStatus(state, false)

test('the first SUBSCRIBED connects but never re-syncs', () => {
  const r = sub(initialResyncState)
  assert.equal(r.resync, false, 'a fresh mount already fetched — no catch-up')
  assert.deepEqual(r.state, { everSubscribed: true, droppedSinceConnect: false })
})

test('a reconnect after a drop re-syncs exactly once', () => {
  let { state } = sub(initialResyncState) // connected
  const dropped = drop(state)
  assert.equal(dropped.resync, false, 'the drop itself does not refetch')
  assert.equal(dropped.state.droppedSinceConnect, true, 'the drop is armed')

  const reconnected = sub(dropped.state)
  assert.equal(reconnected.resync, true, 'reconnect after a drop catches up')
  assert.equal(reconnected.state.droppedSinceConnect, false, 'and disarms')

  // A redundant SUBSCRIBED with no drop in between must not fire again.
  assert.equal(sub(reconnected.state).resync, false)
})

test('a healthy socket never re-syncs on redundant SUBSCRIBED', () => {
  let { state } = sub(initialResyncState)
  // Several SUBSCRIBED callbacks with no drop between them (e.g. a benign
  // re-join) must each be a no-op.
  for (let i = 0; i < 3; i++) {
    const r = sub(state)
    assert.equal(r.resync, false)
    state = r.state
  }
})

test('status churn before the first connect is ignored', () => {
  // A channel that errors/closes before it ever subscribes missed nothing.
  let r = drop(initialResyncState)
  assert.equal(r.resync, false)
  assert.equal(r.state.droppedSinceConnect, false, 'never armed before connecting')
  r = drop(r.state)
  assert.equal(r.resync, false)
  // The eventual first SUBSCRIBED is still just a connect, not a catch-up.
  assert.equal(sub(r.state).resync, false)
})

test('multiple drops collapse — the armed flag stays set, no early resync', () => {
  let { state } = sub(initialResyncState)
  const d1 = drop(state)
  assert.equal(d1.resync, false)
  const d2 = drop(d1.state) // TIMED_OUT → CLOSED → CHANNEL_ERROR in a row
  assert.equal(d2.resync, false)
  assert.equal(d2.state.droppedSinceConnect, true)
  // Only the reconnect that follows the whole run catches up, once.
  assert.equal(sub(d2.state).resync, true)
})

test('visibility/online regain accelerates catch-up only while a drop is pending', () => {
  // Healthy socket: a regain event is a no-op (this is the anti-storm guard).
  let { state } = sub(initialResyncState)
  assert.equal(reduceRegain(state).resync, false)

  // Drop, then regain visibility before the socket has rejoined → catch up now
  // (the REST refetch does not need the socket), and disarm.
  const dropped = drop(state)
  const regained = reduceRegain(dropped.state)
  assert.equal(regained.resync, true)
  assert.equal(regained.state.droppedSinceConnect, false)

  // The reconnect SUBSCRIBED that lands afterwards must NOT double-fire.
  assert.equal(sub(regained.state).resync, false)
})

test('a regain before ever connecting is a no-op', () => {
  assert.equal(reduceRegain(initialResyncState).resync, false)
})
