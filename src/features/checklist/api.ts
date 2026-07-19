import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import type { ChecklistItem } from '@/types'

export function useChecklist(tripId: string) {
  return useQuery({
    queryKey: ['checklist_items', tripId],
    queryFn: async (): Promise<ChecklistItem[]> => {
      const { data, error } = await supabase
        .from('checklist_items')
        .select('*')
        .eq('trip_id', tripId)
        .order('position')
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['checklist_items', tripId] })
}

export interface ChecklistInput {
  title: string
  notes?: string | null
  assignee_id?: string | null
  due_date?: string | null
}

export function useCreateChecklistItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: ChecklistInput) => {
      const { error } = await supabase.from('checklist_items').insert({
        trip_id: tripId,
        created_by: memberId,
        title: input.title,
        notes: input.notes || null,
        assignee_id: input.assignee_id || null,
        due_date: input.due_date || null,
        position: Date.now(), // append at the end; stable and monotonic
      })
      if (error) throw error
      logActivity(tripId, memberId, 'added a task', input.title)
    },
    onSuccess: invalidate,
  })
}

export function useUpdateChecklistItem(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<ChecklistItem> & { id: string }) => {
      const { error } = await supabase.from('checklist_items').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}

export function useToggleDone(tripId: string, memberId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (item: ChecklistItem) => {
      const { error } = await supabase
        .from('checklist_items')
        .update({ done: !item.done })
        .eq('id', item.id)
      if (error) throw error
      if (!item.done) logActivity(tripId, memberId, 'completed', item.title)
    },
    // Optimistic toggle — checkboxes must feel instant
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: ['checklist_items', tripId] })
      const previous = queryClient.getQueryData<ChecklistItem[]>(['checklist_items', tripId])
      queryClient.setQueryData<ChecklistItem[]>(['checklist_items', tripId], (old) =>
        (old ?? []).map((i) => (i.id === item.id ? { ...i, done: !i.done } : i))
      )
      return { previous }
    },
    onError: (_err, _item, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['checklist_items', tripId], ctx.previous)
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['checklist_items', tripId] }),
  })
}

export function useDeleteChecklistItem(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('checklist_items').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
  })
}
