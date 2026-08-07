import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
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
