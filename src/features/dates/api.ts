import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { logActivity } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import type {
  AvailabilityCandidate,
  AvailabilityPoll,
  AvailabilityResponse,
  AvailabilityStatus,
} from '@/types'

export type AvailabilityPollFull = AvailabilityPoll & {
  availability_candidates: AvailabilityCandidate[]
  availability_responses: AvailabilityResponse[]
}

const KEY = (tripId: string) => ['availability_polls', tripId] as const

export function useAvailabilityPolls(tripId: string) {
  return useQuery({
    queryKey: KEY(tripId),
    queryFn: async (): Promise<AvailabilityPollFull[]> => {
      const { data, error } = await supabase
        .from('availability_polls')
        .select('*, availability_candidates(*), availability_responses(*)')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data as AvailabilityPollFull[]).map((p) => ({
        ...p,
        availability_candidates: [...p.availability_candidates].sort(
          (a, b) => a.position - b.position
        ),
      }))
    },
  })
}

function useInvalidate(tripId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: KEY(tripId) })
}

export interface CandidateInput {
  start_date: string
  end_date: string
}

export function useCreateAvailabilityPoll(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (input: { title: string; candidates: CandidateInput[] }) => {
      const { data: poll, error } = await supabase
        .from('availability_polls')
        .insert({ trip_id: tripId, created_by: memberId, title: input.title })
        .select()
        .single()
      if (error) throw error
      const { error: candError } = await supabase.from('availability_candidates').insert(
        input.candidates.map((c, position) => ({
          trip_id: tripId,
          poll_id: poll.id,
          start_date: c.start_date,
          end_date: c.end_date,
          position,
        }))
      )
      if (candError) throw candError
      logActivity(tripId, memberId, 'started an availability poll', input.title)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not create that date poll')),
  })
}

/**
 * Upsert the current member's yes/maybe/no for one candidate — optimistic with
 * rollback, keyed on the unique(candidate_id, member_id) index so a member never
 * has two responses on the same candidate. The cache patch replaces an existing
 * response in place or appends a new one, so the overlap counts move the instant
 * you tap.
 */
export function useSetAvailability(tripId: string, memberId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      poll,
      candidateId,
      status,
    }: {
      poll: AvailabilityPollFull
      candidateId: string
      status: AvailabilityStatus
    }) => {
      const { error } = await supabase.from('availability_responses').upsert(
        {
          trip_id: tripId,
          poll_id: poll.id,
          candidate_id: candidateId,
          member_id: memberId,
          status,
        },
        { onConflict: 'candidate_id,member_id' }
      )
      if (error) throw error
    },
    onMutate: async ({ poll, candidateId, status }) => {
      await queryClient.cancelQueries({ queryKey: KEY(tripId) })
      const prev = queryClient.getQueryData<AvailabilityPollFull[]>(KEY(tripId))
      queryClient.setQueryData<AvailabilityPollFull[]>(KEY(tripId), (old) =>
        old?.map((p) => {
          if (p.id !== poll.id) return p
          const existing = p.availability_responses.find(
            (r) => r.candidate_id === candidateId && r.member_id === memberId
          )
          const responses = existing
            ? p.availability_responses.map((r) => (r.id === existing.id ? { ...r, status } : r))
            : [
                ...p.availability_responses,
                {
                  id: `optimistic-${candidateId}-${memberId}`,
                  trip_id: tripId,
                  poll_id: p.id,
                  candidate_id: candidateId,
                  member_id: memberId,
                  status,
                  created_at: new Date().toISOString(),
                } satisfies AvailabilityResponse,
              ]
          return { ...p, availability_responses: responses }
        })
      )
      return { prev }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY(tripId), ctx.prev)
      toast.error(friendlyError(err, 'Could not save your availability'))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY(tripId) }),
  })
}

/**
 * Apply a candidate's range to the trip's real dates via the
 * `apply_availability_dates` SECURITY DEFINER RPC. The RPC validates the caller
 * is the owner and records the activity server-side, so the client only fires it
 * and refreshes everything that reads the trip dates (the trip row, dashboard
 * countdown, calendar) plus the poll itself (now closed + "applied").
 */
export function useApplyDates(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ pollId, candidateId }: { pollId: string; candidateId: string }) => {
      const { error } = await supabase.rpc('apply_availability_dates', {
        p_poll_id: pollId,
        p_candidate_id: candidateId,
      })
      if (error) throw error
    },
    onSuccess: () => {
      for (const key of ['availability_polls', 'trip', 'dashboard', 'calendar'] as const) {
        void queryClient.invalidateQueries({ queryKey: [key, tripId] })
      }
    },
    onError: (err) => toast.error(friendlyError(err, 'Could not apply those dates')),
  })
}

export function useSetAvailabilityPollClosed(tripId: string, memberId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async ({ poll, closed }: { poll: AvailabilityPoll; closed: boolean }) => {
      const { error } = await supabase
        .from('availability_polls')
        .update({ closed })
        .eq('id', poll.id)
      if (error) throw error
      if (closed) logActivity(tripId, memberId, 'closed the availability poll', poll.title)
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not update that poll')),
  })
}

export function useDeleteAvailabilityPoll(tripId: string) {
  const invalidate = useInvalidate(tripId)
  return useMutation({
    mutationFn: async (pollId: string) => {
      const { error } = await supabase.from('availability_polls').delete().eq('id', pollId)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(friendlyError(err, 'Could not delete that poll')),
  })
}

/** Per-candidate tallies and the winning candidate id (most yes, tie-break more
 *  maybe, then earliest position) — the group's best overlap. */
export interface CandidateTally {
  yes: number
  maybe: number
  no: number
}

export function tallyCandidate(
  poll: AvailabilityPollFull,
  candidateId: string
): CandidateTally {
  const responses = poll.availability_responses.filter((r) => r.candidate_id === candidateId)
  return {
    yes: responses.filter((r) => r.status === 'yes').length,
    maybe: responses.filter((r) => r.status === 'maybe').length,
    no: responses.filter((r) => r.status === 'no').length,
  }
}

export function bestCandidateId(poll: AvailabilityPollFull): string | null {
  const ranked = poll.availability_candidates
    .map((c) => ({ id: c.id, position: c.position, ...tallyCandidate(poll, c.id) }))
    // A candidate with no support at all never "wins" the highlight.
    .filter((c) => c.yes > 0 || c.maybe > 0)
    .sort(
      (a, b) => b.yes - a.yes || b.maybe - a.maybe || a.position - b.position
    )
  return ranked.length > 0 ? ranked[0].id : null
}
