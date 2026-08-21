import * as React from 'react'
import { motion } from '@/lib/motion'
import { useFieldArray, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  CalendarClock, Check, Crown, Lock, LockOpen, Minus, MoreHorizontal, Plus,
  Sparkles, Trash2, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  bestCandidateId, tallyCandidate, useApplyDates, useAvailabilityPolls,
  useCreateAvailabilityPoll, useDeleteAvailabilityPoll, useSetAvailability,
  useSetAvailabilityPollClosed, type AvailabilityPollFull,
} from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { MemberAvatar } from '@/components/ui/avatar'
import { DateInput } from '@/components/ui/date-picker'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, dateRange, isMobileViewport } from '@/lib/utils'
import type { AvailabilityCandidate, AvailabilityStatus } from '@/types'

/* ── New-poll form schema ───────────────────────────────────────────────── */

const candidateSchema = z
  .object({
    start_date: z.string().min(1, 'Pick a start date'),
    end_date: z.string().min(1, 'Pick an end date'),
  })
  .refine((c) => !c.start_date || !c.end_date || c.end_date >= c.start_date, {
    message: 'End is before the start',
    path: ['end_date'],
  })

const pollSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(120, 'Keep it under 120 characters'),
  candidates: z.array(candidateSchema).min(2, 'Add at least 2 date options').max(8),
})

type PollFormValues = z.infer<typeof pollSchema>

/* ── Availability selector (yes / maybe / no) ───────────────────────────── */

const CHOICES: {
  value: AvailabilityStatus
  label: string
  icon: typeof Check
  active: string
}[] = [
  { value: 'yes', label: 'Yes', icon: Check, active: 'bg-success-soft text-success border-success/40' },
  { value: 'maybe', label: 'Maybe', icon: Minus, active: 'bg-accent-soft text-accent border-accent/40' },
  { value: 'no', label: 'No', icon: X, active: 'bg-danger-soft text-danger border-danger/40' },
]

