import { useChecklist } from '@/features/checklist/api'
import { usePacking } from '@/features/packing/api'
import { useBudget, useRepayments } from '@/features/budget/api'
import { usePolls, isPollOpen, type PollWithVotes } from '@/features/polls/api'
import { useQuestions } from '@/features/questions/api'
import { computeBalances } from '@/features/budget/settlement'
import { daysUntil } from '@/lib/utils'
import type { ChecklistItem, Member, PackingItem, Question } from '@/types'

/**
 * "My trip" — the personal cut of everything a signed-in member still has to do
 * or is owed, aggregated read-only over the same cached queries the feature
 * pages use (no new tables, no new writes; issue #177). This feature owns no
 * Supabase access of its own — it composes the other features' hooks — so the
 * "api.ts is the only place that touches Supabase for its feature" invariant is
 * preserved: `me` simply has nothing of its own to touch.
 */

/** Half a cent — matches settlement.ts so a near-zero net reads as settled. */
const SETTLED_EPSILON = 0.005

export interface MyTripSummary {
  /** Checklist items assigned to me that are still open, soonest-due first. */
  checklist: ChecklistItem[]
  /** Packing items I added that aren't packed yet. */
  packing: PackingItem[]
  /** Open polls I haven't voted in. */
  polls: PollWithVotes[]
  /** Questions I asked that are still unanswered. */
  questions: Question[]
  /** My settle-up net in the trip currency: >0 I'm owed, <0 I owe, ~0 settled. */
  net: number
  /** Whether the settle-up net is worth surfacing (non-trivial). */
  hasBalance: boolean
  /** Total outstanding items across every section — 0 means fully caught up. */
  outstandingCount: number
}

/** Sort open checklist items by due date: dated soonest-first, undated last. */
function byDueDate(a: ChecklistItem, b: ChecklistItem): number {
  if (a.due_date && b.due_date) return daysUntil(a.due_date) - daysUntil(b.due_date)
  if (a.due_date) return -1
  if (b.due_date) return 1
  return 0
}

/** Pure aggregation — kept separate from the hook so it's trivial to reason about. */
export function deriveMyTrip(
  meId: string,
  members: Member[],
  data: {
    checklist: ChecklistItem[]
    packing: PackingItem[]
    polls: PollWithVotes[]
    questions: Question[]
    budget: Parameters<typeof computeBalances>[0]
    repayments: Parameters<typeof computeBalances>[2]
  },
): MyTripSummary {
  const checklist = data.checklist
    .filter((c) => c.assignee_id === meId && !c.done)
    .sort(byDueDate)

  const packing = data.packing.filter((p) => p.added_by === meId && !p.packed)

  const polls = data.polls.filter(
    (p) => isPollOpen(p) && !p.votes.some((v) => v.member_id === meId),
  )

  const questions = data.questions.filter((q) => q.member_id === meId && !q.answered)

  const balances = computeBalances(data.budget, members, data.repayments ?? [])
  const net = balances.find((b) => b.member.id === meId)?.net ?? 0
  const hasBalance = Math.abs(net) > SETTLED_EPSILON

  const outstandingCount =
    checklist.length + packing.length + polls.length + questions.length + (hasBalance ? 1 : 0)

  return { checklist, packing, polls, questions, net, hasBalance, outstandingCount }
}

export interface UseMyTripResult {
  data: MyTripSummary | null
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  refetch: () => void
}

/**
 * Composes the existing feature queries (sharing their cache keys, so this adds
 * no new fetching for a trip the member has already opened) and derives the
 * personal summary. Loading/error are the union across the underlying queries.
 */
export function useMyTrip(tripId: string, meId: string, members: Member[]): UseMyTripResult {
  const checklist = useChecklist(tripId)
  const packing = usePacking(tripId)
  const budget = useBudget(tripId)
  const repayments = useRepayments(tripId)
  const polls = usePolls(tripId)
  const questions = useQuestions(tripId)

  const queries = [checklist, packing, budget, repayments, polls, questions]
  const isError = queries.some((q) => q.isError)
  const isLoading = queries.some((q) => q.isLoading)
  const isFetching = queries.some((q) => q.isFetching)
  const refetch = () => queries.forEach((q) => q.refetch())

  const ready =
    checklist.data && packing.data && budget.data && repayments.data && polls.data && questions.data

  const data = ready
    ? deriveMyTrip(meId, members, {
        checklist: checklist.data,
        packing: packing.data,
        polls: polls.data,
        questions: questions.data,
        budget: budget.data,
        repayments: repayments.data,
      })
    : null

  return { data, isLoading, isError, isFetching, refetch }
}
