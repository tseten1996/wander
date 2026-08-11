/**
 * Unit tests for the temperature-unit helpers (src/lib/units.ts, issue #220).
 * Like tests/packing-suggestions.test.mjs, these run against the TypeScript
 * source directly — Node (>= 22.18) strips the types on import, and units.ts
 * has no runtime imports, so no path alias ever needs resolving.
 *
 *   node --test tests/units.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertTemp, formatTemp, defaultTempUnit } from '../src/lib/units.ts'

test('convertTemp leaves Celsius untouched, rounds to a whole degree', () => {
  assert.equal(convertTemp(21, 'C'), 21)
  assert.equal(convertTemp(21.4, 'C'), 21)
  assert.equal(convertTemp(21.6, 'C'), 22)
})

test('convertTemp converts Celsius to Fahrenheit, rounded', () => {
  assert.equal(convertTemp(0, 'F'), 32)
  assert.equal(convertTemp(100, 'F'), 212)
  assert.equal(convertTemp(27, 'F'), 81) // 80.6 → 81
  assert.equal(convertTemp(-40, 'F'), -40) // the crossover point
})

test('formatTemp always carries an explicit unit marker', () => {
  assert.equal(formatTemp(27, 'C'), '27°C')
  assert.equal(formatTemp(27, 'F'), '81°F')
  assert.equal(formatTemp(2, 'C'), '2°C')
})

test('defaultTempUnit returns a valid unit derived from the host locale', () => {
  // The value depends on the runtime's `navigator.language` (undefined in some
  // Node builds → °C; a Fahrenheit-first tag like en-US → °F), so we only
  // assert it resolves to a legal unit rather than pinning the host locale.
  assert.ok(['C', 'F'].includes(defaultTempUnit()))
})
