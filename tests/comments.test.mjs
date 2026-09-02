/**
 * Unit tests for the itinerary comment thread's pure core
 * (src/features/itinerary/comments/tally.ts — feature shipped in #314/#323,
 * coverage added in #325).
 *
 * The thread's branchy logic — the per-entity count tally that drives every
 * itinerary count badge, and the mention-title snapshot truncation — lives in a
 * dependency-free module so it can be exercised directly with the built-in Node
 * test runner (Node strips the TypeScript types on import), matching
 * tests/mentions.test.mjs. The module has no runtime imports, so no resolver
 * hook is needed.
 *
 *   node --test tests/comments.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MENTION_TITLE_MAX,
  tallyCommentCounts,
  truncateMentionTitle,
} from '../src/features/itinerary/comments/tally.ts'

// ── tallyCommentCounts ────────────────────────────────────────────────────

test('tallyCommentCounts sums multiple rows for one entity', () => {
  const counts = tallyCommentCounts([
    { entity_id: 'item-a' },
    { entity_id: 'item-a' },
    { entity_id: 'item-a' },
  ])
  assert.equal(counts.get('item-a'), 3)
})

test('tallyCommentCounts keeps a separate count per entity', () => {
  const counts = tallyCommentCounts([
    { entity_id: 'item-a' },
    { entity_id: 'item-b' },
    { entity_id: 'item-a' },
  ])
  assert.equal(counts.get('item-a'), 2)
  assert.equal(counts.get('item-b'), 1)
  assert.equal(counts.size, 2)
})

test('tallyCommentCounts reads an entity with no rows as 0', () => {
  const counts = tallyCommentCounts([{ entity_id: 'item-a' }])
  // Absent from the map — the call site's `?? 0` renders a plain 0.
  assert.equal(counts.has('item-never-commented'), false)
  assert.equal(counts.get('item-never-commented') ?? 0, 0)
})

test('tallyCommentCounts of no rows is an empty map', () => {
  const counts = tallyCommentCounts([])
  assert.equal(counts.size, 0)
})

// ── truncateMentionTitle ──────────────────────────────────────────────────

test('MENTION_TITLE_MAX is the documented 140-char cap', () => {
  assert.equal(MENTION_TITLE_MAX, 140)
})

test('truncateMentionTitle clips a body over the cap with a trailing ellipsis', () => {
  const body = 'a'.repeat(200)
  const title = truncateMentionTitle(body)
  // 139 kept chars + the ellipsis = 140 displayed characters.
  assert.equal(title.length, MENTION_TITLE_MAX)
  assert.ok(title.endsWith('…'))
  assert.equal(title.slice(0, -1), 'a'.repeat(MENTION_TITLE_MAX - 1))
})

test('truncateMentionTitle passes a body at exactly the cap through unchanged', () => {
  const body = 'b'.repeat(MENTION_TITLE_MAX)
  const title = truncateMentionTitle(body)
  assert.equal(title, body)
  assert.ok(!title.endsWith('…'))
})

test('truncateMentionTitle passes a body under the cap through unchanged', () => {
  const body = 'hey @Jane, is 9am too early for the museum?'
  assert.equal(truncateMentionTitle(body), body)
})

test('truncateMentionTitle honours a custom max', () => {
  assert.equal(truncateMentionTitle('abcdef', 3), 'ab…')
  assert.equal(truncateMentionTitle('abc', 3), 'abc')
})
