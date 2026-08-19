/**
 * The transport-failure vocabulary (src/features/ai/messages.ts).
 *
 * These messages exist because a generic one cost a real debugging session: an
 * offline phone and a host with no Function deployed produced the identical
 * sentence, so the only evidence available fit both explanations equally well.
 * Asserting the wording keeps that distinction from quietly collapsing back
 * into one string the next time someone tidies the copy.
 *
 *   node --test tests/ai-transport.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { describeTransportFailure: describe } = await import(
  '../src/features/ai/messages.ts'
)

test('offline and a bad response never read the same', () => {
  const offline = describe('offline')
  const missing = describe('bad-response', 404)
  assert.notEqual(offline, missing)
  assert.match(offline, /offline/i)
  assert.doesNotMatch(offline, /HTTP/, 'nothing answered, so there is no status to quote')
})

test('the status is carried into the message — it is the useful fact', () => {
  assert.match(describe('bad-response', 404), /404/)
  assert.match(describe('bad-response', 502), /502/)
})

test('a bad response with no status still reads sensibly', () => {
  const msg = describe('bad-response')
  assert.ok(msg.length > 0)
  assert.doesNotMatch(msg, /undefined|NaN/)
})

test('no message blames the member', () => {
  for (const msg of [describe('offline'), describe('bad-response', 404), describe('bad-response')]) {
    assert.doesNotMatch(msg, /you did|your fault|invalid/i)
  }
})
