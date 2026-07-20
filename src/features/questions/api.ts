import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Question } from '@/types'

export function useQuestions(tripId: string) {
  return useQuery({
    queryKey: ['questions', tripId],
    queryFn: async (): Promise<Question[]> => {
      const { data, error } = await supabase
        .from('questions')
        .select('*')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['questions', tripId] })
}

export function useCreateQuestion(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ title, body }: { title: string; body: string }) => {
      const { error } = await supabase.from('questions').insert({
        trip_id: tripId,
        member_id: memberId,
        title,
        body: body || null,
      })
      if (error) throw error
      logActivity(tripId, memberId, 'asked', title)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not post that question')),
  })
}

export function useAnswerQuestion(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({
      question,
      answer,
    }: {
      question: Question
      answer: string | null
    }) => {
      const { error } = await supabase
        .from('questions')
        .update({ answered: true, answer })
        .eq('id', question.id)
      if (error) throw error
      logActivity(tripId, memberId, 'answered', question.title)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save that answer')),
  })
}

export function useReopenQuestion(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('questions')
        .update({ answered: false })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not reopen that question')),
  })
}

export function useDeleteQuestion(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('questions').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that question')),
  })
}
