import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type { Note } from '@/types'

/**
 * Raised when a guarded note save finds the row changed since the editor
 * opened it (optimistic concurrency, keyed on `updated_at`). Carries the
 * server's current row so the editor can offer a reload. The dialog handles
 * this case itself, so `useUpdateNote`'s onError skips the generic toast.
 */
export class NoteConflictError extends Error {
  latest: Note
  constructor(latest: Note) {
    super('This note changed while you were editing.')
    this.name = 'NoteConflictError'
    this.latest = latest
  }
}

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
    mutationFn: async ({
      id,
      expectedUpdatedAt,
      ...patch
    }: Partial<Note> & { id: string; expectedUpdatedAt?: string }) => {
      // Optimistic-concurrency guard (#272): when the caller passes the
      // `updated_at` the editor opened with, scope the write to that version.
      // If nobody else has saved in between, exactly one row matches and the
      // trigger bumps `updated_at`; if the row moved, zero rows match — the
      // second saver would otherwise silently clobber the first, so surface a
      // conflict with the current row instead of overwriting.
      if (expectedUpdatedAt !== undefined) {
        const { data, error } = await supabase
          .from('notes')
          .update(patch)
          .eq('id', id)
          .eq('updated_at', expectedUpdatedAt)
          .select()
        if (error) throw error
        if (!data || data.length === 0) {
          const { data: latest, error: fetchError } = await supabase
            .from('notes')
            .select('*')
            .eq('id', id)
            .single()
          if (fetchError) throw fetchError
          throw new NoteConflictError(latest)
        }
        return
      }
      // Unguarded write: pin toggles and a deliberate "keep mine" overwrite.
      const { error } = await supabase.from('notes').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => {
      // A conflict is handled by the editor (reload / keep mine), not a toast.
      if (err instanceof NoteConflictError) return
      toast.error(friendlyError(err, 'Could not save those changes'))
    },
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
