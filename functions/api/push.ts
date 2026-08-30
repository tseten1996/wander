/*
  The Web Push send path (#267) — the closed-app half of the notification inbox
  (#181/#182). A sibling of functions/api/ai.ts and the same shape: a thin
  Cloudflare Pages routing shell over platform-agnostic logic in src/server/.

  Unlike /api/ai, this endpoint holds a TRUE SECRET: the VAPID private key. It
  is the exact case guardrail #5 was amended (#191) to allow — a credential the
  browser must never see, living only in the Pages Function secret store
  (`wrangler pages secret put VAPID_PRIVATE`, production only). The public key
  ships in the bundle and is fine there; the private key never does.

  Trust model. This runs AS THE CALLER — it forwards the browser's Supabase JWT
  exactly like /api/ai — so it has no more database reach than the person who
  invoked it. Reaching a *recipient's* endpoint therefore goes through the two
  SECURITY DEFINER RPCs from the push_subscriptions migration, each of which
  hands out (or prunes) a target only under proof that the caller authored the
  very notification being delivered, and only within a 5-minute window. Endpoints
  never travel back to the browser: this function consumes them and returns only
  counts.

  Best-effort by contract (acceptance criteria): a failed or slow push must never
  matter to the caller — notify.ts has already written the inbox row and moved
  on. Every send is caught; the worst outcome is a push that did not go out.
*/
import { createClient } from '@supabase/supabase-js'
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '../../src/lib/supabase-public'
import { buildPushRequest } from '../../src/server/push/webpush'
import type { PushTarget, VapidKeys } from '../../src/server/push/webpush'
import { notificationDeepLink } from '../../src/features/notifications/route'
import type { NotificationType } from '../../src/types'

interface Env {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  /** Kill switch. Anything other than the exact string 'true' disables push. */
  PUSH_ENABLED?: string
  /** VAPID public key (base64url, uncompressed P-256 point) — public by design. */
  VAPID_PUBLIC?: string
  /** VAPID private key (base64url scalar) — a TRUE SECRET, secret store only. */
  VAPID_PRIVATE?: string
  /** RFC 8292 contact (`mailto:` or `https:`) sent in the VAPID JWT. */
  VAPID_SUBJECT?: string
}

interface PagesContext {
  request: Request
  env: Env
}

/** A row from push_targets_for_notifications — a device to deliver one event to. */
interface Target {
  subscription_id: string
  endpoint: string
  p256dh: string
  auth: string
  notification_id: string
  trip_id: string
  type: NotificationType
  title: string | null
  entity_id: string | null
}

/** Per-type push headline. The subject snapshot is the body; no actor, no PII
 *  beyond what the recipient can already see in their own inbox. */
const HEADLINE: Record<NotificationType, string> = {
  checklist_assigned: 'New task for you',
  poll_opened: 'New poll to vote on',
  expense_owed: 'A new expense you owe on',
  mention: 'You were mentioned',
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

const MAX_IDS = 100
const SEND_TIMEOUT_MS = 8000

export async function onRequestPost({ request, env }: PagesContext): Promise<Response> {
  // Two independent switches, like /api/ai: the flag says push is allowed here,
  // the keys say there is a credential to sign with. Missing either degrades to
  // a clean no-op rather than a 500 — the app stays fully functional unconfigured.
  const enabled = env.PUSH_ENABLED === 'true'
  const vapid: VapidKeys | null =
    env.VAPID_PUBLIC && env.VAPID_PRIVATE
      ? {
          publicKey: env.VAPID_PUBLIC,
          privateKey: env.VAPID_PRIVATE,
          subject: env.VAPID_SUBJECT || 'mailto:hello@wander.app',
        }
      : null
  if (!enabled || !vapid) return json({ ok: true, sent: 0, disabled: true }, 200)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, message: 'Expected a JSON body.' }, 400)
  }
  const rawIds = (body as { ids?: unknown })?.ids
  const ids = Array.isArray(rawIds) ? rawIds.filter(isUuid).slice(0, MAX_IDS) : []
  if (ids.length === 0) return json({ ok: true, sent: 0 }, 200)

  const db = createClient(env.SUPABASE_URL || PUBLIC_SUPABASE_URL, env.SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // RLS-gated by the caller's JWT; the definer RPC additionally proves the caller
  // authored each notification and it is recent.
  const { data, error } = await db.rpc('push_targets_for_notifications', { p_ids: ids })
  if (error || !Array.isArray(data)) return json({ ok: true, sent: 0 }, 200)
  const targets = data as Target[]

  let sent = 0
  let pruned = 0
  const deadSubscriptionIds = new Set<string>()

  await Promise.all(
    targets.map(async (t) => {
      const target: PushTarget = { endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth }
      const payload = JSON.stringify({
        title: HEADLINE[t.type] ?? 'Someone in your group needs you',
        body: t.title ?? '',
        url: notificationDeepLink(t.trip_id, t.type, t.notification_id),
        tag: `wander-${t.notification_id}`,
        notificationId: t.notification_id,
      })
      try {
        const req = await buildPushRequest(target, payload, vapid)
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })
        if (res.status === 404 || res.status === 410) {
          deadSubscriptionIds.add(t.subscription_id)
        } else if (res.ok) {
          sent++
        }
      } catch {
        // Best-effort: a thrown send (timeout, DNS, offline edge) is a push that
        // did not go out, nothing more. The inbox row already stands.
      }
    }),
  )

  // Prune endpoints the push service has retired (unsubscribed/expired). The RPC
  // re-checks the caller-authored, recent proof, so this cannot delete an
  // arbitrary member's subscription.
  await Promise.all(
    [...deadSubscriptionIds].map(async (id) => {
      const { error: pruneError } = await db.rpc('prune_push_subscription', {
        p_subscription_id: id,
      })
      if (!pruneError) pruned++
    }),
  )

  return json({ ok: true, sent, pruned }, 200)
}
