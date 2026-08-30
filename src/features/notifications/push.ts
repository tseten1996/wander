/*
  Client side of Web Push (#267): turning the browser's PushManager subscription
  into a row the send path can reach, and back off again.

  Everything here is a no-op unless BOTH are true: this deployment shipped a
  VAPID public key (`VITE_VAPID_PUBLIC`) and this browser supports Web Push. When
  either is false the opt-in never renders, so an unconfigured build behaves
  exactly as it did before this feature — no permission prompts, no new network.

  The public key is public by design (it is the `applicationServerKey` the push
  service uses to accept only this deployment's sends); the matching private key
  is a true secret that lives only in the Pages Function store and never here.
*/
import { supabase } from '@/lib/supabase'

const VAPID_PUBLIC = ((import.meta.env.VITE_VAPID_PUBLIC as string | undefined) ?? '').trim()

/** Whether a VAPID public key is wired in — without it there is nothing to
 *  subscribe against, so the opt-in stays hidden. */
export function pushConfigured(): boolean {
  return VAPID_PUBLIC.length > 0
}

/** Whether this browser can do Web Push at all. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** The opt-in is offered only when the deployment AND the browser both allow it. */
export function pushAvailable(): boolean {
  return pushConfigured() && pushSupported()
}

/** base64url VAPID key → the byte array PushManager.subscribe expects. Backed by
 *  a plain ArrayBuffer so it satisfies the BufferSource the DOM types require. */
function applicationServerKey(): Uint8Array<ArrayBuffer> {
  const b64 = VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function readySW(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await readySW()
  return reg.pushManager.getSubscription()
}

interface SubKeys {
  endpoint: string
  p256dh: string
  auth: string
}

function subKeys(sub: PushSubscription): SubKeys {
  const json = sub.toJSON()
  return {
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  }
}

export type EnableResult = 'granted' | 'denied' | 'unsupported'

/**
 * Request permission, subscribe this device, and record it for this member.
 *
 * The row is written *as the member for themselves* — the only write RLS allows
 * on push_subscriptions — and upserted on (member_id, endpoint) so re-enabling
 * on the same device refreshes rather than duplicates.
 */
export async function enablePush(tripId: string, memberId: string): Promise<EnableResult> {
  if (!pushAvailable()) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const reg = await readySW()
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(),
    })
  }

  const keys = subKeys(sub)
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      trip_id: tripId,
      member_id: memberId,
      endpoint: keys.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'member_id,endpoint' },
  )
  if (error) throw error
  return 'granted'
}

/** Unsubscribe this device and delete the member's stored row(s) for it. */
export async function disablePush(tripId: string, memberId: string): Promise<void> {
  const sub = await currentSubscription()
  const del = supabase.from('push_subscriptions').delete().eq('trip_id', tripId).eq('member_id', memberId)
  if (sub) {
    const endpoint = sub.endpoint
    try {
      await sub.unsubscribe()
    } catch {
      // A failed unsubscribe still means the user opted out — drop the row so
      // no further pushes are addressed to it.
    }
    const { error } = await del.eq('endpoint', endpoint)
    if (error) throw error
  } else {
    // No live subscription: clear any stray rows this member left on this trip.
    const { error } = await del
    if (error) throw error
  }
}

/** Whether this browser's live subscription is the one recorded for this member. */
export async function isSubscribedHere(tripId: string, memberId: string): Promise<boolean> {
  const sub = await currentSubscription()
  if (!sub) return false
  const { data } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('trip_id', tripId)
    .eq('member_id', memberId)
    .eq('endpoint', sub.endpoint)
    .limit(1)
  return !!data && data.length > 0
}
