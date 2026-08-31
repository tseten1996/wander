/**
 * Unit tests for the offline mutation-replay allow-list and predicates
 * (src/lib/offlineSync.ts, issue #283).
 *
 * These guard the two properties the feature's safety rests on:
 *   1. ONLY the two toggle keys are ever replayable — every other mutation
 *      stays online-only and is never persisted or counted, so no unrelated
 *      write is silently queued (and none can replay under another account).
 *   2. A mutation is persisted only while paused (never sent) AND allow-listed.
 *
 * Node (>= 22.18) strips the TypeScript types on import; offlineSync.ts has only
 * `import type` (erased) and no runtime imports, so it loads with no deps.
 *
 *   node --test tests/offline-sync.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PACKING_TOGGLE_MUTATION_KEY,
  CHECKLIST_TOGGLE_MUTATION_KEY,
  isReplayableMutationKey,
  shouldPersistMutation,
  deriveSyncQueueState,
} from '../src/lib/offlineSync.ts'

test('the two toggle keys are recognised as replayable', () => {
  assert.equal(isReplayableMutationKey(PACKING_TOGGLE_MUTATION_KEY), true)
  assert.equal(isReplayableMutationKey(CHECKLIST_TOGGLE_MUTATION_KEY), true)
  // A fresh array with the same contents matches by value, not identity —
  // a rehydrated mutation's key is a new array parsed from JSON.
  assert.equal(isReplayableMutationKey(['packing_items', 'toggle']), true)
  assert.equal(isReplayableMutationKey(['checklist_items', 'toggle']), true)
})

test('every other mutation key is rejected', () => {
  assert.equal(isReplayableMutationKey(undefined), false)
  assert.equal(isReplayableMutationKey([]), false)
  // Adjacent-but-different keys must not leak in.
  assert.equal(isReplayableMutationKey(['packing_items']), false)
  assert.equal(isReplayableMutationKey(['packing_items', 'toggle', 'extra']), false)
  assert.equal(isReplayableMutationKey(['checklist_items', 'delete']), false)
  assert.equal(isReplayableMutationKey(['expenses', 'toggle']), false)
})

test('a mutation is persisted only when paused AND allow-listed', () => {
  const paused = (mutationKey) => ({ state: { isPaused: true }, options: { mutationKey } })
  const running = (mutationKey) => ({ state: { isPaused: false }, options: { mutationKey } })

  // Paused + allow-listed → queued to disk.
  assert.equal(shouldPersistMutation(paused(PACKING_TOGGLE_MUTATION_KEY)), true)
  assert.equal(shouldPersistMutation(paused(CHECKLIST_TOGGLE_MUTATION_KEY)), true)

  // Allow-listed but already in flight (not paused) → not persisted; it is
  // reaching Supabase now, replaying it later would double-apply.
  assert.equal(shouldPersistMutation(running(PACKING_TOGGLE_MUTATION_KEY)), false)

  // Paused but NOT allow-listed → never persisted, even though it stalled.
  assert.equal(shouldPersistMutation(paused(['expenses', 'add'])), false)
  assert.equal(shouldPersistMutation(paused(undefined)), false)
})

test('a normal online (non-paused) toggle is not counted as queued', () => {
  // The bounce that produced this test: an ordinary online tap sits at
  // status:'pending' but isPaused:false for its round-trip. It must leave the
  // banner hidden — no queued count, no "syncing" pill — with no prior drain.
  const s = deriveSyncQueueState([false], true, false)
  assert.equal(s.queued, 0)
  assert.equal(s.syncing, false)
  assert.equal(s.draining, false)

  // Even two concurrent online taps stay uncounted.
  const two = deriveSyncQueueState([false, false], true, false)
  assert.equal(two.queued, 0)
  assert.equal(two.syncing, false)
})

test('offline queue depth is the paused count, and the banner is not "syncing"', () => {
  // Offline, three toggles paused → "3 waiting to sync", not a flush.
  const s = deriveSyncQueueState([true, true, true], false, false)
  assert.equal(s.queued, 3)
  assert.equal(s.syncing, false)
  assert.equal(s.draining, true) // armed for the eventual reconnect flush
})

test('reconnect flush: "syncing" tracks the queue draining, then clears', () => {
  // Armed offline (wasDraining=true); back online, the two writes resume and are
  // now in flight (not paused) → show "syncing 2…".
  const flushing = deriveSyncQueueState([false, false], true, true)
  assert.equal(flushing.syncing, true)
  assert.equal(flushing.queued, 2)
  assert.equal(flushing.draining, true)

  // One lands, one still flushing → count follows the queue down.
  const half = deriveSyncQueueState([false], true, true)
  assert.equal(half.syncing, true)
  assert.equal(half.queued, 1)

  // Queue drained → latch clears, banner hides. A later online tap can't re-arm
  // it (nothing paused), so it stays hidden.
  const drained = deriveSyncQueueState([], true, true)
  assert.equal(drained.syncing, false)
  assert.equal(drained.queued, 0)
  assert.equal(drained.draining, false)

  const laterTap = deriveSyncQueueState([false], true, drained.draining)
  assert.equal(laterTap.syncing, false)
  assert.equal(laterTap.queued, 0)
})

test('deriveSyncQueueState is idempotent when fed its own drain flag', () => {
  // The hook writes the derived `draining` back into a ref during render, so
  // re-deriving with that same value (StrictMode double-invoke) must be stable.
  for (const flags of [[], [false], [true], [true, false], [false, false]]) {
    for (const online of [true, false]) {
      const once = deriveSyncQueueState(flags, online, false)
      const twice = deriveSyncQueueState(flags, online, once.draining)
      assert.equal(twice.draining, once.draining)
      assert.equal(twice.queued, once.queued)
      assert.equal(twice.syncing, once.syncing)
    }
  }
})
