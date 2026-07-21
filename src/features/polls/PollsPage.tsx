import * as React from 'react'
import { motion } from 'framer-motion'
import { Controller, useFieldArray, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Check, Clock, Crown, Lock, LockOpen, MoreHorizontal, Plus, Trash2, Vote as VoteIcon, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  isPollOpen, useCreatePoll, useDeletePoll, usePolls, useSetPollClosed, useVote,
  type PollWithVotes,
} from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { MemberAvatar } from '@/components/ui/avatar'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, timeAgo } from '@/lib/utils'
import type { PollCategory } from '@/types'

const CATEGORIES: { value: PollCategory; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'dates', label: 'Travel dates' },
  { value: 'stay', label: 'Where to stay' },
  { value: 'flights', label: 'Flights' },
  { value: 'food', label: 'Restaurants' },
  { value: 'activities', label: 'Activities' },
  { value: 'transport', label: 'Transportation' },
]

const pollSchema = z
  .object({
    question: z.string().trim().min(1, 'Give it a question').max(200, 'Keep it under 200 characters'),
    category: z.enum([
      'general', 'dates', 'stay', 'flights', 'food', 'activities', 'transport',
    ]),
    closes_at: z.string().optional().nullable(),
    options: z
      .array(
        z.object({
          value: z.string().trim().max(120, 'Keep options under 120 characters'),
        })
      )
      .min(2)
      .max(8),
  })
  .refine((v) => v.options.filter((o) => o.value.trim()).length >= 2, {
    message: 'Add at least 2 options',
    path: ['options'],
  })

type PollFormValues = z.input<typeof pollSchema>

/* ── Poll card ──────────────────────────────────────────────────────────── */

