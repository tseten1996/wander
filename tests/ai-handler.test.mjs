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
 * `rpcCalls` captures the usage ledger so tests can assert what was recorded.
 *
 * `throwOn` distinguishes which read blows up. It matters because both reads
 * now go through ONE caller-scoped client (the service-role key was removed in
 * favour of the record_ai_usage RPC), so a blanket "throw" would always trip
 * the membership guard first and the quota's fail-closed path would never be
 * reached — the test would pass while asserting nothing.
 */
function fakeDb({ member = { id: 'm1' }, count = 0, quotaError = null, memberError = null, throwOn = null } = {}) {
  const rpcCalls = []
  return {
    rpcCalls,
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                // Errors are per-read, not shared: both go through one client
                // now, so a single `error` flag would trip the membership guard
                // and the quota assertion below would never be exercised.
                gte: async () => {
                  if (throwOn === 'quota' || throwOn === 'all') throw new Error('boom')
                  return { count, error: quotaError }
                },
                maybeSingle: async () => {
                  if (throwOn === 'membership' || throwOn === 'all') throw new Error('boom')
                  return { data: member, error: memberError }
                },
              }
            },
          }
        },
      }
    },
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args })
      return { error: null }
    },
  }
}

const validBody = { intent: 'improve_day', tripId: TRIP, day: '2026-09-04' }

const deps = (over = {}) => ({
  db: fakeDb(),
  enabled: true,
  ...over,
})

/* ── kill switch ─────────────────────────────────────────────────────────── */

test('the kill switch refuses before touching the database', async () => {
  const db = fakeDb()
  const res = await handleAiRequest(validBody, { db, enabled: false })
  assert.equal(res.status, 503)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.reason, 'disabled')
  assert.equal(db.rpcCalls.length, 0, 'nothing recorded — nothing happened')
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
  const res = await handleAiRequest(validBody, deps({ db: fakeDb({ member: null }) }))
  assert.equal(res.status, 403)
  assert.equal(res.body.reason, 'forbidden')
})

test('a failed membership read refuses rather than continuing', async () => {
  // Fails closed: an authorization query we could not run is not permission.
  const res = await handleAiRequest(validBody, deps({ db: fakeDb({ throwOn: 'membership' }) }))
  assert.equal(res.status, 403)
})

/* ── quota: per trip, and fails closed ───────────────────────────────────── */

test('a trip at its limit is refused, and the refusal is recorded', async () => {
  const db = fakeDb({ count: QUOTA_PER_TRIP })
  const res = await handleAiRequest(validBody, deps({ db }))
  assert.equal(res.status, 429)
  assert.equal(res.body.reason, 'quota')
  assert.equal(db.rpcCalls.length, 1, 'refusals cost a row too')
  assert.equal(db.rpcCalls[0].args.p_outcome, 'refused')
})

test('a trip one under its limit is served', async () => {
  const db = fakeDb({ count: QUOTA_PER_TRIP - 1 })
  const res = await handleAiRequest(validBody, deps({ db }))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(db.rpcCalls[0].args.p_outcome, 'ok')
})

test('an unreadable quota refuses — never fails open', async () => {
  // This is the one that matters. Failing open here would delete the only
  // bound on what a leaked invite link can cost.
  const errored = await handleAiRequest(validBody, deps({ db: fakeDb({ count: null, quotaError: 'nope' }) }))
  assert.equal(errored.status, 503)
  assert.equal(errored.body.reason, 'quota')

  const threw = await handleAiRequest(validBody, deps({ db: fakeDb({ throwOn: 'quota' }) }))
  assert.equal(threw.status, 503, 'a throwing quota read must refuse, not proceed')
})

/* ── the ledger ──────────────────────────────────────────────────────────── */

test('a served call records the trip, member and feature', async () => {
  const db = fakeDb()
  await handleAiRequest(validBody, deps({ db }))
  assert.equal(db.rpcCalls[0].fn, 'record_ai_usage')
  assert.deepEqual(db.rpcCalls[0].args, {
    p_trip_id: TRIP, p_feature: 'improve_day', p_outcome: 'ok',
  })
})

test('a ledger write failure does not break the response', async () => {
  // Losing a row costs a little quota accuracy; throwing here would cost the
  // user their answer for a bookkeeping problem.
  const db = fakeDb()
  db.rpc = async () => { throw new Error('ledger down') }
  const res = await handleAiRequest(validBody, deps({ db }))
  assert.equal(res.status, 200)
})

test('no model is called in this slice', async () => {
  const res = await handleAiRequest(validBody, deps())
  assert.equal(res.body.usage.inputTokens, 0)
  assert.equal(res.body.usage.outputTokens, 0)
})
