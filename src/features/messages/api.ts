import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { extractMentionIds, mentionsToPlainText } from './mentions'
import type { Message, MessageReaction } from '@/types'

export type MessageWithReactions = Message & {
  message_reactions: MessageReaction[]
  /** A short-lived signed read URL for an image message (#51), resolved by
   *  `useMessages`. Undefined for text messages; null if signing failed. */
  image_url?: string | null
}

/** Cap the mention notification's title snapshot so a long message doesn't
 *  bloat the inbox row. */
const MENTION_TITLE_MAX = 140

// ── Chat images (#51) ───────────────────────────────────────────────────────
// A private Storage bucket, scoped to trip members by RLS (see the matching
// migration). Objects are keyed `<trip_id>/<uuid>.<ext>` so the first path
// segment is the trip id the storage policies check.
export const CHAT_IMAGES_BUCKET = 'chat-images'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// Mirrors the bucket's server-side allowlist (see the migration). The ext for
// the object key is just the MIME subtype (`image/png` → `png`).
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Signed URLs are minted for an hour; a page refetch renews them well inside
 *  that, so an image never blanks out mid-session. */
const SIGNED_URL_TTL_SECONDS = 60 * 60

/** Reject a non-image or oversized file up front. Returns an error string for a
 *  toast, or null when the file is acceptable. */
export function validateChatImage(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return 'That file isn’t a supported image (PNG, JPEG, GIF, or WebP).'
  if (file.size > MAX_IMAGE_BYTES) return 'That image is over 5 MB — please pick a smaller one.'
  return null
}

export function useMessages(tripId: string) {
  return useQuery({
    queryKey: ['messages', tripId],
    queryFn: async (): Promise<MessageWithReactions[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select('*, message_reactions(*)')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: true })
        .limit(300)
      if (error) throw error
      const rows = data as MessageWithReactions[]
      // The bucket is private, so an image is readable only through a short-lived
      // signed URL that the SELECT policy gates on membership. Mint them for
      // every image message on this page in one round-trip and attach them, so
      // the feature's Supabase access stays inside this one query.
      const paths = [...new Set(rows.map((m) => m.image_path).filter((p): p is string => !!p))]
      if (paths.length > 0) {
        // A signing failure must degrade to "image unavailable", never break the
        // whole thread — so it's caught, not thrown out of the query.
        try {
          const { data: signed } = await supabase.storage
            .from(CHAT_IMAGES_BUCKET)
            .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
          const urls = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
          for (const m of rows) if (m.image_path) m.image_url = urls.get(m.image_path) ?? null
        } catch {
          /* leave image_url unset → the bubble shows the unavailable fallback */
        }
      }
      return rows
    },
  })
}

function useInvalidateMessages(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['messages', tripId] })
}

export function useSendMessage(tripId: string, memberId: string) {
  const invalidate = useInvalidateMessages(tripId)
  return useMutation({
    mutationFn: async ({
      content,
      replyTo,
      image,
    }: {
      content: string
      replyTo: string | null
      image?: File | null
    }) => {
      // Upload first so the message row only ever references an object that
      // exists. The path's first segment is the trip id the storage RLS checks.
      let imagePath: string | null = null
      if (image) {
        const ext = image.type.split('/')[1] ?? 'bin'
        imagePath = `${tripId}/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from(CHAT_IMAGES_BUCKET)
          .upload(imagePath, image, { contentType: image.type, upsert: false })
        if (uploadError) throw uploadError
      }
      const { data, error } = await supabase
        .from('messages')
        .insert({
          trip_id: tripId,
          member_id: memberId,
          content,
          reply_to: replyTo,
          image_path: imagePath,
        })
        .select('id')
        .single()
      if (error) {
        // The insert failed after the upload succeeded — remove the now-orphan
        // object (best effort) so a retry doesn't leave storage littered.
        if (imagePath) {
          await supabase.storage.from(CHAT_IMAGES_BUCKET).remove([imagePath]).catch(() => {})
        }
        throw error
      }
      // Ping every member @-mentioned in the message (#193). notify() drops the
      // sender and duplicates, so a self-mention or repeated mention is a no-op.
      const mentioned = extractMentionIds(content)
      if (mentioned.length > 0) {
        const plain = mentionsToPlainText(content)
        notify({
          tripId,
          actorId: memberId,
          recipientIds: mentioned,
          type: 'mention',
          entityId: data.id,
          title:
            plain.length > MENTION_TITLE_MAX ? `${plain.slice(0, MENTION_TITLE_MAX - 1)}…` : plain,
        })
      }
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not send that message')),
  })
}

export function useEditMessage(tripId: string) {
  const invalidate = useInvalidateMessages(tripId)
  return useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      const { error } = await supabase
        .from('messages')
        .update({ content, edited_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that edit')),
  })
}

export function useDeleteMessage(tripId: string) {
  const invalidate = useInvalidateMessages(tripId)
  return useMutation({
    mutationFn: async ({ id, imagePath }: { id: string; imagePath?: string | null }) => {
      const { error } = await supabase.from('messages').delete().eq('id', id)
      if (error) throw error
      // Delete the row first (that's the visible action); then clean up its
      // image object best-effort so a Storage hiccup never blocks the delete.
      if (imagePath) {
        await supabase.storage.from(CHAT_IMAGES_BUCKET).remove([imagePath]).catch(() => {})
      }
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that message')),
  })
}

export function useSetPinned(tripId: string) {
  const invalidate = useInvalidateMessages(tripId)
  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const { error } = await supabase.from('messages').update({ pinned }).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not update that message')),
  })
}

export function useToggleReaction(tripId: string, memberId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      message,
      emoji,
    }: {
      message: MessageWithReactions
      emoji: string
    }) => {
      const mine = message.message_reactions.find(
        (r) => r.member_id === memberId && r.emoji === emoji
      )
      if (mine) {
        const { error } = await supabase.from('message_reactions').delete().eq('id', mine.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('message_reactions').insert({
          trip_id: tripId,
          message_id: message.id,
          member_id: memberId,
          emoji,
        })
        if (error) throw error
      }
    },
    // Optimistic toggle — a reaction is a core collaborative tap and must land
    // instantly (#269). Realtime + the settle invalidation reconcile the true
    // rows (real id, other members' reactions).
    onMutate: async ({ message, emoji }) => {
      await queryClient.cancelQueries({ queryKey: ['messages', tripId] })
      const previous = queryClient.getQueryData<MessageWithReactions[]>(['messages', tripId])
      queryClient.setQueryData<MessageWithReactions[]>(['messages', tripId], (old) =>
        (old ?? []).map((m) => {
          if (m.id !== message.id) return m
          const mine = m.message_reactions.find(
            (r) => r.member_id === memberId && r.emoji === emoji
          )
          if (mine) {
            return {
              ...m,
              message_reactions: m.message_reactions.filter((r) => r.id !== mine.id),
            }
          }
          const optimistic: MessageReaction = {
            id: `optimistic-${crypto.randomUUID()}`,
            trip_id: tripId,
            message_id: m.id,
            member_id: memberId,
            emoji,
          }
          return { ...m, message_reactions: [...m.message_reactions, optimistic] }
        })
      )
      return { previous }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['messages', tripId], ctx.previous)
      toast.error(friendlyError(err, 'Could not react to that message'))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['messages', tripId] }),
  })
}