function AvailabilityPicker({
  value,
  onPick,
  disabled,
  labelledBy,
}: {
  value: AvailabilityStatus | undefined
  onPick: (status: AvailabilityStatus) => void
  disabled: boolean
  labelledBy: string
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="flex gap-1.5">
      {CHOICES.map((c) => {
        const selected = value === c.value
        return (
          <button
            key={c.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onPick(c.value)}
            className={cn(
              'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors disabled:opacity-60',
              selected ? c.active : 'border-line text-muted hover:bg-sunken',
              !disabled && 'cursor-pointer'
            )}
          >
            <c.icon className="size-4 shrink-0" />
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── One candidate row ──────────────────────────────────────────────────── */

function CandidateRow({
  poll,
  candidate,
  isWinner,
}: {
  poll: AvailabilityPollFull
  candidate: AvailabilityCandidate
  isWinner: boolean
}) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const setAvailability = useSetAvailability(trip.id, me.id)
  const applyDates = useApplyDates(trip.id)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const tally = tallyCandidate(poll, candidate.id)
  const myResponse = poll.availability_responses.find(
    (r) => r.candidate_id === candidate.id && r.member_id === me.id
  )
  const yesResponders = poll.availability_responses.filter(
    (r) => r.candidate_id === candidate.id && r.status === 'yes'
  )
  const open = !poll.closed
  const applied = poll.applied_candidate_id === candidate.id
  const labelId = `cand-${candidate.id}`

  return (
    <div
      className={cn(
        'rounded-xl border p-3.5',
        applied ? 'border-primary bg-primary-faint' : isWinner ? 'border-accent' : 'border-line'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span id={labelId} className="font-display text-sm font-semibold">
            {dateRange(candidate.start_date, candidate.end_date)}
          </span>
          {applied ? (
            <Badge variant="primary">
              <Check /> Trip dates
            </Badge>
          ) : (
            isWinner && (
              <Badge variant="accent">
                <Crown /> Best overlap
              </Badge>
            )
          )}
        </div>
        <div className="flex items-center gap-3 text-xs tabular-nums text-muted">
          <span className="flex items-center gap-1 text-success">
            <Check className="size-3.5" />
            {tally.yes}
          </span>
          <span className="flex items-center gap-1 text-accent">
            <Minus className="size-3.5" />
            {tally.maybe}
          </span>
          <span className="flex items-center gap-1">
            <X className="size-3.5" />
            {tally.no}
          </span>
        </div>
      </div>

      {yesResponders.length > 0 && (
        <div className="mt-2 flex items-center gap-1">
          <span className="flex -space-x-1">
            {yesResponders.slice(0, 6).map((r) => {
              const m = membersById.get(r.member_id)
              return m ? (
                <MemberAvatar key={r.id} name={m.display_name} color={m.color} size="xs" />
              ) : null
            })}
          </span>
          {yesResponders.length > 6 && (
            <span className="text-xs text-muted">+{yesResponders.length - 6}</span>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3">
          <AvailabilityPicker
            value={myResponse?.status}
            disabled={setAvailability.isPending}
            labelledBy={labelId}
            onPick={(status) =>
              setAvailability.mutate({ poll, candidateId: candidate.id, status })
            }
          />
        </div>
      )}

      {isOwner && open && !poll.applied_candidate_id && (
        <div className="mt-3">
          <Button
            variant="soft"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={applyDates.isPending}
          >
            <Sparkles /> Apply to trip
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set the trip dates?</DialogTitle>
            <DialogDescription>
              This sets the trip to{' '}
              <strong className="text-ink">
                {dateRange(candidate.start_date, candidate.end_date)}
              </strong>
              {(trip.start_date || trip.end_date) && (
                <>
                  {' '}
                  — replacing the current{' '}
                  <strong className="text-ink">
                    {dateRange(trip.start_date, trip.end_date)}
                  </strong>
                </>
              )}
              , and closes this poll. You can change the dates any time in Settings.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={applyDates.isPending}
              onClick={async () => {
                try {
                  await applyDates.mutateAsync({ pollId: poll.id, candidateId: candidate.id })
                  setConfirmOpen(false)
                  toast.success('Trip dates set')
                } catch {
                  // toasted by the mutation's onError
                }
              }}
            >
              {applyDates.isPending ? 'Applying…' : 'Apply dates'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Overlap counts change live (realtime) — announce without re-reading
          the whole card. */}
      <p aria-live="polite" className="sr-only">
        {dateRange(candidate.start_date, candidate.end_date)}: {tally.yes} available,{' '}
        {tally.maybe} maybe, {tally.no} unavailable
      </p>
    </div>
  )
}

/* ── Poll card ──────────────────────────────────────────────────────────── */

function PollCard({ poll, index }: { poll: AvailabilityPollFull; index: number }) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const setClosed = useSetAvailabilityPollClosed(trip.id, me.id)
  const deletePoll = useDeleteAvailabilityPoll(trip.id)

  const winner = bestCandidateId(poll)
  const author = poll.created_by ? membersById.get(poll.created_by) : null
  const responderCount = new Set(poll.availability_responses.map((r) => r.member_id)).size

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3) }}
    >
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="primary">
                <CalendarClock /> Availability
              </Badge>
              {poll.closed && (
                <Badge variant="neutral">
                  <Lock /> Closed
                </Badge>
              )}
            </div>
            <h3 className="mt-2 font-display text-lg font-semibold">{poll.title}</h3>
            <p className="mt-0.5 text-xs text-muted">
              {author ? `by ${author.display_name}` : ''} · {responderCount}{' '}
              {responderCount === 1 ? 'person responded' : 'people responded'}
            </p>
          </div>
          {isOwner && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Poll actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setClosed.mutate({ poll, closed: !poll.closed })}>
                  {poll.closed ? <LockOpen /> : <Lock />}
                  {poll.closed ? 'Reopen poll' : 'Close poll'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  destructive
                  onClick={() =>
                    deletePoll.mutate(poll.id, {
                      onSuccess: () => toast.success('Poll deleted'),
                    })
                  }
                >
                  <Trash2 /> Delete poll
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="mt-4 space-y-2.5">
          {poll.availability_candidates.map((candidate) => (
            <CandidateRow
              key={candidate.id}
              poll={poll}
              candidate={candidate}
              isWinner={candidate.id === winner}
            />
          ))}
        </div>

        {!poll.closed && (
          <p className="mt-3 text-xs text-muted">
            Mark each option — everyone sees the overlap update live.
          </p>
        )}
      </Card>
    </motion.div>
  )
}

/* ── New-poll dialog ────────────────────────────────────────────────────── */

function NewPollDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { trip, me } = useTripContext()
  const createPoll = useCreateAvailabilityPoll(trip.id, me.id)

  const emptyCandidate = { start_date: '', end_date: '' }
  const empty: PollFormValues = {
    title: 'When can everyone go?',
    candidates: [{ ...emptyCandidate }, { ...emptyCandidate }],
  }
  const form = useForm<PollFormValues>({
    resolver: zodResolver(pollSchema),
    defaultValues: empty,
  })
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'candidates' })

  React.useEffect(() => {
    if (open) form.reset(empty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function onSubmit(values: PollFormValues) {
    try {
      await createPoll.mutateAsync({
        title: values.title.trim(),
        candidates: values.candidates.map((c) => ({
          start_date: c.start_date,
          end_date: c.end_date,
        })),
      })
      onOpenChange(false)
      toast.success('Date poll created')
    } catch {
      // toasted by the mutation's onError
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New date poll</DialogTitle>
          <DialogDescription>
            Propose a few candidate date ranges. Everyone marks which work, then you
            apply the winner to the trip.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="poll-title">Title</Label>
            <Input
              id="poll-title"
              placeholder="When can everyone go?"
              autoFocus={!isMobileViewport()}
              {...form.register('title')}
            />
            {err.title && <p className="text-xs text-danger">{err.title.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Date options</Label>
            <div className="space-y-3">
              {fields.map((field, i) => {
                const candErr = err.candidates?.[i]
                return (
                  <div key={field.id} className="rounded-xl border border-line p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted">Option {i + 1}</span>
                      {fields.length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove option ${i + 1}`}
                          onClick={() => remove(i)}
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`start-${i}`} className="text-xs text-muted">
                          Start
                        </Label>
                        <DateInput
                          id={`start-${i}`}
                          value={form.watch(`candidates.${i}.start_date`)}
                          onChange={(v) =>
                            form.setValue(`candidates.${i}.start_date`, v, { shouldValidate: true })
                          }
                          aria-invalid={candErr?.start_date ? true : undefined}
                        />
                        {candErr?.start_date && (
                          <p className="text-xs text-danger">{candErr.start_date.message}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`end-${i}`} className="text-xs text-muted">
                          End
                        </Label>
                        <DateInput
                          id={`end-${i}`}
                          value={form.watch(`candidates.${i}.end_date`)}
                          onChange={(v) =>
                            form.setValue(`candidates.${i}.end_date`, v, { shouldValidate: true })
                          }
                          aria-invalid={candErr?.end_date ? true : undefined}
                        />
                        {candErr?.end_date && (
                          <p className="text-xs text-danger">{candErr.end_date.message}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {(err.candidates?.root?.message ?? err.candidates?.message) && (
              <p className="text-xs text-danger">
                {err.candidates?.root?.message ?? err.candidates?.message}
              </p>
            )}
            {fields.length < 8 && (
              <Button
                type="button"
                variant="soft"
                size="sm"
                className="mt-1"
                onClick={() => append({ ...emptyCandidate })}
              >
                <Plus /> Add option
              </Button>
            )}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Creating…' : 'Create date poll'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function DatesPage() {
  const { trip, isOwner } = useTripContext()
  const polls = useAvailabilityPolls(trip.id)
  const [newOpen, setNewOpen] = React.useState(false)

  const newButton = isOwner ? (
    <Button onClick={() => setNewOpen(true)}>
      <Plus /> New date poll
    </Button>
  ) : undefined

  return (
    <div>
      <PageHeader
        title="Dates"
        description="Find a date that works for everyone before the trip is locked."
        action={newButton}
      />
      {polls.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : polls.isError ? (
        <ErrorState onRetry={() => polls.refetch()} isRetrying={polls.isFetching} />
      ) : polls.data!.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No date polls yet"
          description={
            isOwner
              ? 'Propose a few candidate weekends and let everyone mark what works — then apply the winner to the trip in one tap.'
              : 'The trip owner hasn’t started a date poll yet. When they do, you’ll mark which dates work for you here.'
          }
          action={
            isOwner ? (
              <Button onClick={() => setNewOpen(true)}>
                <Plus /> Start a date poll
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {polls.data!.map((p, i) => (
            <PollCard key={p.id} poll={p} index={i} />
          ))}
        </div>
      )}
      {isOwner && <NewPollDialog open={newOpen} onOpenChange={setNewOpen} />}
    </div>
  )
}
