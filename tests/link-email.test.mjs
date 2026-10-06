/**
 * Unit tests for anonymous → email linking (src/features/auth/linkEmail.ts,
 * issue #383, epic #365 slice 1).
 *
 * The load-bearing guarantee of this slice is *continuity*: linking an email to
 * an anonymous friend's session must preserve `auth.uid()` so no joined trip is
 * orphaned. We encode that structurally — the link path performs *only*
 * `updateUser` (the uid-preserving upgrade) and never signs out or
 * re-authenticates, which are the only operations that could mint a new uid and
 * strand the friend's memberships. A mock auth client records every call, and
 * its re-auth methods throw if ever touched.
 *
 * Pure module: its only non-type content is plain functions (no React, no bound
 * Supabase client), and its `import`s are all `import type` (erased), so Node
 * (>= 22) runs it directly. Matches tests/payment-link.test.mjs / stays.test.mjs.
 *
 *   node --test tests/link-email.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEmail,
  isEmailTakenError,
  linkEmailErrorMessage,
  linkEmailWith,
} from '../src/features/auth/linkEmail.ts'

/** A mock Supabase auth client. `updateUser` resolves with `error` (default
 *  none) and records its args; every re-auth method throws, so a test fails
 *  loudly if the link path ever signs the friend out or in — the orphaning
 *  risk this slice exists to avoid. */
function mockAuth({ error = null } = {}) {
  const calls = []
  return {
    calls,
    updateUser(attributes, options) {
      calls.push({ method: 'updateUser', attributes, options })
      return Promise.resolve({ error })
    },
    signOut() {
      calls.push({ method: 'signOut' })
      throw new Error('linkEmail must never sign the session out — it would orphan joined trips')
    },
    signInAnonymously() {
      calls.push({ method: 'signInAnonymously' })
      throw new Error('linkEmail must never mint a new anonymous session')
    },
    signInWithOtp() {
      calls.push({ method: 'signInWithOtp' })
      throw new Error('linkEmail must never start a fresh sign-in — uid would change')
    },
  }
}

test('normalizeEmail trims and accepts a plausible address', () => {
  assert.equal(normalizeEmail('  friend@example.com '), 'friend@example.com')
  assert.equal(normalizeEmail('a.b+tag@sub.example.co'), 'a.b+tag@sub.example.co')
})

test('normalizeEmail rejects empties and obvious non-emails', () => {
  for (const bad of ['', '   ', 'nope', 'no-at-sign.com', 'two@@at.com', 'trailing@dot.']) {
    assert.equal(normalizeEmail(bad), null, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('continuity: linking only calls updateUser — never re-auths (uid preserved)', async () => {
  const auth = mockAuth()
  const result = await linkEmailWith(auth, '  Friend@Example.com ', 'https://app.example/')

  // The one and only auth operation is the uid-preserving upgrade.
  assert.equal(auth.calls.length, 1)
  assert.equal(auth.calls[0].method, 'updateUser')
  assert.deepEqual(auth.calls[0].attributes, { email: 'Friend@Example.com' })
  assert.deepEqual(auth.calls[0].options, { emailRedirectTo: 'https://app.example/' })
  // Resolves with the normalized email the confirmation was sent to.
  assert.equal(result, 'Friend@Example.com')
})

test('a missing redirect omits the options arg entirely', async () => {
  const auth = mockAuth()
  await linkEmailWith(auth, 'friend@example.com')
  assert.equal(auth.calls[0].options, undefined)
})

test('an invalid email never reaches the network and throws friendly copy', async () => {
  const auth = mockAuth()
  await assert.rejects(() => linkEmailWith(auth, 'not-an-email'), /valid email/i)
  assert.equal(auth.calls.length, 0, 'no updateUser call for an invalid address')
})

test('the already-linked email path surfaces its distinct remedy', async () => {
  // Supabase signals this with a stable error code; message is the fallback.
  assert.equal(isEmailTakenError({ code: 'email_exists' }), true)
  assert.equal(isEmailTakenError({ message: 'A user with this email address has already been registered' }), true)
  assert.equal(isEmailTakenError({ code: 'over_email_send_rate_limit' }), false)
  assert.equal(isEmailTakenError(null), false)

  assert.match(linkEmailErrorMessage({ code: 'email_exists' }), /already linked to another account/i)

  const auth = mockAuth({ error: { code: 'email_exists', message: 'already registered' } })
  await assert.rejects(() => linkEmailWith(auth, 'taken@example.com'), /already linked to another account/i)
  // The call was attempted (unlike the invalid-address case) — only the result failed.
  assert.equal(auth.calls.length, 1)
  assert.equal(auth.calls[0].method, 'updateUser')
})

test('a generic auth error falls back to its message, not the taken-email copy', () => {
  assert.equal(
    linkEmailErrorMessage({ message: 'Network request failed' }),
    'Network request failed',
  )
  // No message at all → a usable default.
  assert.match(linkEmailErrorMessage(null), /couldn’t send the confirmation email/i)
})
