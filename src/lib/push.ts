/*
  Web Push subscription lifecycle (#267, epic #181 closed-app slice).

  This module owns the *browser* side of push: feature detection, turning a
  VAPID public key into a subscription, and reading/removing the device's
  subscription. It deliberately holds no server logic and no secret — the VAPID
  *private* key that signs an actual push never touches the client (guardrail
  #5); that lives in the server send path, a separate slice.

  It is also import-time pure and env-free on purpose: the VAPID public key is
  passed in by the caller (from src/lib/config.ts) rather than read here, so the
  pure helpers below can be unit-tested under `node --test` without a Vite env.
  Every browser API is behind a `typeof`/support guard, so importing this in a
  non-DOM context (a test, SSR) evaluates without throwing.
*/

/** The device's subscription details, shaped for the `push_subscriptions` row. */
export interface PushDeviceKeys {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * True when this browser can do Web Push at all: a service worker to receive
 * it, a PushManager to subscribe, and the Notification API `userVisibleOnly`
 * requires. Guarded so it is simply `false` off the main thread rather than a
 * throw. Note this is capability, not permission — a supported browser may
 * still have notifications denied (see {@link notificationPermission}).
 */
export const PUSH_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** The current notification permission, or 'unsupported' where there is none. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!PUSH_SUPPORTED) return 'unsupported'
  return Notification.permission
}

/**
 * Decode a base64url VAPID public key into the `Uint8Array`
 * `PushManager.subscribe` wants as its `applicationServerKey`.
 *
 * Pure and dependency-free (this is the unit-tested core): base64url → base64
 * (URL-safe chars restored, padded to a multiple of 4), then `atob` to raw
 * bytes. Throws on input that is not decodable, so a malformed key fails loudly
 * at subscribe time rather than handing the push service garbage.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

/**
 * Serialize a browser `PushSubscription` into the fields the table stores.
 * Returns null if either key is absent (a subscription with no keys cannot be
 * pushed to, so it is not worth persisting). Pure — split out for testing.
 */
export function toDeviceKeys(sub: {
  endpoint: string
  toJSON(): { keys?: { p256dh?: string; auth?: string } }
}): PushDeviceKeys | null {
  const keys = sub.toJSON().keys
  if (!keys?.p256dh || !keys?.auth) return null
  return { endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth }
}

/** The active service worker registration, or null when unavailable. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!PUSH_SUPPORTED) return null
  try {
    return (await navigator.serviceWorker.ready) ?? null
  } catch {
    return null
  }
}

/** This device's current push subscription, or null if not subscribed. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  const reg = await registration()
  if (!reg) return null
  try {
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

/**
 * Subscribe this device to push and return the row fields to persist. Requests
 * notification permission if not yet granted; throws if the browser is
 * unsupported, permission is denied, or the subscription yields no keys — the
 * caller surfaces that as a friendly toast and the app carries on unchanged.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushDeviceKeys> {
  const reg = await registration()
  if (!reg) throw new Error('Push notifications are not supported on this device.')
  if (!vapidPublicKey) throw new Error('Push notifications are not configured.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked — enable them in your browser settings.')
  }

  // Reuse an existing subscription when present (idempotent re-opt-in), else
  // create one bound to our VAPID key. `userVisibleOnly` is mandatory: every
  // push must show the user a notification.
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }))

  const keys = toDeviceKeys(sub)
  if (!keys) throw new Error('This device could not produce a push subscription.')
  return keys
}

/**
 * Unsubscribe this device from push. Returns the endpoint that was removed (so
 * the caller can prune its stored row), or null if there was nothing to remove.
 * Never throws — opting out must always succeed from the user's point of view.
 */
export async function unsubscribeFromPush(): Promise<string | null> {
  const sub = await getExistingSubscription()
  if (!sub) return null
  const endpoint = sub.endpoint
  try {
    await sub.unsubscribe()
  } catch {
    // The browser subscription may already be gone; the caller still prunes the
    // stored row by the endpoint we captured.
  }
  return endpoint
}
