import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { notify } from '@/lib/notify'
import { friendlyError } from '@/lib/errors'
import { fetchRates } from '@/lib/rates'
import type { BudgetCategory, BudgetEntry, Repayment } from '@/types'

export function useBudget(tripId: string) {
  return useQuery({
    queryKey: ['budget_entries', tripId],
    queryFn: async (): Promise<BudgetEntry[]> => {
      const { data, error } = await supabase
        .from('budget_entries')
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
  return () => queryClient.invalidateQueries({ queryKey: ['budget_entries', tripId] })
}

export interface BudgetInput {
  title: string
  category: BudgetCategory
  estimated: number | null
  actual: number | null
  /** Original currency; null when the entry is in the trip currency. */
  currency: string | null
  estimated_converted: number | null
  actual_converted: number | null
  exchange_rate: number | null
  /** Members who share this cost; null = shared by all current members. */
  participants: string[] | null
  /** Per-sharer weights for an unequal split (#203); null = equal split. When
   *  present its keys are the sharers — see settlement.ts. */
  shares: Record<string, number> | null
  paid_by: string | null
  entry_date: string | null
  notes: string | null
}

/**
 * ECB reference rates based on the trip currency, cached for the session.
 * Rates move slowly and are only used to seed the converted amount as a member
 * types, so a 6-hour cache is plenty; `retry: false` means the Budget form
 * degrades to trip-currency-only entry the moment rates are unreachable rather
 * than hammering the API.
 */
export function useRates(tripCurrency: string) {
  return useQuery({
    queryKey: ['rates', tripCurrency],
    queryFn: ({ signal }) => fetchRates(tripCurrency, signal),
    staleTime: 6 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

export function useCreateBudgetEntry(tripId: string, memberId: string, memberIds: string[]) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    // Returns the new entry's id so callers that need to link it can — e.g. the
    // itinerary "Add to budget" action (#151) creates the entry, then points the
    // itinerary item at it. Existing callers simply ignore the return value.
    mutationFn: async (input: BudgetInput): Promise<string> => {
      const { data, error } = await supabase
        .from('budget_entries')
        .insert({ ...input, trip_id: tripId, created_by: memberId })
        .select('id')
        .single()
      if (error) throw error
      logActivity(tripId, memberId, 'added an expense', input.title)
      // A real, paid expense creates a debt for whoever shares it (#182) — the
      // same rule settle-up uses (settlement.ts): only actual money paid by a
      // specific member is owed, split across its participants (or everyone when
      // unset), minus the payer themselves. A merely estimated/unpaid entry owes
      // no one, so nothing is sent.
      if (input.actual != null && input.paid_by) {
        // Who owes on this expense, in settle-up's own precedence: a weighted
        // split's keys (#203) win, else the named participants (#104), else
        // everyone. Keeps the "you owe" notification aimed at exactly the
        // members the settle-up math will charge.
        const weighted = input.shares ? Object.keys(input.shares) : []
        const sharers =
          weighted.length > 0
            ? weighted
            : input.participants && input.participants.length > 0
              ? input.participants
              : memberIds
        notify({
          tripId,
          actorId: memberId,
          recipientIds: sharers.filter((id) => id !== input.paid_by),
          type: 'expense_owed',
          entityId: data.id,
          title: input.title,
        })
      }
      return data.id
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not add that expense')),
  })
}

export function useUpdateBudgetEntry(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<BudgetEntry> & { id: string }) => {
      const { error } = await supabase.from('budget_entries').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not save those changes')),
  })
}

export function useDeleteBudgetEntry(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('budget_entries').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that expense')),
  })
}

/* ── Repayments (issue 125) — members paying each other back, netted in settle-up ── */

export function useRepayments(tripId: string) {
  return useQuery({
    queryKey: ['repayments', tripId],
    queryFn: async (): Promise<Repayment[]> => {
      const { data, error } = await supabase
        .from('repayments')
        .select('*')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

function useInvalidateRepayments(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['repayments', tripId] })
}

export interface RepaymentInput {
  from_member: string
  to_member: string
  amount: number
  /** Original currency; null when the repayment is in the trip currency. */
  currency: string | null
  amount_converted: number | null
  exchange_rate: number | null
}

export function useCreateRepayment(tripId: string, memberId: string) {
  const invalidate = useInvalidateRepayments(tripId)
  return useMutation({
    mutationFn: async (input: RepaymentInput) => {
      const { error } = await supabase.from('repayments').insert({
        ...input,
        trip_id: tripId,
        created_by: memberId,
      })
      if (error) throw error
      logActivity(tripId, memberId, 'recorded a repayment')
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not record that payment')),
  })
}

export function useDeleteRepayment(tripId: string) {
  const invalidate = useInvalidateRepayments(tripId)
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('repayments').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not remove that payment')),
  })
}
