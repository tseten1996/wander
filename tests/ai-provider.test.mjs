/**
 * Unit tests for the Workers AI adapter (src/server/ai/provider.ts, #212).
 *
 * Everything here is about the seam between a binding we do not control and a
 * result the handler validates. There is no network: the binding is a fake, and
 * the cases are the shapes Workers AI actually returns — the pre-parsed object
 * under `response`, the OpenAI-compatible `choices[].message.content` string,
 * and the ways both can be absent or unparseable.
 *
 *   node --test tests/ai-provider.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { workersAiProvider, MODELS } = await import('../src/server/ai/provider.ts')

const args = {
  system: 'sys',
  user: 'usr',
  schema: { type: 'object' },
  maxOutputTokens: 300,
  tier: 'cheap',
}

/** Records the input it was handed and replies with whatever the test supplies. */
function fakeAi(reply) {
  const calls = []
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input })
      return reply
    },
  }
}

test('the tier picks the model — call sites never name one', async () => {
  const ai = fakeAi({ response: { day: '2026-09-17' } })
  await workersAiProvider(ai).complete(args)
  assert.equal(ai.calls[0].model, MODELS.cheap)
  assert.notEqual(MODELS.cheap, MODELS.reasoning, 'two tiers, two models')
})

test('JSON mode is a constraint on generation, not an instruction in the prompt', async () => {
  // If this ever regresses to "please reply with JSON" in the system prompt,
  // the largest failure class in the paste flow comes back.
  const ai = fakeAi({ response: {} })
  await workersAiProvider(ai).complete(args)
  const { input } = ai.calls[0]
  assert.equal(input.response_format.type, 'json_schema')
  assert.deepEqual(input.response_format.json_schema, args.schema)
  assert.equal(input.max_tokens, 300)
  assert.deepEqual(input.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'usr' },
  ])
})

test('the pre-parsed `response` object is preferred', async () => {
  const ai = fakeAi({
    response: { day: '2026-09-17' },
    choices: [{ message: { content: '{"day":"1999-01-01"}' } }],
    usage: { prompt_tokens: 509, completion_tokens: 115 },
  })
  const out = await workersAiProvider(ai).complete(args)
  assert.deepEqual(out.json, { day: '2026-09-17' })
  assert.equal(out.inputTokens, 509)
  assert.equal(out.outputTokens, 115)
})

test('a text-only reply is parsed from choices[]', async () => {
  const ai = fakeAi({ choices: [{ message: { content: '{"day":"2026-09-17"}' } }] })
  const out = await workersAiProvider(ai).complete(args)
  assert.deepEqual(out.json, { day: '2026-09-17' })
})

test('an unparseable reply yields undefined rather than a guess', async () => {
  // The handler treats undefined as "found nothing" and degrades. Salvaging
  // half a JSON object here would turn a failed call into a confident wrong one.
  for (const reply of [
    { choices: [{ message: { content: 'Sure! {"day":' } }] },
    { choices: [{ message: {} }] },
    { choices: [] },
    {},
    null,
  ]) {
    const out = await workersAiProvider(fakeAi(reply)).complete(args)
    assert.equal(out.json, undefined)
    assert.equal(out.inputTokens, 0)
    assert.equal(out.outputTokens, 0)
  }
})

test('a reply carrying JSON null is not mistaken for a missing reply', async () => {
  // `response: null` is the model answering "nothing"; both paths land on a
  // falsy value, so this only asserts it does not throw on the way through.
  const out = await workersAiProvider(fakeAi({ response: null })).complete(args)
  assert.equal(out.json, null)
})

test('missing usage counts read as zero, never as NaN', async () => {
  const out = await workersAiProvider(fakeAi({ response: {}, usage: {} })).complete(args)
  assert.equal(out.inputTokens, 0)
  assert.equal(out.outputTokens, 0)
})