function PollCard({ poll, index }: { poll: PollWithVotes; index: number }) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const vote = useVote(trip.id, me.id)
  const setClosed = useSetPollClosed(trip.id, me.id)
  const deletePoll = useDeletePoll(trip.id)

  const open = isPollOpen(poll)
  const expired = !poll.closed && !!poll.closes_at && new Date(poll.closes_at) < new Date()
  const totalVotes = poll.votes.length
  const myVote = poll.votes.find((v) => v.member_id === me.id)
  const maxVotes = Math.max(0, ...poll.poll_options.map(
    (o) => poll.votes.filter((v) => v.option_id === o.id).length
  ))
  const canManage = isOwner || poll.created_by === me.id
  const author = poll.created_by ? membersById.get(poll.created_by) : null

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
                {CATEGORIES.find((c) => c.value === poll.category)?.label ?? poll.category}
              </Badge>
              {!open && (
                <Badge variant="neutral">
                  <Lock /> {expired ? 'Expired' : 'Closed'}
                </Badge>
              )}
              {open && poll.closes_at && (
                <Badge variant="accent">
                  <Clock /> closes {timeAgo(poll.closes_at) === 'just now' ? 'soon' : new Date(poll.closes_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </Badge>
              )}
            </div>
            <h3 className="mt-2 font-display text-lg font-semibold">{poll.question}</h3>
            <p className="mt-0.5 text-xs text-muted">
              {author ? `by ${author.display_name}` : ''} · {totalVotes}{' '}
              {totalVotes === 1 ? 'vote' : 'votes'}
            </p>
          </div>
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Poll actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => setClosed.mutate({ poll, closed: !poll.closed })}
                >
                  {poll.closed ? <LockOpen /> : <Lock />}
                  {poll.closed ? 'Reopen poll' : 'Close poll'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  destructive
                  onClick={() => {
                    deletePoll.mutate(poll.id)
                    toast.success('Poll deleted')
                  }}
                >
                  <Trash2 /> Delete poll
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="mt-4 space-y-2">
          {poll.poll_options.map((option) => {
            const optionVotes = poll.votes.filter((v) => v.option_id === option.id)
            const share = totalVotes === 0 ? 0 : (optionVotes.length / totalVotes) * 100
            const isMine = myVote?.option_id === option.id
            const isWinner = !open && optionVotes.length > 0 && optionVotes.length === maxVotes
            return (
              <button
                key={option.id}
                type="button"
                disabled={!open || vote.isPending}
                onClick={() => vote.mutate({ poll, optionId: option.id })}
                className={cn(
                  'relative w-full overflow-hidden rounded-xl border px-4 py-3 text-left transition-all',
                  open && 'cursor-pointer hover:border-primary/50',
                  isMine ? 'border-primary' : 'border-line',
                  isWinner && 'border-accent'
                )}
              >
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 transition-all duration-500',
                    isWinner ? 'bg-accent-soft' : 'bg-primary-faint'
                  )}
                  style={{ width: `${share}%` }}
                />
                <span className="relative flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    {isWinner && <Crown className="size-4 shrink-0 text-accent" />}
                    {isMine && <Check className="size-4 shrink-0 text-primary" />}
                    <span className="truncate">{option.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="flex -space-x-1">
                      {optionVotes.slice(0, 3).map((v) => {
                        const m = membersById.get(v.member_id)
                        return m ? (
                          <MemberAvatar key={v.id} name={m.display_name} color={m.color} size="xs" />
                        ) : null
                      })}
                    </span>
                    <span className="text-xs tabular-nums text-muted">{optionVotes.length}</span>
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        {open && (
          <p className="mt-3 text-xs text-muted">
            {myVote ? 'Tap your choice again to remove your vote.' : 'Tap an option to vote.'}
          </p>
        )}
      </Card>
    </motion.div>
  )
}

/* ── New poll dialog ────────────────────────────────────────────────────── */

function NewPollDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { trip, me } = useTripContext()
  const createPoll = useCreatePoll(trip.id, me.id)

  const empty: PollFormValues = {
    question: '',
    category: 'general',
    closes_at: '',
    options: [{ value: '' }, { value: '' }],
  }
  const form = useForm<PollFormValues>({
    resolver: zodResolver(pollSchema),
    defaultValues: empty,
  })
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'options' })

  React.useEffect(() => {
    if (open) form.reset(empty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function onSubmit(values: PollFormValues) {
    try {
      await createPoll.mutateAsync({
        question: values.question.trim(),
        category: values.category as PollCategory,
        closes_at: values.closes_at ? new Date(values.closes_at).toISOString() : null,
        options: values.options.map((o) => o.value.trim()).filter(Boolean),
      })
      onOpenChange(false)
      toast.success('Poll created')
    } catch {
      // toasted by the mutation's onError
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New poll</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="poll-q">Question</Label>
            <Input
              id="poll-q"
              placeholder="Where should we stay?"
              autoFocus
              {...form.register('question')}
            />
            {err.question && <p className="text-xs text-danger">{err.question.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Controller
                control={form.control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="poll-closes">Closes (optional)</Label>
              <Input id="poll-closes" type="datetime-local" {...form.register('closes_at')} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Options</Label>
            <div className="space-y-2">
              {fields.map((field, i) => (
                <div key={field.id} className="flex gap-2">
                  <Input
                    placeholder={`Option ${i + 1}`}
                    {...form.register(`options.${i}.value` as const)}
                  />
                  {fields.length > 2 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove option"
                      onClick={() => remove(i)}
                    >
                      <X />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {(err.options?.root?.message ?? err.options?.message) && (
              <p className="text-xs text-danger">
                {err.options?.root?.message ?? err.options?.message}
              </p>
            )}
            {fields.length < 8 && (
              <Button
                type="button"
                variant="soft"
                size="sm"
                className="mt-1"
                onClick={() => append({ value: '' })}
              >
                <Plus /> Add option
              </Button>
            )}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Creating…' : 'Create poll'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function PollsPage() {
  const { trip } = useTripContext()
  const polls = usePolls(trip.id)
  const [newOpen, setNewOpen] = React.useState(false)

  return (
    <div>
      <PageHeader
        title="Polls"
        description="Decide together — one vote per person, live results."
        action={
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> New poll
          </Button>
        }
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
          icon={VoteIcon}
          title="No polls yet"
          description="Settle the big questions — dates, hotels, restaurants — with a quick vote."
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> Create the first poll
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {polls.data!.map((p, i) => (
            <PollCard key={p.id} poll={p} index={i} />
          ))}
        </div>
      )}
      <NewPollDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
