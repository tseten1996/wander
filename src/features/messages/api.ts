import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { extractMentionIds, mentionsToPlainText } from './mentions'
import type { Message, MessageReaction } from '@/types'

export type MessageWithReactions = Message & { message_reactions: MessageReaction[] }

/** Cap the mention notification's title snapshot so a long message doesn't
 *  bloat the inbox row. */
const MENTION_TITLE_MAX = 140

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
      return data as MessageWithReactions[]
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
    mutationFn: async ({ content, replyTo }: { content: string; replyTo: string | null }) => {
      const { data, error } = await supabase
        .from('messages')
        .insert({
          trip_id: tripId,
          member_id: memberId,
          content,
          reply_to: replyTo,
        })
        .select('id')
        .single()
      if (error) throw error
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
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('messages').delete().eq('id', id)
      if (error) throw error
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
  const invalidate = useInvalidateMessages(tripId)
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
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not react to that message')),
  })
}
