/**
 * The pure core of the Web Push client (#267): VAPID key decoding and
 * subscription serialization. These are the parts that must be exactly right —
 * a wrong `applicationServerKey` byte and the push service rejects every
 * subscription — so they live in a dependency-free, DOM-free module that
 * `node --test` can exercise directly (the browser-only functions guard
 * themselves and are covered by the smoke/integration path instead).
 *
 *   node --test tests/push.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { urlBase64ToUint8Array, toDeviceKeys, PUSH_SUPPORTED, notificationPermission } =
  await import('../src/lib/push.ts')

test('urlBase64ToUint8Array decodes standard base64url to bytes', () => {
  // 'AQID' is base64 for [1, 2, 3].
  assert.deepEqual([...urlBase64ToUint8Array('AQID')], [1, 2, 3])
})

test('urlBase64ToUint8Array restores URL-safe chars and missing padding', () => {
  // bytes [0xfb, 0xff] → standard '+/8=' → url-safe, unpadded '-_8'.
  assert.deepEqual([...urlBase64ToUint8Array('-_8')], [0xfb, 0xff])
})

test('urlBase64ToUint8Array handles a realistic 65-byte P-256 key length', () => {
  // A VAPID applicationServerKey is an uncompressed P-256 point: 65 bytes.
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => i)
  const b64url = Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  assert.deepEqual([...urlBase64ToUint8Array(b64url)], [...bytes])
})

test('toDeviceKeys extracts endpoint + keys from a PushSubscription', () => {
  const sub = {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ keys: { p256dh: 'PKEY', auth: 'AKEY' } }),
  }
  assert.deepEqual(toDeviceKeys(sub), {
    endpoint: 'https://push.example/abc',
    p256dh: 'PKEY',
    auth: 'AKEY',
  })
})

test('toDeviceKeys returns null when a key is missing', () => {
  const noKeys = { endpoint: 'https://push.example/x', toJSON: () => ({}) }
  const halfKeys = {
    endpoint: 'https://push.example/y',
    toJSON: () => ({ keys: { p256dh: 'only-one' } }),
  }
  assert.equal(toDeviceKeys(noKeys), null)
  assert.equal(toDeviceKeys(halfKeys), null)
})

test('support detection is false off the main thread (no throw on import)', () => {
  assert.equal(PUSH_SUPPORTED, false)
  assert.equal(notificationPermission(), 'unsupported')
})
