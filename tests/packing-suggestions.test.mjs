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
import { derivePackingSuggestions } from '../src/features/packing/suggestions.ts'

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
