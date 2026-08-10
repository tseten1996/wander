/**
 * Unit tests for the chat @-mention parser (src/features/messages/mentions.ts,
 * issue #193 — epic #181 slice 2).
 *
 * Pure module, exercised directly with the built-in Node test runner
 * (`node:test` + `node:assert`), matching tests/spans.test.mjs. Node strips the
 * TypeScript types on import, so the module is tested exactly as it ships.
 *
 *   node --test tests/mentions.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMentions,
  extractMentionIds,
  mentionsToPlainText,
  formatMention,
  detectActiveMention,
  matchMembers,
  applyMention,
} from '../src/features/messages/mentions.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const jane = { id: A, display_name: 'Jane Doe' }
const bob = { id: B, display_name: 'Bob' }

test('parseMentions splits text and mention tokens in order', () => {
  const segments = parseMentions(`hey @[Jane Doe](${A}) and @[Bob](${B})!`)
  assert.deepEqual(segments, [
    { type: 'text', value: 'hey ' },
    { type: 'mention', name: 'Jane Doe', memberId: A },
    { type: 'text', value: ' and ' },
    { type: 'mention', name: 'Bob', memberId: B },
    { type: 'text', value: '!' },
  ])
})

test('parseMentions returns a lone text segment when there are no mentions', () => {
  assert.deepEqual(parseMentions('just a normal message'), [
    { type: 'text', value: 'just a normal message' },
  ])
})

test('parseMentions ignores malformed / non-uuid tokens as plain text', () => {
  assert.deepEqual(parseMentions('email a@b and @[Nope](not-a-uuid)'), [
    { type: 'text', value: 'email a@b and @[Nope](not-a-uuid)' },
  ])
})

test('extractMentionIds returns distinct ids in first-seen order', () => {
  const ids = extractMentionIds(`@[Jane](${A}) @[Bob](${B}) @[Jane again](${A})`)
  assert.deepEqual(ids, [A, B])
})

test('extractMentionIds is empty for a mention-free message', () => {
  assert.deepEqual(extractMentionIds('nothing here'), [])
})

test('mentionsToPlainText flattens tokens to @Name', () => {
  assert.equal(
    mentionsToPlainText(`hi @[Jane Doe](${A}), see @[Bob](${B})`),
    'hi @Jane Doe, see @Bob'
  )
})

test('formatMention builds the stored token', () => {
  assert.equal(formatMention(jane), `@[Jane Doe](${A})`)
})

test('detectActiveMention finds an @query under the caret', () => {
  assert.deepEqual(detectActiveMention('@ja', 3), { start: 0, query: 'ja' })
  assert.deepEqual(detectActiveMention('hi @ja', 6), { start: 3, query: 'ja' })
  // Bare '@' with nothing typed yet is still active (empty query).
  assert.deepEqual(detectActiveMention('hi @', 4), { start: 3, query: '' })
  // '@' after a newline counts as after whitespace.
  assert.deepEqual(detectActiveMention('a\n@bo', 5), { start: 2, query: 'bo' })
})

test('detectActiveMention ignores @ mid-word (e.g. emails)', () => {
  assert.equal(detectActiveMention('mail@x', 6), null)
})

test('detectActiveMention does not re-trigger inside an inserted token', () => {
  const text = `hi @[Jane Doe](${A}) `
  // Caret at the very end (after the trailing space).
  assert.equal(detectActiveMention(text, text.length), null)
})

test('matchMembers filters case-insensitively; empty query matches all', () => {
  const members = [jane, bob]
  assert.deepEqual(matchMembers(members, 'ja'), [jane])
  assert.deepEqual(matchMembers(members, 'DOE'), [jane])
  assert.deepEqual(matchMembers(members, 'bo'), [bob]) // only "Bob" contains "bo"
  assert.deepEqual(matchMembers(members, ''), members)
})

test('applyMention replaces the @query with a token and reports the caret', () => {
  const res = applyMention('hi @ja', { start: 3, query: 'ja' }, jane)
  const token = `@[Jane Doe](${A})`
  assert.equal(res.text, `hi ${token} `)
  assert.equal(res.caret, `hi ${token} `.length)
})

test('applyMention preserves text after the caret', () => {
  const res = applyMention('hi @ja!', { start: 3, query: 'ja' }, bob)
  assert.equal(res.text, `hi @[Bob](${B}) !`)
})
