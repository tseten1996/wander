import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Note } from '@/types'

export function useNotes(tripId: string) {
  return useQuery({
    queryKey: ['notes', tripId],
    queryFn: async (): Promise<Note[]> => {
      const { data, error } = await supabase
        .from('notes')
        .select('*')
        .eq('trip_id', tripId)
        .order('pinned', { ascending: false })
        .order('updated_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['notes', tripId] })
}

export function useCreateNote(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ title, content }: { title: string; content: string }): Promise<Note> => {
      const { data, error } = await supabase
        .from('notes')
        .insert({ trip_id: tripId, created_by: memberId, title, content })
        .select()
        .single()
      if (error) throw error
      logActivity(tripId, memberId, 'created a note', title)
      return data
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not create that note')),
  })
}

export function useUpdateNote(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<Note> & { id: string }) => {
      const { error } = await supabase.from('notes').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save those changes')),
  })
}

export function useDeleteNote(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('notes').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that note')),
  })
}
