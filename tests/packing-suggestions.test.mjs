/**
 * Unit tests for the weather-aware packing nudges (src/features/packing/
 * suggestions.ts, issue #178). Like tests/geo.test.mjs and places.test.mjs,
 * these run against the TypeScript source directly: Node (>= 22.18) strips the
 * types on import, and suggestions.ts's only runtime import is lucide-react
 * (its `@/types` / `@/lib/weather` imports are type-only, so no path alias ever
 * needs resolving).
 *
 *   node --test tests/packing-suggestions.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  derivePackingSuggestions,
  filterNewPackingItems,
} from '../src/features/packing/suggestions.ts'

/** Build a DailyWeather-shaped day; code defaults to 0 (clear). */
function day(date, tempMin, tempMax, code = 0) {
  return { date, tempMin, tempMax, code }
}

function ids(suggestions) {
  return suggestions.map((s) => s.id)
}

test('no forecast → no suggestions', () => {
  assert.deepEqual(derivePackingSuggestions([]), [])
})

test('mild, dry forecast → no suggestions', () => {
  const days = [day('2026-08-01', 15, 24), day('2026-08-02', 16, 25)]
  assert.deepEqual(derivePackingSuggestions(days), [])
})

test('rainy days produce a rain nudge with a day count', () => {
  const days = [
    day('2026-08-01', 15, 24, 61), // rain
    day('2026-08-02', 16, 25, 0), // clear
    day('2026-08-03', 15, 23, 95), // thunderstorm
  ]
  const suggestions = derivePackingSuggestions(days)
  assert.deepEqual(ids(suggestions), ['rain'])
  assert.match(suggestions[0].message, /2 of 3 days/)
  // adds an item into a sensible category, one-tap
  const cats = suggestions[0].items.map((i) => i.category)
  assert.ok(cats.includes('clothes'))
  assert.ok(cats.includes('misc'))
})

test('drizzle and rain-shower codes count as wet; dry codes do not', () => {
  const wet = derivePackingSuggestions([day('2026-08-01', 15, 24, 51)]) // drizzle
  assert.deepEqual(ids(wet), ['rain'])
  const showers = derivePackingSuggestions([day('2026-08-01', 15, 24, 82)]) // rain showers
  assert.deepEqual(ids(showers), ['rain'])
  const foggy = derivePackingSuggestions([day('2026-08-01', 15, 24, 45)]) // fog, not wet
  assert.deepEqual(ids(foggy), [])
})

test('a cold low triggers a warm-layers nudge', () => {
  const days = [day('2026-08-01', 2, 10), day('2026-08-02', 6, 12)]
  const suggestions = derivePackingSuggestions(days)
  assert.deepEqual(ids(suggestions), ['cold'])
  assert.match(suggestions[0].message, /2°C/)
  assert.equal(suggestions[0].items[0].category, 'clothes')
})

test('a hot high triggers a sun-protection nudge', () => {
  const days = [day('2026-08-01', 22, 34)]
  const suggestions = derivePackingSuggestions(days)
  assert.deepEqual(ids(suggestions), ['heat'])
  assert.match(suggestions[0].message, /34°C/)
  const cats = suggestions[0].items.map((i) => i.category)
  assert.ok(cats.includes('toiletries'))
})

test('thresholds are inclusive at the boundary (5°C low, 30°C high)', () => {
  assert.deepEqual(ids(derivePackingSuggestions([day('2026-08-01', 5, 20)])), ['cold'])
  assert.deepEqual(ids(derivePackingSuggestions([day('2026-08-01', 15, 30)])), ['heat'])
  // just outside the boundary → nothing
  assert.deepEqual(derivePackingSuggestions([day('2026-08-01', 6, 29)]), [])
})

test('rain, cold and heat can all fire together, in that order', () => {
  const days = [
    day('2026-08-01', 2, 33, 61), // wet + cold low + hot high
  ]
  assert.deepEqual(ids(derivePackingSuggestions(days)), ['rain', 'cold', 'heat'])
})

// --- #412: suppression by existing items + add dedupe ---

test('a nudge is suppressed once all its items are already on the list', () => {
  const days = [day('2026-08-01', 2, 10)] // cold → Warm layers (clothes)
  const existing = [{ name: 'Warm layers', category: 'clothes' }]
  assert.deepEqual(derivePackingSuggestions(days, undefined, existing), [])
})

test('a nudge still shows while any of its items is missing (full items kept)', () => {
  const days = [day('2026-08-01', 15, 24, 61)] // rain → Rain jacket + Umbrella
  const existing = [{ name: 'Rain jacket', category: 'clothes' }] // only one present
  const suggestions = derivePackingSuggestions(days, undefined, existing)
  assert.deepEqual(ids(suggestions), ['rain'])
  // The nudge keeps its full recommendation; the add path is what dedupes.
  assert.deepEqual(
    suggestions[0].items.map((i) => i.name),
    ['Rain jacket', 'Umbrella'],
  )
})

test('matching is case-insensitive, trimmed, and category-scoped', () => {
  const days = [day('2026-08-01', 15, 24, 61)] // rain nudge
  // Same names but different casing/whitespace → treated as present.
  const present = [
    { name: '  rain JACKET ', category: 'clothes' },
    { name: 'umbrella', category: 'misc' },
  ]
  assert.deepEqual(derivePackingSuggestions(days, undefined, present), [])
  // Umbrella filed under the wrong category does not satisfy the misc umbrella.
  const wrongCategory = [
    { name: 'Rain jacket', category: 'clothes' },
    { name: 'Umbrella', category: 'clothes' },
  ]
  assert.deepEqual(ids(derivePackingSuggestions(days, undefined, wrongCategory)), ['rain'])
})

test('empty existing list leaves the pre-#412 behaviour unchanged', () => {
  const days = [day('2026-08-01', 2, 10)]
  assert.deepEqual(
    ids(derivePackingSuggestions(days, undefined, [])),
    ids(derivePackingSuggestions(days)),
  )
})

test('filterNewPackingItems drops only the items already present in that category', () => {
  const items = [
    { name: 'Rain jacket', category: 'clothes' },
    { name: 'Umbrella', category: 'misc' },
  ]
  // Nothing present → everything is new.
  assert.deepEqual(filterNewPackingItems(items, []), items)
  // One present (case/space-insensitive) → only the other remains.
  assert.deepEqual(
    filterNewPackingItems(items, [{ name: 'RAIN JACKET', category: 'clothes' }]),
    [{ name: 'Umbrella', category: 'misc' }],
  )
  // All present → nothing to add.
  assert.deepEqual(
    filterNewPackingItems(items, [
      { name: 'Rain jacket', category: 'clothes' },
      { name: 'Umbrella', category: 'misc' },
    ]),
    [],
  )
})
