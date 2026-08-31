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
