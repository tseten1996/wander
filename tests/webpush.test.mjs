/**
 * Unit tests for the Web Push crypto (src/server/push/webpush.ts, #267).
 *
 * The sandbox cannot make a live push, so correctness is proven hermetically:
 *
 *   1. HKDF is checked against RFC 5869 Test Case 1 — an EXTERNAL known-answer
 *      vector that anchors the key-derivation primitive to the standard, so the
 *      round-trip below cannot pass on a self-consistent-but-wrong KDF.
 *   2. encryptPayload is round-tripped through an INDEPENDENT RFC 8291 receiver
 *      implemented here (its own ECDH + info-string assembly), recovering the
 *      exact plaintext — the proof that a real browser's push service layer
 *      would decrypt what we send.
 *   3. The VAPID header is parsed and its ES256 signature verified with the
 *      public key, with the audience pinned to the endpoint origin (RFC 8292).
 *
 *   node --test tests/webpush.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hkdf,
  encryptPayload,
  buildVapidHeader,
  base64UrlToBytes,
  bytesToBase64Url,
} from '../src/server/push/webpush.ts'

const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)))
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
const enc = new TextEncoder()
const dec = new TextDecoder()

test('hkdf matches RFC 5869 Test Case 1 (SHA-256)', async () => {
  const ikm = hex('0b'.repeat(22))
  const salt = hex('000102030405060708090a0b0c')
  const info = hex('f0f1f2f3f4f5f6f7f8f9')
  const okm = await hkdf(salt, ikm, info, 42)
  assert.equal(
    toHex(okm),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  )
})

test('encryptPayload round-trips through an independent RFC 8291 receiver', async () => {
  // A user-agent (subscription) keypair. The private key stays here to play the
  // receiver; only the public point + a random auth secret go to the sender.
  const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))

  const target = {
    endpoint: 'https://push.example.com/x',
    p256dh: bytesToBase64Url(uaPublic),
    auth: bytesToBase64Url(authSecret),
  }
  const plaintext = enc.encode(
    JSON.stringify({ type: 'poll_opened', title: 'When do we leave?', n: 'abc' }),
  )
  const { body } = await encryptPayload(plaintext, target)

  // ── Parse the aes128gcm header (RFC 8188 §2.1) ──
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false)
  const idlen = body[20]
  assert.equal(rs, 4096)
  assert.equal(idlen, 65, 'keyid is an uncompressed P-256 point')
  const serverPublic = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)
  assert.ok(ciphertext.length > 16, 'ciphertext carries a GCM tag')

  // ── Independent receiver derivation ──
  const serverKey = await crypto.subtle.importKey(
    'raw',
    serverPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, uaPair.privateKey, 256),
  )
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...serverPublic])
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  )
  // Strip the RFC 8188 last-record delimiter (0x02).
  assert.equal(decrypted[decrypted.length - 1], 0x02)
  assert.equal(dec.decode(decrypted.slice(0, -1)), dec.decode(plaintext))
})

test('encryptPayload uses a fresh ephemeral key + salt each call', async () => {
  const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey))
  const target = {
    endpoint: 'https://push.example.com/x',
    p256dh: bytesToBase64Url(uaPublic),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  }
  const a = await encryptPayload(enc.encode('hi'), target)
  const b = await encryptPayload(enc.encode('hi'), target)
  assert.notEqual(toHex(a.salt), toHex(b.salt))
  assert.notEqual(toHex(a.serverPublicKey), toHex(b.serverPublicKey))
})

test('buildVapidHeader produces a verifiable ES256 JWT bound to the endpoint', async () => {
  // A VAPID keypair: public as a raw P-256 point, private as the JWK scalar.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const publicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const keys = { publicKey, privateKey: jwk.d, subject: 'mailto:ops@wander.example' }

  const now = 1_700_000_000_000
  const header = await buildVapidHeader('https://push.example.com/deep/path', keys, now)

  const m = header.match(/^vapid t=([^,]+), k=(.+)$/)
  assert.ok(m, 'header is `vapid t=<jwt>, k=<key>`')
  const [, jwt, k] = m
  assert.equal(k, publicKey, 'k carries the public key')

  const [h, p, s] = jwt.split('.')
  const claims = JSON.parse(dec.decode(base64UrlToBytes(p)))
  assert.equal(claims.aud, 'https://push.example.com', 'aud is the endpoint origin')
  assert.equal(claims.sub, keys.subject)
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 60 * 60)

  const verifyKey = await crypto.subtle.importKey(
    'raw',
    base64UrlToBytes(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    base64UrlToBytes(s),
    enc.encode(`${h}.${p}`),
  )
  assert.ok(ok, 'signature verifies against the public key')
})
