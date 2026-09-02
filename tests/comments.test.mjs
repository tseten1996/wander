/**
 * Unit tests for the itinerary comment thread's pure helpers
 * (src/features/itinerary/comments/tally.ts, #325) — the two branchy pieces of
 * the feature shipped in #314/#323 that had no client coverage:
 *
 *   • tallyCommentCounts   — the per-entity reducer that drives every itinerary
 *                            count badge (extracted from `fetchCommentCounts`).
 *   • truncateMentionTitle — the mention notification's title snapshot cap
 *                            (MENTION_TITLE_MAX = 140), extracted from the
 *                            `useAddComment` mutation.
 *
 * The mention parsing the compose box reuses (`extractMentionIds` /
 * `mentionsToPlainText`) is already covered by tests/mentions.test.mjs, so this
 * file targets only the comment-specific composition.
 *
 * Run directly with the built-in Node test runner (Node strips the TypeScript
 * types on import), matching tests/gallery.test.mjs. tally.ts's only import is
 * `import type { Comment } from '@/types'`, which is erased before resolution;
 * the resolve hook below maps any residual `@/…` value-import onto `src/…`.
 *
 *   node --test tests/comments.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { pathToFileURL } from 'node:url'
const srcBase = pathToFileURL(process.cwd() + '/src/').href
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    let target = srcBase + specifier.slice(2)
    if (!/\\.[cm]?[jt]sx?$/i.test(target)) target += '.ts'
    return nextResolve(target, context)
  }
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)

const { tallyCommentCounts, truncateMentionTitle, MENTION_TITLE_MAX } = await import(
  '../src/features/itinerary/comments/tally.ts'
)

// ── tallyCommentCounts ──────────────────────────────────────────────────────

test('tallyCommentCounts sums multiple rows per entity', () => {
  const counts = tallyCommentCounts([
    { entity_id: 'a' },
    { entity_id: 'b' },
    { entity_id: 'a' },
    { entity_id: 'a' },
  ])
  assert.equal(counts.get('a'), 3)
  assert.equal(counts.get('b'), 1)
})

test('tallyCommentCounts reads 0 for an entity with no rows', () => {
  const counts = tallyCommentCounts([{ entity_id: 'a' }])
  // An entity with no comments is absent from the Map, so the badge reads a
  // plain 0 via `?? 0` — the contract fetchCommentCounts' callers rely on.
  assert.equal(counts.has('missing'), false)
  assert.equal(counts.get('missing') ?? 0, 0)
})

test('tallyCommentCounts on no rows yields an empty Map', () => {
  const counts = tallyCommentCounts([])
  assert.equal(counts.size, 0)
})

// ── truncateMentionTitle ────────────────────────────────────────────────────

test('MENTION_TITLE_MAX is 140', () => {
  assert.equal(MENTION_TITLE_MAX, 140)
})

test('truncateMentionTitle passes a body at or under the cap through unchanged', () => {
  const atCap = 'x'.repeat(MENTION_TITLE_MAX) // exactly 140
  assert.equal(truncateMentionTitle(atCap), atCap)

  const underCap = 'hey @Jane, dinner Friday?'
  assert.equal(truncateMentionTitle(underCap), underCap)
})

test('truncateMentionTitle clips a body over the cap and appends an ellipsis', () => {
  const overCap = 'y'.repeat(MENTION_TITLE_MAX + 50) // 190 chars
  const out = truncateMentionTitle(overCap)
  // 139 kept chars + the single-char ellipsis = the cap, never longer.
  assert.equal(out.length, MENTION_TITLE_MAX)
  assert.ok(out.endsWith('…'))
  assert.equal(out, 'y'.repeat(MENTION_TITLE_MAX - 1) + '…')
})

test('truncateMentionTitle treats exactly one over the cap as overflow', () => {
  const oneOver = 'z'.repeat(MENTION_TITLE_MAX + 1) // 141 chars
  const out = truncateMentionTitle(oneOver)
  assert.equal(out.length, MENTION_TITLE_MAX)
  assert.ok(out.endsWith('…'))
})
