import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Activity, BudgetEntry, ChecklistItem, ItineraryItem } from '@/types'

export interface DashboardData {
  checklist: Pick<ChecklistItem, 'id' | 'done'>[]
  pollsTotal: number
  pollsClosed: number
  questionsTotal: number
  questionsAnswered: number
  packingTotal: number
  packingPacked: number
  budget: Pick<BudgetEntry, 'estimated' | 'actual'>[]
  upcoming: ItineraryItem[]
  activity: Activity[]
  messagesCount: number
  notesCount: number
  ideasCount: number
}

export function useDashboard(tripId: string) {
  return useQuery({
    queryKey: ['dashboard', tripId],
    queryFn: async (): Promise<DashboardData> => {
      const today = new Date().toISOString().slice(0, 10)
      const [
        checklist, polls, pollsClosed, questions, questionsAnswered,
        packing, packingPacked, budget, upcoming, activity,
        messages, notes, ideas,
      ] = await Promise.all([
        supabase.from('checklist_items').select('id, done').eq('trip_id', tripId),
        supabase.from('polls').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
        supabase.from('polls').select('id', { count: 'exact', head: true }).eq('trip_id', tripId).eq('closed', true),
        supabase.from('questions').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
        supabase.from('questions').select('id', { count: 'exact', head: true }).eq('trip_id', tripId).eq('answered', true),
        supabase.from('packing_items').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
        supabase.from('packing_items').select('id', { count: 'exact', head: true }).eq('trip_id', tripId).eq('packed', true),
        supabase.from('budget_entries').select('estimated, actual').eq('trip_id', tripId),
        supabase
          .from('itinerary_items')
          .select('*')
          .eq('trip_id', tripId)
          .gte('day', today)
          .order('day')
          .order('start_time', { nullsFirst: false })
          .limit(4),
        supabase
          .from('activity')
          .select('*')
          .eq('trip_id', tripId)
          .order('created_at', { ascending: false })
          .limit(8),
        supabase.from('messages').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
        supabase.from('notes').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
        supabase.from('inspiration_items').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
      ])

      const firstError =
        checklist.error ?? budget.error ?? upcoming.error ?? activity.error
      if (firstError) throw firstError

      return {
        checklist: checklist.data ?? [],
        pollsTotal: polls.count ?? 0,
        pollsClosed: pollsClosed.count ?? 0,
        questionsTotal: questions.count ?? 0,
        questionsAnswered: questionsAnswered.count ?? 0,
        packingTotal: packing.count ?? 0,
        packingPacked: packingPacked.count ?? 0,
        budget: budget.data ?? [],
        upcoming: (upcoming.data ?? []) as ItineraryItem[],
        activity: (activity.data ?? []) as Activity[],
        messagesCount: messages.count ?? 0,
        notesCount: notes.count ?? 0,
        ideasCount: ideas.count ?? 0,
      }
    },
  })
}

/**
 * Planning completion: every checklist item, poll and question is one unit of
 * planning; done/closed/answered units count as complete. Transparent and
 * easy to move — add tasks and the bar goes down until you do them.
 */
export function planningProgress(d: DashboardData): { pct: number; total: number; done: number } {
  const total = d.checklist.length + d.pollsTotal + d.questionsTotal
  const done =
    d.checklist.filter((c) => c.done).length + d.pollsClosed + d.questionsAnswered
  return { pct: total === 0 ? 0 : Math.round((done / total) * 100), total, done }
}
