import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Message, MessageReaction } from '@/types'

export type MessageWithReactions = Message & { message_reactions: MessageReaction[] }

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
      const { error } = await supabase.from('messages').insert({
        trip_id: tripId,
        member_id: memberId,
        content,
        reply_to: replyTo,
      })
      if (error) throw error
    },
    onSuccess: invalidate,
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
  })
}
