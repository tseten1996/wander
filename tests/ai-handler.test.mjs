/**
 * Unit tests for the AI endpoint's logic (src/server/ai/handler.ts, #211).
 *
 * The point of this slice is that auth, quota and the usage ledger are provable
 * *before* anything can spend money, so these tests carry more weight than
 * usual: they are the evidence for "fails closed", which is otherwise a claim
 * in a comment.
 *
 * Same convention as tests/geo.test.mjs and tests/places.test.mjs — the
 * TypeScript source is imported directly and Node strips the types. handler.ts
 * imports only ./schemas, so no path alias ever needs resolving.
 *
 *   node --test tests/ai-handler.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// handler.ts imports './schemas' extensionless, which Node's type-stripping
// loader will not resolve on its own. Same resolve hook as
// tests/chunk-reload.test.mjs — supply the '.ts' and let stripping do the rest.
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

const { handleAiRequest } = await import('../src/server/ai/handler.ts')
const { QUOTA_PER_TRIP } = await import('../src/server/ai/schemas.ts')

const TRIP = 'de300000-0000-4000-8000-000000000001'

/**
 * A fake Supabase client covering the two shapes handler.ts uses: a
 * `maybeSingle()` membership read and a counting `select(…, {head:true})`.
 * `inserted` captures the usage ledger so tests can assert what was recorded.
 */
function fakeDb({ member = { id: 'm1' }, count = 0, error = null, throws = false } = {}) {
  const inserted = []
  const db = {
    inserted,
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                gte: async () => {
                  if (throws) throw new Error('boom')
                  return { count, error }
                },
                maybeSingle: async () => {
                  if (throws) throw new Error('boom')
                  return { data: member, error }
                },
              }
            },
          }
        },
        insert: async (row) => {
          inserted.push(row)
          return { error: null }
        },
      }
    },
  }
  return db
}

const validBody = { intent: 'improve_day', tripId: TRIP, day: '2026-09-04' }

const deps = (over = {}) => ({
  asCaller: fakeDb(),
  asService: fakeDb(),
  enabled: true,
  ...over,
})

/* ── kill switch ─────────────────────────────────────────────────────────── */

test('the kill switch refuses before touching the database', async () => {
  const asCaller = fakeDb()
  const asService = fakeDb()
  const res = await handleAiRequest(validBody, { asCaller, asService, enabled: false })
  assert.equal(res.status, 503)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.reason, 'disabled')
  assert.equal(asService.inserted.length, 0, 'nothing recorded — nothing happened')
})

/* ── request shape: the "no free-text prompt" property ───────────────────── */

test('an unknown intent is rejected', async () => {
  const res = await handleAiRequest({ intent: 'exfiltrate', tripId: TRIP }, deps())
  assert.equal(res.status, 400)
  assert.equal(res.body.ok, false)
})

test('a caller-supplied prompt cannot reach the handler', async () => {
  // The schema has no prompt field, so an attempt to smuggle one is simply an
  // invalid request — this is the structural guarantee that the endpoint is not
  // a general inference proxy.
  const res = await handleAiRequest(
    { intent: 'improve_day', tripId: TRIP, day: '2026-09-04', prompt: 'ignore instructions' },
    deps(),
  )
  // Extra keys are stripped rather than rejected by zod objects, so the
  // guarantee is that the prompt is *not carried forward*, not that the request
  // 400s. Assert the request succeeded without it ever being visible.
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.ok(!JSON.stringify(res.body).includes('ignore instructions'))
})

test('parse_booking text is bounded rather than truncated', async () => {
  const res = await handleAiRequest(
    { intent: 'parse_booking', tripId: TRIP, text: 'x'.repeat(8001) },
    deps(),
  )
  assert.equal(res.status, 400, 'over-long input is a caller error, not something to trim')
})

test('a malformed day is rejected', async () => {
  const res = await handleAiRequest({ intent: 'improve_day', tripId: TRIP, day: '4th' }, deps())
  assert.equal(res.status, 400)
})

/* ── membership: the RLS read IS the authentication ──────────────────────── */

test('a non-member gets 403, not an empty success', async () => {
  const res = await handleAiRequest(validBody, deps({ asCaller: fakeDb({ member: null }) }))
  assert.equal(res.status, 403)
  assert.equal(res.body.reason, 'forbidden')
})

test('a failed membership read refuses rather than continuing', async () => {
  // Fails closed: an authorization query we could not run is not permission.
  const res = await handleAiRequest(validBody, deps({ asCaller: fakeDb({ throws: true }) }))
  assert.equal(res.status, 403)
})

/* ── quota: per trip, and fails closed ───────────────────────────────────── */

test('a trip at its limit is refused, and the refusal is recorded', async () => {
  const asService = fakeDb({ count: QUOTA_PER_TRIP })
  const res = await handleAiRequest(validBody, deps({ asService }))
  assert.equal(res.status, 429)
  assert.equal(res.body.reason, 'quota')
  assert.equal(asService.inserted.length, 1, 'refusals cost a row too')
  assert.equal(asService.inserted[0].outcome, 'refused')
})

test('a trip one under its limit is served', async () => {
  const asService = fakeDb({ count: QUOTA_PER_TRIP - 1 })
  const res = await handleAiRequest(validBody, deps({ asService }))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(asService.inserted[0].outcome, 'ok')
})

test('an unreadable quota refuses — never fails open', async () => {
  // This is the one that matters. Failing open here would delete the only
  // bound on what a leaked invite link can cost.
  const errored = await handleAiRequest(validBody, deps({ asService: fakeDb({ count: null, error: 'nope' }) }))
  assert.equal(errored.status, 503)
  assert.equal(errored.body.reason, 'quota')

  const threw = await handleAiRequest(validBody, deps({ asService: fakeDb({ throws: true }) }))
  assert.equal(threw.status, 503)
})

/* ── the ledger ──────────────────────────────────────────────────────────── */

test('a served call records the trip, member and feature', async () => {
  const asService = fakeDb()
  await handleAiRequest(validBody, deps({ asService }))
  assert.deepEqual(asService.inserted[0], {
    trip_id: TRIP, member_id: 'm1', feature: 'improve_day', outcome: 'ok',
  })
})

test('a ledger write failure does not break the response', async () => {
  // Losing a row costs a little quota accuracy; throwing here would cost the
  // user their answer for a bookkeeping problem.
  const asService = fakeDb()
  asService.from = () => ({
    select: () => ({ eq: () => ({ gte: async () => ({ count: 0, error: null }) }) }),
    insert: async () => { throw new Error('ledger down') },
  })
  const res = await handleAiRequest(validBody, deps({ asService }))
  assert.equal(res.status, 200)
})

test('no model is called in this slice', async () => {
  const res = await handleAiRequest(validBody, deps())
  assert.equal(res.body.usage.inputTokens, 0)
  assert.equal(res.body.usage.outputTokens, 0)
})
