/**
 * The pure core of scripts/gmail-refresh-token.mjs (epic #181).
 *
 * The flow itself needs a browser and a human, so what is tested here is the
 * part that can be silently wrong: the consent URL's parameters, the PKCE
 * derivation, and the callback validation. A missing `prompt=consent` is the
 * classic failure — Google returns an access token and no refresh token, with
 * no error explaining why — so it is asserted explicitly.
 *
 *   node --test tests/gmail-oauth.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const { base64url, pkcePair, buildAuthUrl, readCallback } = await import(
  '../scripts/gmail-refresh-token.mjs'
)

const params = (over = {}) =>
  new URL(
    buildAuthUrl({
      clientId: 'cid.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:53121',
      challenge: 'chal',
      state: 'st',
      ...over,
    }),
  ).searchParams

test('base64url avoids the characters that break a URL parameter', () => {
  const out = base64url(Buffer.from([0xfb, 0xff, 0xfe]))
  assert.ok(!/[+/=]/.test(out))
})

test('the consent URL requests offline access AND forces the consent screen', () => {
  // Both are load-bearing. Without access_type=offline there is no refresh
  // token at all; without prompt=consent Google issues one only on the very
  // first authorization, so a re-run after any mistake returns nothing.
  const p = params()
  assert.equal(p.get('access_type'), 'offline')
  assert.equal(p.get('prompt'), 'consent')
})

test('the consent URL asks for gmail.send and nothing wider', () => {
  // A leaked token must be able to send as you but never read your inbox.
  assert.equal(params().get('scope'), 'https://www.googleapis.com/auth/gmail.send')
})

test('the consent URL carries the PKCE challenge with S256', () => {
  const p = params({ challenge: 'abc123' })
  assert.equal(p.get('code_challenge'), 'abc123')
  assert.equal(p.get('code_challenge_method'), 'S256')
})

test('the consent URL asks for an authorization code, not a token', () => {
  assert.equal(params().get('response_type'), 'code')
})

test('the redirect URI is passed through verbatim', () => {
  // The token exchange must repeat it exactly, so any normalization here
  // would break the exchange rather than the redirect.
  assert.equal(params().get('redirect_uri'), 'http://127.0.0.1:53121')
})

test('pkcePair derives the challenge as S256 of the verifier', () => {
  const { verifier, challenge } = pkcePair(Buffer.alloc(32, 7))
  const expected = base64url(createHash('sha256').update(verifier).digest())
  assert.equal(challenge, expected)
  assert.ok(verifier.length >= 43, 'RFC 7636 requires 43+ characters')
  assert.ok(!/[+/=]/.test(verifier) && !/[+/=]/.test(challenge))
})

test('pkcePair is different every call', () => {
  assert.notEqual(pkcePair().verifier, pkcePair().verifier)
})

test('readCallback extracts the code when the state matches', () => {
  assert.deepEqual(readCallback('/?code=abc&state=st', 'st'), { code: 'abc' })
})

test('readCallback rejects a mismatched state', () => {
  // A stale browser tab from an earlier run, or a cross-site forgery.
  assert.deepEqual(readCallback('/?code=abc&state=wrong', 'st'), { error: 'state mismatch' })
})

test('readCallback rejects a missing state even with a valid-looking code', () => {
  assert.deepEqual(readCallback('/?code=abc', 'st'), { error: 'state mismatch' })
})

test('readCallback surfaces a denial from Google', () => {
  assert.deepEqual(readCallback('/?error=access_denied&state=st', 'st'), {
    error: 'access_denied',
  })
})

test('readCallback reports a callback with no code', () => {
  assert.deepEqual(readCallback('/?state=st', 'st'), { error: 'no code in callback' })
})

test('readCallback tolerates a bare path', () => {
  // The browser hits '/' before any query in some flows; it must not throw.
  assert.deepEqual(readCallback('/', 'st'), { error: 'state mismatch' })
})
