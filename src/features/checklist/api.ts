import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { notify } from '@/lib/notify'
import { friendlyError } from '@/lib/errors'
import type { ChecklistItem } from '@/types'

/** The trip's checklist rows, position- then age-ordered. Exported as a plain
 *  function (not just the hook) so the global search palette can warm this same
 *  cache key without touching Supabase itself — this api.ts stays the only place
 *  that reads the table. */
export async function fetchChecklist(tripId: string): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from('checklist_items')
    .select('*')
    .eq('trip_id', tripId)
    .order('position')
    .order('created_at')
  if (error) throw error
  return data
}

export function useChecklist(tripId: string) {
  return useQuery({
    queryKey: ['checklist_items', tripId],
    queryFn: () => fetchChecklist(tripId),
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
      const { data, error } = await supabase
        .from('checklist_items')
        .insert({
          trip_id: tripId,
          created_by: memberId,
          title: input.title,
          notes: input.notes || null,
          assignee_id: input.assignee_id || null,
          due_date: input.due_date || null,
          position: Date.now(), // append at the end; stable and monotonic
        })
        .select('id')
        .single()
      if (error) throw error
      logActivity(tripId, memberId, 'added a task', input.title)
      // Tell the assignee they've been given something to do (#182).
      notify({
        tripId,
        actorId: memberId,
        recipientIds: [input.assignee_id],
        type: 'checklist_assigned',
        entityId: data.id,
        title: input.title,
      })
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not add that task')),
  })
}

/**
 * `prevAssigneeId` is the item's assignee *before* this edit. It is carried in
 * the mutation variables (not a column) so the hook can notify only on a genuine
 * (re)assignment to a new member — never on edits to a task's other fields, and
 * never re-pinging the same assignee. It is stripped from the patch sent to the
 * DB.
 */
type ChecklistUpdate = Partial<ChecklistItem> & { id: string; prevAssigneeId?: string | null }

export function useUpdateChecklistItem(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, prevAssigneeId, ...patch }: ChecklistUpdate) => {
      const { error } = await supabase.from('checklist_items').update(patch).eq('id', id)
      if (error) throw error
      if (patch.assignee_id && patch.assignee_id !== prevAssigneeId) {
        notify({
          tripId,
          actorId: memberId,
          recipientIds: [patch.assignee_id],
          type: 'checklist_assigned',
          entityId: id,
          title: patch.title ?? null,
        })
      }
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save those changes')),
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
    onError: (err, _item, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['checklist_items', tripId], ctx.previous)
      toast.error(friendlyError(err, 'Could not update that task'))
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['checklist_items', tripId] }),
  })
}

/** Common first tasks offered on a brand-new, empty checklist (#42). */
export const STARTER_TASKS = [
  'Book flights',
  'Reserve accommodation',
  'Buy travel insurance',
  'Check passports & visas',
  'Make a packing list',
] as const

/** Seed the starter-pack tasks in one shot when the owner accepts the offer. */
export function useSeedStarterTasks(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async () => {
      const base = Date.now()
      const rows = STARTER_TASKS.map((title, i) => ({
        trip_id: tripId,
        created_by: memberId,
        title,
        position: base + i, // preserve the offered order, stay monotonic
      }))
      const { error } = await supabase.from('checklist_items').insert(rows)
      if (error) throw error
      logActivity(tripId, memberId, 'added starter tasks', `${rows.length} tasks`)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not add the starter tasks')),
  })
}

/** Permanently dismiss the starter-pack offer for this trip (#42). */
export function useDismissChecklistStarter(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('dismiss_checklist_starter', { p_trip_id: tripId })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trip', tripId] }),
    onError: (err) => toast.error(friendlyError(err, 'Could not dismiss the offer')),
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
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that task')),
  })
}
