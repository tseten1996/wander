import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { notify } from '@/lib/notify'
import { friendlyError } from '@/lib/errors'
import {
  CHECKLIST_TOGGLE_MUTATION_KEY,
  type ToggleDoneVars,
} from '@/lib/offlineSync'
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

/** Rollback context: the checklist rows as they were before the optimistic flip. */
interface ToggleDoneContext {
  previous?: ChecklistItem[]
}

/**
 * Register the checklist-toggle mutation as offline-replayable (#283). Called
 * once at startup (src/main.tsx) **before** the persisted cache hydrates, so a
 * toggle queued offline in a previous session — restored paused from disk — has
 * a `mutationFn`, optimistic apply, and rollback to resume with even though no
 * ChecklistPage is mounted. `memberId`/`title` ride in the variables (not a
 * React closure) because that is all a resumed mutation has. The write lives
 * here so this api.ts stays the only module that touches `checklist_items`.
 */
export function registerChecklistMutationDefaults(queryClient: QueryClient): void {
  queryClient.setMutationDefaults(CHECKLIST_TOGGLE_MUTATION_KEY, {
    // 'online' (not the app-wide 'always') so this write PAUSES offline and is
    // queued, persisted, and resumed on reconnect instead of erroring.
    networkMode: 'online',
    mutationFn: async ({ id, done, tripId, memberId, title }: ToggleDoneVars) => {
      const { error } = await supabase.from('checklist_items').update({ done }).eq('id', id)
      if (error) throw error
      // Log the completion only when the write actually lands (on reconnect, for
      // a queued toggle) and only for done→true, matching the pre-#283 behaviour.
      if (done) logActivity(tripId, memberId, 'completed', title)
    },
    // Optimistic toggle — checkboxes must feel instant
    onMutate: async ({ tripId, id, done }: ToggleDoneVars): Promise<ToggleDoneContext> => {
      await queryClient.cancelQueries({ queryKey: ['checklist_items', tripId] })
      const previous = queryClient.getQueryData<ChecklistItem[]>(['checklist_items', tripId])
      // Absolute target, not a flip: idempotent on resume / double queue.
      queryClient.setQueryData<ChecklistItem[]>(['checklist_items', tripId], (old) =>
        (old ?? []).map((i) => (i.id === id ? { ...i, done } : i))
      )
      return { previous }
    },
    onError: (err, { tripId }: ToggleDoneVars, ctx) => {
      const context = ctx as ToggleDoneContext | undefined
      if (context?.previous) queryClient.setQueryData(['checklist_items', tripId], context.previous)
      toast.error(friendlyError(err, 'Could not update that task'))
    },
    onSettled: (_data, _err, { tripId }: ToggleDoneVars) =>
      queryClient.invalidateQueries({ queryKey: ['checklist_items', tripId] }),
  })
}

/**
 * Toggle a checklist item's `done` flag. Behaviour lives in the defaults above
 * so a resumed offline write and a live tap share one path. Pass the **target**
 * value, not the item, so the queued write is idempotent on replay.
 */
export function useToggleDone() {
  return useMutation<void, Error, ToggleDoneVars, ToggleDoneContext>({
    mutationKey: CHECKLIST_TOGGLE_MUTATION_KEY,
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
