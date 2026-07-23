import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Poll, PollCategory, PollOption, Vote } from '@/types'

export type PollWithVotes = Poll & { poll_options: PollOption[]; votes: Vote[] }

export function usePolls(tripId: string) {
  return useQuery({
    queryKey: ['polls', tripId],
    queryFn: async (): Promise<PollWithVotes[]> => {
      const { data, error } = await supabase
        .from('polls')
        .select('*, poll_options(*), votes(*)')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data as PollWithVotes[]).map((p) => ({
        ...p,
        poll_options: [...p.poll_options].sort((a, b) => a.position - b.position),
      }))
    },
  })
}

function useInvalidatePolls(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['polls', tripId] })
}

export function useCreatePoll(tripId: string, memberId: string) {
  const invalidate = useInvalidatePolls(tripId)
  return useMutation({
    mutationFn: async (input: {
      question: string
      category: PollCategory
      closes_at: string | null
      options: { label: string; image_url: string | null; link_url: string | null }[]
    }) => {
      const { data: poll, error } = await supabase
        .from('polls')
        .insert({
          trip_id: tripId,
          created_by: memberId,
          question: input.question,
          category: input.category,
          closes_at: input.closes_at,
        })
        .select()
        .single()
      if (error) throw error
      const { error: optError } = await supabase.from('poll_options').insert(
        input.options.map((option, position) => ({
          trip_id: tripId,
          poll_id: poll.id,
          label: option.label,
          position,
          image_url: option.image_url,
          link_url: option.link_url,
        }))
      )
      if (optError) throw optError
      logActivity(tripId, memberId, 'created a poll', input.question)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not create that poll')),
  })
}

export function useVote(tripId: string, memberId: string) {
  const invalidate = useInvalidatePolls(tripId)
  return useMutation({
    mutationFn: async ({ poll, optionId }: { poll: PollWithVotes; optionId: string }) => {
      const existing = poll.votes.find((v) => v.member_id === memberId)
      if (existing?.option_id === optionId) {
        // tapping your current choice removes the vote
        const { error } = await supabase.from('votes').delete().eq('id', existing.id)
        if (error) throw error
        return
      }
      const { error } = await supabase.from('votes').upsert(
        {
          trip_id: tripId,
          poll_id: poll.id,
          option_id: optionId,
          member_id: memberId,
        },
        { onConflict: 'poll_id,member_id' }
      )
      if (error) throw error
      if (!existing) logActivity(tripId, memberId, 'voted on', poll.question)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not record your vote')),
  })
}

export function useSetPollClosed(tripId: string, memberId: string) {
  const invalidate = useInvalidatePolls(tripId)
  return useMutation({
    mutationFn: async ({ poll, closed }: { poll: Poll; closed: boolean }) => {
      const { error } = await supabase.from('polls').update({ closed }).eq('id', poll.id)
      if (error) throw error
      if (closed) logActivity(tripId, memberId, 'closed the poll', poll.question)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not update that poll')),
  })
}

export function useDeletePoll(tripId: string) {
  const invalidate = useInvalidatePolls(tripId)
  return useMutation({
    mutationFn: async (pollId: string) => {
      const { error } = await supabase.from('polls').delete().eq('id', pollId)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that poll')),
  })
}

export function isPollOpen(poll: Pick<Poll, 'closed' | 'closes_at'>): boolean {
  if (poll.closed) return false
  if (poll.closes_at && new Date(poll.closes_at) < new Date()) return false
  return true
}
