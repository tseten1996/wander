/**
 * Unit tests for the trip-search collector (src/features/search/collect.ts) —
 * the pure matching behind Cmd-K. Focused on the three content kinds added in
 * #374 (stays, transport, wishlist) plus the shared ordering/cap rules.
 *
 * Pure module: it imports only an erased `type` (from `@/types`) and the pure
 * `./anchor` helper, so Node (>= 22) runs it directly — the TypeScript types are
 * stripped on import and the `@/` alias never needs resolving. Matches
 * tests/legs.test.mjs and tests/calendar-links.test.mjs.
 *
 *   node --test tests/search.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// collect.ts's only runtime import is `searchAnchorId` from `./anchor`; its type
// imports are erased. Node's ESM resolver won't add the `.ts` extension on its
// own, so map extensionless relative specifiers onto their source file — the
// same hook tests/gallery.test.mjs uses.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)

const { collectResults, KIND_ORDER, MAX_PER_KIND } = await import(
  '../src/features/search/collect.ts'
)

/** An empty source bundle — override only the sections a test cares about. */
function sources(overrides = {}) {
  return {
    itinerary: [], budget: [], polls: [], messages: [], checklist: [],
    notes: [], ideas: [], stays: [], transport: [], wishlist: [],
    ...overrides,
  }
}

/** Flatten the grouped output to the single group for `kind`, or undefined. */
function group(groups, kind) {
  return groups.find((g) => g.kind === kind)
}

const stay = {
  id: 's1', name: 'Hotel Sunrise', address: '123 Hauptstraße, Berlin',
  confirmation_code: 'ABC123', check_in: null, check_out: null,
}

test('a stay matches on name, address, and confirmation code', () => {
  for (const q of ['sunrise', 'hauptstraße', 'abc123']) {
    const g = group(collectResults(sources({ stays: [stay] }), q), 'stay')
    assert.ok(g, `expected a Stays group for "${q}"`)
    assert.equal(g.results[0].id, 's1')
    assert.equal(g.results[0].route, 'calendar')
    assert.equal(g.results[0].anchorId, 'wander-item-s1')
    assert.equal(g.results[0].title, 'Hotel Sunrise')
  }
})

test('a stay matched by code shows the code as the snippet, not the name', () => {
  const g = group(collectResults(sources({ stays: [stay] }), 'abc123'), 'stay')
  assert.equal(g.results[0].snippet, 'Confirmation: ABC123')
  // Matched by name → no snippet (the title already carries the match).
  const byName = group(collectResults(sources({ stays: [stay] }), 'sunrise'), 'stay')
  assert.equal(byName.results[0].snippet, null)
  // Matched by address → the address is the snippet.
  const byAddr = group(collectResults(sources({ stays: [stay] }), 'berlin'), 'stay')
  assert.equal(byAddr.results[0].snippet, stay.address)
})

const hop = {
  id: 't1', mode: 'train', depart_place: 'Paris', arrive_place: 'Amsterdam',
  confirmation_code: 'XY7Q2P', depart_at: null, arrive_at: null,
}

test('a transport hop matches on route, mode, and confirmation code', () => {
  for (const q of ['paris', 'amsterdam', 'train', 'xy7q2p']) {
    const g = group(collectResults(sources({ transport: [hop] }), q), 'transport')
    assert.ok(g, `expected a Transport group for "${q}"`)
    assert.equal(g.results[0].id, 't1')
    assert.equal(g.results[0].route, 'calendar')
    assert.equal(g.results[0].title, 'Paris → Amsterdam')
  }
})

test('a mode-only hop titles by its mode label', () => {
  const bare = { ...hop, depart_place: null, arrive_place: null }
  const g = group(collectResults(sources({ transport: [bare] }), 'train'), 'transport')
  assert.equal(g.results[0].title, 'Train')
  assert.equal(g.results[0].snippet, null) // title is already the mode
})

test('a routed hop matched by mode surfaces the mode as the snippet', () => {
  const g = group(collectResults(sources({ transport: [hop] }), 'train'), 'transport')
  assert.equal(g.results[0].snippet, 'Mode: Train')
  const byCode = group(collectResults(sources({ transport: [hop] }), 'xy7q2p'), 'transport')
  assert.equal(byCode.results[0].snippet, 'Confirmation: XY7Q2P')
})

const place = { id: 'w1', name: 'Blue Bottle Coffee', note: 'open late, worth a detour' }

test('a wishlist place matches on name and note, routing to the itinerary shelf', () => {
  const byName = group(collectResults(sources({ wishlist: [place] }), 'blue bottle'), 'wishlist')
  assert.ok(byName)
  assert.equal(byName.results[0].route, 'itinerary')
  assert.equal(byName.results[0].anchorId, 'wander-item-w1')
  assert.equal(byName.results[0].snippet, null)
  const byNote = group(collectResults(sources({ wishlist: [place] }), 'detour'), 'wishlist')
  assert.ok(byNote)
  assert.match(byNote.results[0].snippet, /detour/)
})

test('kinds come back in KIND_ORDER — stays and transport lead, wishlist trails', () => {
  // "e" matches all three: Hot**e**l Sunrise / Amsterdam / Blu**e** Bottle.
  const groups = collectResults(
    sources({ stays: [stay], transport: [hop], wishlist: [place] }),
    'e',
  )
  const kinds = groups.map((g) => g.kind)
  // Relative order must follow the canonical KIND_ORDER.
  const expected = KIND_ORDER.filter((k) => kinds.includes(k))
  assert.deepEqual(kinds, expected)
  assert.ok(kinds.indexOf('stay') < kinds.indexOf('wishlist'))
  assert.ok(kinds.indexOf('transport') < kinds.indexOf('wishlist'))
})

test('results are capped per kind at MAX_PER_KIND', () => {
  const many = Array.from({ length: MAX_PER_KIND + 4 }, (_, i) => ({
    ...stay, id: `s${i}`, name: `Sunset Inn ${i}`,
  }))
  const g = group(collectResults(sources({ stays: many }), 'sunset'), 'stay')
  assert.equal(g.results.length, MAX_PER_KIND)
})

test('no match yields no group, and only supplied sections are searched', () => {
  assert.equal(collectResults(sources({ stays: [stay] }), 'zzzznotfound').length, 0)
  // A stay query never leaks into an empty transport/wishlist section.
  const groups = collectResults(sources({ stays: [stay] }), 'sunrise')
  assert.equal(group(groups, 'transport'), undefined)
  assert.equal(group(groups, 'wishlist'), undefined)
})
