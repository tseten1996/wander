/**
 * Unit tests for the itinerary comment thread's pure core
 * (src/features/itinerary/comments/tally.ts — feature shipped in #314/#323,
 * coverage added in #325; unread-marker helpers added in #342).
 *
 * The thread's branchy logic — the per-entity activity tally that drives every
 * count badge and its unread dot, the unread comparison, and the mention-title
 * snapshot truncation — lives in a dependency-free module so it can be
 * exercised directly with the built-in Node test runner (Node strips the
 * TypeScript types on import), matching tests/mentions.test.mjs. The module has
 * no runtime imports, so no resolver hook is needed.
 *
 *   node --test tests/comments.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MENTION_TITLE_MAX,
  isEntityUnread,
  tallyCommentActivity,
  truncateMentionTitle,
} from '../src/features/itinerary/comments/tally.ts'

const row = (entity_id, created_at, member_id = 'm1') => ({ entity_id, created_at, member_id })

// ── tallyCommentActivity ──────────────────────────────────────────────────

test('tallyCommentActivity sums multiple rows for one entity', () => {
  const activity = tallyCommentActivity([
    row('item-a', '2026-01-01T00:00:00Z'),
    row('item-a', '2026-01-02T00:00:00Z'),
    row('item-a', '2026-01-03T00:00:00Z'),
  ])
  assert.equal(activity.get('item-a').count, 3)
})

test('tallyCommentActivity keeps a separate entry per entity', () => {
  const activity = tallyCommentActivity([
    row('item-a', '2026-01-01T00:00:00Z'),
    row('item-b', '2026-01-01T00:00:00Z'),
    row('item-a', '2026-01-02T00:00:00Z'),
  ])
  assert.equal(activity.get('item-a').count, 2)
  assert.equal(activity.get('item-b').count, 1)
  assert.equal(activity.size, 2)
})

test('tallyCommentActivity tracks the newest comment and its author, regardless of row order', () => {
  const activity = tallyCommentActivity([
    row('item-a', '2026-01-02T00:00:00Z', 'alice'),
    row('item-a', '2026-01-05T00:00:00Z', 'bob'), // newest, out of order
    row('item-a', '2026-01-01T00:00:00Z', 'carol'),
  ])
  const entry = activity.get('item-a')
  assert.equal(entry.newestAt, '2026-01-05T00:00:00Z')
  assert.equal(entry.newestBy, 'bob')
})

test('tallyCommentActivity keeps a null author on the newest comment', () => {
  const activity = tallyCommentActivity([row('item-a', '2026-01-01T00:00:00Z', null)])
  assert.equal(activity.get('item-a').newestBy, null)
})

test('tallyCommentActivity reads an entity with no rows as absent', () => {
  const activity = tallyCommentActivity([row('item-a', '2026-01-01T00:00:00Z')])
  // Absent from the map — the call site's `?? 0` renders a plain 0, no dot.
  assert.equal(activity.has('item-never-commented'), false)
  assert.equal(activity.get('item-never-commented')?.count ?? 0, 0)
})

test('tallyCommentActivity of no rows is an empty map', () => {
  assert.equal(tallyCommentActivity([]).size, 0)
})

// ── isEntityUnread ────────────────────────────────────────────────────────

const BASELINE = '2026-01-01T00:00:00Z'

test('isEntityUnread is false for an entity with no comments', () => {
  assert.equal(isEntityUnread(undefined, undefined, BASELINE, 'me'), false)
})

test('isEntityUnread is true when the newest comment is newer than last-seen', () => {
  const entry = { count: 1, newestAt: '2026-02-02T00:00:00Z', newestBy: 'other' }
  assert.equal(isEntityUnread(entry, '2026-02-01T00:00:00Z', BASELINE, 'me'), true)
})

test('isEntityUnread is false once the newest comment has been seen', () => {
  const entry = { count: 1, newestAt: '2026-02-02T00:00:00Z', newestBy: 'other' }
  assert.equal(isEntityUnread(entry, '2026-02-02T00:00:00Z', BASELINE, 'me'), false)
  assert.equal(isEntityUnread(entry, '2026-02-03T00:00:00Z', BASELINE, 'me'), false)
})

test('isEntityUnread never flags a comment the viewer wrote themselves', () => {
  const entry = { count: 1, newestAt: '2026-02-02T00:00:00Z', newestBy: 'me' }
  // Newer than last-seen, but it is mine → not unread to me.
  assert.equal(isEntityUnread(entry, '2026-01-15T00:00:00Z', BASELINE, 'me'), false)
})

test('isEntityUnread falls back to baseline when the entity has no last-seen', () => {
  const older = { count: 1, newestAt: '2025-12-31T00:00:00Z', newestBy: 'other' }
  const newer = { count: 1, newestAt: '2026-01-02T00:00:00Z', newestBy: 'other' }
  // Pre-baseline discussion is treated as already seen; post-baseline is new.
  assert.equal(isEntityUnread(older, undefined, BASELINE, 'me'), false)
  assert.equal(isEntityUnread(newer, undefined, BASELINE, 'me'), true)
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
