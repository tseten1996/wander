/*
  Web Push, from scratch, on Web Crypto only — no dependency, no Node built-in.

  This is the one genuinely cryptographic file in Wander, and it lives here (not
  in functions/) for the same reason the AI rules live in src/server/ai/: the
  Cloudflare handler stays a thin shell, and the Node test runner can exercise
  this with `globalThis.crypto` without a Workers environment. Everything below
  uses only APIs that exist identically in the browser, in Node ≥ 20, and in the
  Workers runtime: `crypto.subtle`, `TextEncoder`, `Uint8Array`, `DataView`.

  It implements two specs:
    * RFC 8292 — VAPID: an ES256 JWT that identifies this application server to
      the push service, so a subscription pinned to our public key (via
      `applicationServerKey`) accepts our sends and nobody else's.
    * RFC 8291 — Message Encryption (`aes128gcm`): the payload is encrypted to
      the subscription's own P-256 key so only that device can read it. The push
      service forwards ciphertext it cannot decrypt.

  The functions are pure and injectable (the ephemeral key and salt can be
  supplied) precisely so the encryption can be round-tripped in a unit test
  against an independent RFC 8291 receiver — the hermetic proof that stands in
  for a live push the sandbox cannot make.
*/

/** A browser PushSubscription's transport fields, as stored in the table. */
export interface PushTarget {
  endpoint: string
  /** Subscription public key, base64url (uncompressed P-256 point, 65 bytes). */
  p256dh: string
  /** Subscription auth secret, base64url (16 bytes). */
  auth: string
}

export interface VapidKeys {
  /** base64url, uncompressed P-256 point (65 bytes) — public by design. */
  publicKey: string
  /** base64url, the 32-byte scalar `d` — a TRUE secret, server store only. */
  privateKey: string
  /** `mailto:` or `https:` contact, per RFC 8292 §2.1. */
  subject: string
}

// ── base64url ────────────────────────────────────────────────────────────────

const B64URL = /[+/]/g
const B64URL_BACK = /[-_]/g

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(B64URL, (c) => (c === '+' ? '-' : '_')).replace(/=+$/, '')
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(B64URL_BACK, (c) => (c === '-' ? '+' : '/'))
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ── HKDF (RFC 5869), extract+expand in one Web Crypto call ────────────────────

/** HKDF-SHA-256(salt, ikm, info, length). Exported for its own unit vector. */
export async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bufOf(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bufOf(salt), info: bufOf(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

// A fresh ArrayBuffer view so Web Crypto never sees a SharedArrayBuffer-backed
// or offset typed array (some runtimes reject those as BufferSource).
function bufOf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

// ── RFC 8291 payload encryption (aes128gcm) ───────────────────────────────────

const KEY_LABEL = utf8('WebPush: info\0')
const CEK_INFO = utf8('Content-Encoding: aes128gcm\0')
const NONCE_INFO = utf8('Content-Encoding: nonce\0')
const RECORD_SIZE = 4096

export interface EncryptResult {
  body: Uint8Array<ArrayBuffer>
  /** The ephemeral server public key used (raw, 65 bytes) — exposed for tests. */
  serverPublicKey: Uint8Array
  salt: Uint8Array
}

/**
 * Encrypt `plaintext` for a subscription per RFC 8291. `serverKeyPair` and
 * `salt` default to fresh random values; a test may inject fixed ones.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  target: PushTarget,
  serverKeyPair?: CryptoKeyPair,
  salt?: Uint8Array,
): Promise<EncryptResult> {
  const uaPublic = base64UrlToBytes(target.p256dh)
  const authSecret = base64UrlToBytes(target.auth)
  const recordSalt = salt ?? crypto.getRandomValues(new Uint8Array(16))

  const keyPair =
    serverKeyPair ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))

  const uaKey = await crypto.subtle.importKey(
    'raw',
    bufOf(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, keyPair.privateKey, 256),
  )

  // The combined IKM (RFC 8291 §3.4): keyed by the auth secret, contextualised
  // by both public keys so the derived key is bound to this exact pair.
  const ikm = await hkdf(authSecret, ecdh, concat(KEY_LABEL, uaPublic, serverPublic), 32)
  // CEK/NONCE (RFC 8188): keyed by the record salt over that IKM.
  const cek = await hkdf(recordSalt, ikm, CEK_INFO, 16)
  const nonce = await hkdf(recordSalt, ikm, NONCE_INFO, 12)

  const aesKey = await crypto.subtle.importKey('raw', bufOf(cek), { name: 'AES-GCM' }, false, [
    'encrypt',
  ])
  // Single, final record: content is `plaintext || 0x02` (the last-record
  // delimiter), no further padding.
  const padded = concat(plaintext, Uint8Array.of(0x02))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bufOf(nonce), tagLength: 128 },
      aesKey,
      bufOf(padded),
    ),
  )

  // aes128gcm header (RFC 8188 §2.1): salt(16) | rs(4, BE) | idlen(1) | keyid.
  const header = new Uint8Array(16 + 4 + 1 + serverPublic.length)
  header.set(recordSalt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = serverPublic.length
  header.set(serverPublic, 21)

  return { body: concat(header, ciphertext), serverPublicKey: serverPublic, salt: recordSalt }
}

// ── RFC 8292 VAPID JWT ────────────────────────────────────────────────────────

/** Import a VAPID keypair (public raw point + private scalar) for ES256 signing. */
async function importVapidSigningKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = base64UrlToBytes(publicKey) // 0x04 || X(32) || Y(32)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be an uncompressed P-256 point (65 bytes)')
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(pub.slice(1, 33)),
    y: bytesToBase64Url(pub.slice(33, 65)),
    d: privateKey,
    ext: true,
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

/**
 * Build the `Authorization: vapid …` header value for a send to `endpoint`.
 * The JWT's audience is the push service origin (RFC 8292 §2), and `exp` is
 * capped well under the 24h ceiling.
 */
export async function buildVapidHeader(
  endpoint: string,
  keys: VapidKeys,
  now: number = Date.now(),
): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = bytesToBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = bytesToBase64Url(
    utf8(
      JSON.stringify({
        aud,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  )
  const signingInput = `${header}.${claims}`
  const signKey = await importVapidSigningKey(keys.publicKey, keys.privateKey)
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, bufOf(utf8(signingInput))),
  )
  const jwt = `${signingInput}.${bytesToBase64Url(sig)}`
  return `vapid t=${jwt}, k=${keys.publicKey}`
}

// ── Request assembly ──────────────────────────────────────────────────────────

export interface PushRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer>
}

/**
 * Everything needed to `fetch()` one Web Push. `ttlSeconds` is how long the push
 * service may hold the message for an offline device before dropping it.
 */
export async function buildPushRequest(
  target: PushTarget,
  payload: string,
  keys: VapidKeys,
  opts: { ttlSeconds?: number; now?: number } = {},
): Promise<PushRequest> {
  const { body } = await encryptPayload(utf8(payload), target)
  const authorization = await buildVapidHeader(target.endpoint, keys, opts.now)
  return {
    url: target.endpoint,
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlSeconds ?? 12 * 60 * 60),
      Urgency: 'normal',
    },
    body,
  }
}
