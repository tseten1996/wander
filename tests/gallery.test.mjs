/**
 * Unit tests for the trip-photos gallery aggregation
 * (src/features/photos/gallery.ts, #294) — the pure merge of chat images,
 * inspiration-board images, and direct uploads into one date-grouped, newest-first
 * list.
 *
 * Run directly with the built-in Node test runner (Node strips the TypeScript
 * types on import), matching tests/today.test.mjs. buildGallery's only runtime
 * import is `searchAnchorId` from the `@/` alias, so the resolve hook below maps
 * `@/…` onto `src/…`; every other import in the module is `import type` and is
 * erased before resolution.
 *
 *   node --test tests/gallery.test.mjs      # or: npm run test:unit
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

const { buildGallery } = await import('../src/features/photos/gallery.ts')

// 48h apart, so the two rows land on different calendar days in every timezone.
const DAY_A = '2026-08-20T12:00:00Z'
const DAY_B = '2026-08-22T12:00:00Z'

test('aggregates chat images, inspiration images and uploads; skips non-images', () => {
  const days = buildGallery(
    [
      { id: 'm1', member_id: 'alice', created_at: DAY_A, image_path: 'trip/x.png', image_url: 'signed://x' },
      { id: 'm2', member_id: 'bob', created_at: DAY_A, image_path: null, image_url: undefined }, // text-only → skipped
    ],
    [
      { id: 'i1', created_by: 'carol', created_at: DAY_B, image_url: 'https://img/i1.jpg' },
      { id: 'i2', created_by: 'carol', created_at: DAY_B, image_url: null }, // no image → skipped
    ],
    [{ id: 'p1', member_id: 'dave', created_at: DAY_B, image_path: 'trip/p1.webp', image_url: 'signed://p1' }]
  )

  const flat = days.flatMap((d) => d.photos)
  assert.equal(flat.length, 3) // 1 chat + 1 inspiration + 1 upload
  assert.deepEqual(
    flat.map((p) => p.source).sort(),
    ['chat', 'inspiration', 'upload']
  )
})

test('newest first across sources, grouped by calendar day', () => {
  const days = buildGallery(
    [{ id: 'm1', member_id: 'alice', created_at: DAY_A, image_path: 'trip/x.png', image_url: 'signed://x' }],
    [{ id: 'i1', created_by: 'carol', created_at: DAY_B, image_url: 'https://img/i1.jpg' }],
    []
  )

  assert.equal(days.length, 2)
  // The later day (DAY_B / inspiration) comes first.
  assert.equal(days[0].photos[0].source, 'inspiration')
  assert.equal(days[1].photos[0].source, 'chat')

  const flat = days.flatMap((d) => d.photos)
  for (let i = 1; i < flat.length; i++) {
    assert.ok(flat[i - 1].createdAt >= flat[i].createdAt, 'flat order is non-increasing')
  }
})

test('maps back-links: chat → chat anchor, inspiration → ideas anchor, upload → none', () => {
  const days = buildGallery(
    [{ id: 'm1', member_id: 'alice', created_at: DAY_A, image_path: 'trip/x.png', image_url: 'signed://x' }],
    [{ id: 'i1', created_by: 'carol', created_at: DAY_A, image_url: 'https://img/i1.jpg' }],
    [{ id: 'p1', member_id: 'dave', created_at: DAY_A, image_path: 'trip/p1.webp', image_url: 'signed://p1' }]
  )
  const by = Object.fromEntries(days.flatMap((d) => d.photos).map((p) => [p.source, p]))

  assert.equal(by.chat.source_anchor, 'chat#wander-item-m1')
  assert.equal(by.inspiration.source_anchor, 'ideas#wander-item-i1')
  assert.equal(by.upload.source_anchor, null)
  // Only uploads carry the pointer id + path the gallery deletes by.
  assert.equal(by.upload.photoId, 'p1')
  assert.equal(by.upload.imagePath, 'trip/p1.webp')
  assert.equal(by.chat.photoId, undefined)
})

test('an unresolved (unsigned) image becomes url:null rather than being dropped', () => {
  const days = buildGallery(
    [{ id: 'm1', member_id: 'alice', created_at: DAY_A, image_path: 'trip/x.png', image_url: null }],
    [],
    [{ id: 'p1', member_id: 'dave', created_at: DAY_A, image_path: 'trip/p1.webp', image_url: undefined }]
  )
  const flat = days.flatMap((d) => d.photos)
  assert.equal(flat.length, 2)
  assert.ok(flat.every((p) => p.url === null))
})

test('empty inputs yield no day groups', () => {
  assert.deepEqual(buildGallery([], [], []), [])
})
