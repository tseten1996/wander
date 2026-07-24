import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import { fetchRates } from '@/lib/rates'
import type { BudgetCategory, BudgetEntry } from '@/types'

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

export function useCreateBudgetEntry(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: BudgetInput) => {
      const { error } = await supabase.from('budget_entries').insert({
        ...input,
        trip_id: tripId,
        created_by: memberId,
      })
      if (error) throw error
      logActivity(tripId, memberId, 'added an expense', input.title)
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
