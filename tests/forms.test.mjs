/**
 * Unit tests for the shared optional-money schema (src/lib/forms.ts).
 *
 * These exist because the obvious spelling of this field is silently wrong.
 * `z.coerce.number().min(0).optional().nullable().or(z.literal(''))` looks like
 * it keeps a blank field blank, but `Number('')` is `0`, `0` satisfies
 * `.min(0)`, and so the `z.literal('')` fallback is dead code — every empty
 * cost/estimate/actual was stored as a real `0`. That single character of
 * difference changed the Planned budget total (`tripActual ?? tripEstimated`
 * stops falling back once actual is 0) and put a "planning note, not in
 * budget" chip on itinerary items that never had a price.
 *
 * The regression is invisible at the type level and invisible in the UI until
 * the data is inspected, so it gets a test.
 *
 *   node --test tests/forms.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { optionalAmount } from '../src/lib/forms.ts'

const schema = optionalAmount()

test('blank input stays blank instead of coercing to 0', () => {
  assert.equal(schema.parse(''), null)
  assert.equal(schema.parse('   '), null)
  assert.equal(schema.parse(null), null)
  assert.equal(schema.parse(undefined), undefined)
})

test('the naive spelling really does have the bug this guards against', () => {
  // Kept as an executable explanation: if a future refactor "simplifies"
  // optionalAmount back to this, the test above starts failing and this one
  // says why.
  const naive = z.coerce.number().min(0).optional().nullable().or(z.literal(''))
  assert.equal(naive.parse(''), 0, 'Number("") is 0 and satisfies .min(0)')
})

test('real amounts pass through as numbers', () => {
  assert.equal(schema.parse('100'), 100)
  assert.equal(schema.parse('12.50'), 12.5)
  assert.equal(schema.parse(0), 0, 'an explicit zero is still a real amount')
  assert.equal(schema.parse('0'), 0)
  assert.equal(schema.parse(42), 42)
})

test('negative and non-numeric input is rejected with the field message', () => {
  const negative = schema.safeParse('-5')
  assert.equal(negative.success, false)
  assert.match(negative.error.issues[0].message, /negative/i)

  const words = schema.safeParse('abc')
  assert.equal(words.success, false)
  assert.equal(words.error.issues[0].message, 'Enter a number')
})

test('custom messages override the defaults', () => {
  const cost = optionalAmount({ negative: 'Cost can’t be negative', invalid: 'Enter a cost' })
  assert.equal(cost.safeParse('-1').error.issues[0].message, 'Cost can’t be negative')
  assert.equal(cost.safeParse('nope').error.issues[0].message, 'Enter a cost')
})

test('a blank amount is distinguishable from a zero amount', () => {
  // The whole point: these two must not collapse into the same stored value.
  assert.notEqual(schema.parse(''), schema.parse('0'))
  assert.equal(schema.parse(''), null)
  assert.equal(schema.parse('0'), 0)
})
