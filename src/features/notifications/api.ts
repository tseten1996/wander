import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { VAPID_PUBLIC_KEY } from '@/lib/config'
import {
  PUSH_SUPPORTED,
  getExistingSubscription,
  notificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push'
import type { Notification } from '@/types'

/** Newest slice of the personal inbox — plenty for a badge + dropdown. */
const INBOX_LIMIT = 50

/**
 * The signed-in member's own notifications for this trip, newest first. RLS
 * already restricts rows to the recipient; the explicit `recipient_id` filter
 * keeps the query honest and its result stable regardless of policy changes.
 * Keyed `[table, tripId]` like every other feature query, so the per-trip
 * realtime channel invalidates it on any change to a row addressed to me.
 */
export function useNotifications(tripId: string, meId: string) {
  return useQuery({
    queryKey: ['notifications', tripId],
    queryFn: async (): Promise<Notification[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('trip_id', tripId)
        .eq('recipient_id', meId)
        .order('created_at', { ascending: false })
        .limit(INBOX_LIMIT)
      if (error) throw error
      return data
    },
  })
}

/** Count of unread items — what the header badge shows. */
export function unreadCount(items: Notification[] | undefined): number {
  return (items ?? []).filter((n) => !n.read_at).length
}

/** Mark a single notification read (optimistic — tapping it feels instant). */
export function useMarkNotificationRead(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .is('read_at', null)
      if (error) throw error
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['notifications', tripId] })
      const previous = queryClient.getQueryData<Notification[]>(['notifications', tripId])
      const now = new Date().toISOString()
      queryClient.setQueryData<Notification[]>(['notifications', tripId], (old) =>
        (old ?? []).map((n) => (n.id === id && !n.read_at ? { ...n, read_at: now } : n))
      )
      return { previous }
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['notifications', tripId], ctx.previous)
      toast.error(friendlyError(err, 'Could not mark that as read'))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notifications', tripId] }),
  })
}

/** Mark every unread notification read in one shot. */
export function useMarkAllNotificationsRead(tripId: string, meId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('trip_id', tripId)
        .eq('recipient_id', meId)
        .is('read_at', null)
      if (error) throw error
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['notifications', tripId] })
      const previous = queryClient.getQueryData<Notification[]>(['notifications', tripId])
      const now = new Date().toISOString()
      queryClient.setQueryData<Notification[]>(['notifications', tripId], (old) =>
        (old ?? []).map((n) => (n.read_at ? n : { ...n, read_at: now }))
      )
      return { previous }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['notifications', tripId], ctx.previous)
      toast.error(friendlyError(err, 'Could not mark all as read'))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notifications', tripId] }),
  })
}

// ── Web Push opt-in (#267, epic #181 closed-app slice) ──────────────────────
// The device side of "notify me when the app's closed". The subscription
// itself is browser state; these hooks mirror it into the trip-scoped
// `push_subscriptions` table (RLS pins every row to the caller) so a later
// slice's send path can fan out to a member's devices. All of it stays dark
// until a deployment sets a VAPID public key — see src/lib/config.ts.

/** Whether this device can even offer push here, and its current opt-in state. */
export interface PushDeviceState {
  /** Browser can do Web Push (service worker + PushManager + Notification). */
  supported: boolean
  /** A VAPID public key is configured for this deployment. */
  configured: boolean
  /** OS/browser notification permission. */
  permission: NotificationPermission | 'unsupported'
  /** This device currently holds an active push subscription. */
  subscribed: boolean
}

/** The opt-in surface should render at all only when push is buildable here. */
export const PUSH_AVAILABLE = PUSH_SUPPORTED && !!VAPID_PUBLIC_KEY

/**
 * This device's push state, keyed per trip like every other feature query.
 * Reads the browser subscription locally (no network) — the browser is the
 * source of truth for "is this device subscribed"; the stored row is the send
 * path's copy, reconciled there.
 */
export function usePushDeviceState(tripId: string) {
  return useQuery({
    queryKey: ['push_subscription', tripId],
    queryFn: async (): Promise<PushDeviceState> => {
      const sub = PUSH_AVAILABLE ? await getExistingSubscription() : null
      return {
        supported: PUSH_SUPPORTED,
        configured: !!VAPID_PUBLIC_KEY,
        permission: notificationPermission(),
        subscribed: !!sub,
      }
    },
    // No point querying device state where the surface will never render.
    enabled: PUSH_AVAILABLE,
    // Permission/subscription can change outside React (browser settings); a
    // short staleness keeps the toggle honest without polling.
    staleTime: 30_000,
  })
}

/** Opt this device in: subscribe in the browser, then persist the row. */
export function usePushOptIn(tripId: string, meId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const keys = await subscribeToPush(VAPID_PUBLIC_KEY)
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          trip_id: tripId,
          member_id: meId,
          endpoint: keys.endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'member_id,endpoint' }
      )
      if (error) throw error
    },
    onSuccess: () => toast.success('You’ll be notified when the app is closed.'),
    onError: (err) =>
      toast.error(friendlyError(err, 'Could not turn on notifications')),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['push_subscription', tripId] }),
  })
}

/** Opt this device out: drop the browser subscription and prune its row. */
export function usePushOptOut(tripId: string, meId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeFromPush()
      // Prune the stored row for this exact device. Scoped to me + endpoint so a
      // shared browser never removes another member's subscription; RLS is the
      // backstop.
      if (endpoint) {
        const { error } = await supabase
          .from('push_subscriptions')
          .delete()
          .eq('member_id', meId)
          .eq('endpoint', endpoint)
        if (error) throw error
      }
    },
    onError: (err) =>
      toast.error(friendlyError(err, 'Could not turn off notifications')),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['push_subscription', tripId] }),
  })
}
