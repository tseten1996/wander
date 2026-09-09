import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { notify } from '@/lib/notify'
import { friendlyError } from '@/lib/errors'
import { fetchRates } from '@/lib/rates'
import type { BudgetCategory, BudgetEntry, Repayment } from '@/types'

export type BudgetEntryWithReceipt = BudgetEntry & {
  /** A short-lived signed read URL for an entry's receipt image (#338),
   *  resolved by `fetchBudget`. Undefined when the entry has no receipt; null if
   *  signing failed → the thumbnail shows the "unavailable" fallback. */
  image_url?: string | null
}

// ── Expense receipts (#338) ──────────────────────────────────────────────────
// A receipt reuses the private `chat-images` bucket (#51): same bucket, same
// `<trip_id>/<uuid>.<ext>` path, same Storage RLS as a chat image or a trip
// photo. Nothing new is exposed — a receipt is exactly as private as a chat
// image, and this api.ts stays the only place the budget feature touches
// Supabase (the composer calls these helpers).
export const RECEIPT_BUCKET = 'chat-images'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// Mirrors the bucket's server-side MIME allowlist (see the chat-images migration).
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Signed URLs live an hour; a page refetch renews them well inside that, so a
 *  receipt never blanks out mid-session. */
const SIGNED_URL_TTL_SECONDS = 60 * 60

/** Reject a non-image or oversized file up front. Returns an error string for a
 *  toast, or null when the file is acceptable. */
export function validateReceipt(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return 'That file isn’t a supported image (PNG, JPEG, GIF, or WebP).'
  if (file.size > MAX_IMAGE_BYTES) return 'That image is over 5 MB — please pick a smaller one.'
  return null
}

/** Upload a receipt to the private bucket and return its object path. The path's
 *  first segment is the trip id the Storage RLS checks. */
export async function uploadReceipt(tripId: string, file: File): Promise<string> {
  const ext = file.type.split('/')[1] ?? 'bin'
  const imagePath = `${tripId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .upload(imagePath, file, { contentType: file.type, upsert: false })
  if (error) throw error
  return imagePath
}

/** Best-effort removal of a receipt object, so a replaced/removed receipt or a
 *  failed save doesn't litter Storage. Never throws — a Storage hiccup must not
 *  block the visible action (mirrors chat images / trip photos). */
export async function removeReceiptObject(imagePath: string): Promise<void> {
  await supabase.storage.from(RECEIPT_BUCKET).remove([imagePath]).catch(() => {})
}

/** The trip's expense rows, newest first, each receipt's short-lived signed read
 *  URL resolved in the same round-trip (the bucket is private). Exported as a
 *  plain function (not just the hook) so the global search palette can warm this
 *  same cache key without touching Supabase itself — this api.ts stays the only
 *  place that reads the table and mints the receipt URLs. */
export async function fetchBudget(tripId: string): Promise<BudgetEntryWithReceipt[]> {
  const { data, error } = await supabase
    .from('budget_entries')
    .select('*')
    .eq('trip_id', tripId)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = data as BudgetEntryWithReceipt[]
  const paths = [...new Set(rows.map((e) => e.image_path).filter((p): p is string => !!p))]
  if (paths.length > 0) {
    // A signing failure must degrade to "receipt unavailable", never break the
    // whole list — so it's caught, not thrown out of the query.
    try {
      const { data: signed } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      const urls = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
      for (const e of rows) if (e.image_path) e.image_url = urls.get(e.image_path) ?? null
    } catch {
      /* leave image_url unset → the thumbnail shows the unavailable fallback */
    }
  }
  return rows
}

export function useBudget(tripId: string) {
  return useQuery({
    queryKey: ['budget_entries', tripId],
    queryFn: () => fetchBudget(tripId),
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
  /** Receipt object path (#338), or null to clear it. Optional: callers that
   *  never attach a receipt (e.g. the itinerary "Add to budget" link) omit it
   *  and the column stays null. */
  image_path?: string | null
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
    mutationFn: async ({ id, imagePath }: { id: string; imagePath?: string | null }) => {
      // Delete the row first (that's the visible action); then clean up its
      // receipt object best-effort so a Storage hiccup never blocks the delete
      // — the same order chat images (#51) and trip photos (#294) use.
      const { error } = await supabase.from('budget_entries').delete().eq('id', id)
      if (error) throw error
      if (imagePath) await removeReceiptObject(imagePath)
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
