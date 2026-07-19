import * as React from 'react'
import { motion } from 'framer-motion'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { MoreHorizontal, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useBudget, useCreateBudgetEntry, useDeleteBudgetEntry, useUpdateBudgetEntry,
  type BudgetInput,
} from './api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, formatMoney, shortDate } from '@/lib/utils'
import type { BudgetCategory, BudgetEntry } from '@/types'

const CATEGORIES: { value: BudgetCategory; label: string }[] = [
  { value: 'stay', label: 'Stay' },
  { value: 'transport', label: 'Transport' },
  { value: 'food', label: 'Food & drinks' },
  { value: 'activities', label: 'Activities' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'other', label: 'Other' },
]

const SHARED = 'shared'

const budgetSchema = z.object({
  title: z.string().trim().min(1, 'Give it a name').max(120, 'Keep it under 120 characters'),
  category: z.enum(['stay', 'transport', 'food', 'activities', 'shopping', 'other']),
  estimated: z.coerce
    .number({ invalid_type_error: 'Enter a number' })
    .min(0, 'Can’t be negative')
    .optional()
    .nullable()
    .or(z.literal('')),
  actual: z.coerce
    .number({ invalid_type_error: 'Enter a number' })
    .min(0, 'Can’t be negative')
    .optional()
    .nullable()
    .or(z.literal('')),
  paid_by: z.string().optional().nullable(),
  entry_date: z.string().optional().nullable(),
  notes: z.string().trim().max(2000, 'Keep it under 2000 characters').optional().nullable(),
})

type BudgetFormValues = z.input<typeof budgetSchema>

function EntryDialog({
  open,
  onOpenChange,
  entry,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  entry?: BudgetEntry
}) {
  const { trip, me, members } = useTripContext()
  const createEntry = useCreateBudgetEntry(trip.id, me.id)
  const updateEntry = useUpdateBudgetEntry(trip.id)

  const empty: BudgetFormValues = {
    title: '',
    category: 'other',
    estimated: '',
    actual: '',
    paid_by: SHARED,
    entry_date: '',
    notes: '',
  }
  const form = useForm<BudgetFormValues>({
    resolver: zodResolver(budgetSchema),
    defaultValues: empty,
  })

  React.useEffect(() => {
    if (open) {
      form.reset(
        entry
          ? {
              title: entry.title,
              category: entry.category,
              estimated: entry.estimated ?? '',
              actual: entry.actual ?? '',
              paid_by: entry.paid_by ?? SHARED,
              entry_date: entry.entry_date ?? '',
              notes: entry.notes ?? '',
            }
          : empty
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry])

  async function onSubmit(values: BudgetFormValues) {
    const payload: BudgetInput = {
      title: values.title.trim(),
      category: values.category as BudgetCategory,
      estimated: values.estimated === '' || values.estimated == null ? null : Number(values.estimated),
      actual: values.actual === '' || values.actual == null ? null : Number(values.actual),
      paid_by: !values.paid_by || values.paid_by === SHARED ? null : values.paid_by,
      entry_date: values.entry_date || null,
      notes: values.notes?.trim() || null,
    }
    try {
      if (entry) await updateEntry.mutateAsync({ id: entry.id, ...payload })
      else await createEntry.mutateAsync(payload)
      onOpenChange(false)
    } catch {
      // toasted by the mutation's onError
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit expense' : 'Add expense'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="b-title">What is it?</Label>
            <Input
              id="b-title"
              placeholder="Hotel — 8 nights"
              autoFocus={!entry}
              {...form.register('title')}
            />
            {err.title && <p className="text-xs text-danger">{err.title.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Controller
                control={form.control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-date">Date</Label>
              <Input id="b-date" type="date" {...form.register('entry_date')} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="b-est">Estimated</Label>
              <Input
                id="b-est"
                type="number" min="0" step="0.01" placeholder="0.00"
                {...form.register('estimated')}
              />
              {err.estimated && <p className="text-xs text-danger">{err.estimated.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-act">Actually paid</Label>
              <Input
                id="b-act"
                type="number" min="0" step="0.01" placeholder="0.00"
                {...form.register('actual')}
              />
              {err.actual && <p className="text-xs text-danger">{err.actual.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Paid by</Label>
            <Controller
              control={form.control}
              name="paid_by"
              render={({ field }) => (
                <Select value={field.value ?? SHARED} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SHARED}>Shared / not paid yet</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="b-notes">Notes</Label>
            <Textarea id="b-notes" className="min-h-14" {...form.register('notes')} />
            {err.notes && <p className="text-xs text-danger">{err.notes.message}</p>}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {entry ? 'Save changes' : 'Add expense'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EntryRow({ entry }: { entry: BudgetEntry }) {
  const { trip, me, isOwner, membersById } = useTripContext()
  const deleteEntry = useDeleteBudgetEntry(trip.id)
  const [editOpen, setEditOpen] = React.useState(false)
  const payer = entry.paid_by ? membersById.get(entry.paid_by) : null
  const canDelete = isOwner || entry.created_by === me.id

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.title}</p>
        <p className="truncate text-xs text-muted">
          {CATEGORIES.find((c) => c.value === entry.category)?.label}
          {entry.entry_date && ` · ${shortDate(entry.entry_date)}`}
          {payer && ` · paid by ${payer.display_name}`}
        </p>
      </div>
      {payer && <MemberAvatar name={payer.display_name} color={payer.color} size="sm" />}
      <div className="w-24 text-right">
        <p className={cn('text-sm font-semibold tabular-nums', entry.actual == null && 'text-muted')}>
          {formatMoney(entry.actual ?? entry.estimated, trip.currency)}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-faint">
          {entry.actual != null ? 'paid' : 'estimated'}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Expense actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <Pencil /> Edit
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem
              destructive
              onClick={() => {
                deleteEntry.mutate(entry.id)
                toast.success('Expense deleted')
              }}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <EntryDialog open={editOpen} onOpenChange={setEditOpen} entry={entry} />
    </div>
  )
}

export default function BudgetPage() {
  const { trip } = useTripContext()
  const budget = useBudget(trip.id)
  const [newOpen, setNewOpen] = React.useState(false)

  const entries = budget.data ?? []
  const planned = entries.reduce((s, e) => s + (e.actual ?? e.estimated ?? 0), 0)
  const spent = entries.reduce((s, e) => s + (e.actual ?? 0), 0)
  const target = trip.estimated_budget
  const remaining = target != null ? target - spent : null
  const over = remaining != null && remaining < 0

  // Spending by category (actual falls back to estimated), for the bar chart
  const byCategory = CATEGORIES.map((c) => ({
    ...c,
    total: entries
      .filter((e) => e.category === c.value)
      .reduce((s, e) => s + (e.actual ?? e.estimated ?? 0), 0),
  })).filter((c) => c.total > 0)
  const maxCategory = Math.max(1, ...byCategory.map((c) => c.total))

  return (
    <div>
      <PageHeader
        title="Budget"
        description="Estimates vs. reality, without the spreadsheet."
        action={
          <Button onClick={() => setNewOpen(true)}>
            <Plus /> Add expense
          </Button>
        }
      />

      {budget.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="space-y-5">
          {/* Summary */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-medium text-muted">Budget</p>
              <p className="mt-1 font-display text-xl font-bold tabular-nums">
                {target != null ? formatMoney(target, trip.currency) : '—'}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium text-muted">Planned</p>
              <p className="mt-1 font-display text-xl font-bold tabular-nums">
                {formatMoney(planned, trip.currency)}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium text-muted">{over ? 'Over budget' : 'Remaining'}</p>
              <p
                className={cn(
                  'mt-1 font-display text-xl font-bold tabular-nums',
                  over ? 'text-danger' : 'text-success'
                )}
              >
                {remaining != null
                  ? formatMoney(Math.abs(remaining), trip.currency)
                  : formatMoney(spent, trip.currency)}
              </p>
            </Card>
          </div>

          {target != null && (
            <Card className="p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  Spent {formatMoney(spent, trip.currency)} of {formatMoney(target, trip.currency)}
                </span>
                <span className="font-display font-bold text-primary">
                  {Math.round((spent / target) * 100)}%
                </span>
              </div>
              <Progress
                value={(spent / target) * 100}
                className="mt-2 h-2.5"
                barClassName={over ? 'bg-danger' : undefined}
                label="Budget used"
              />
            </Card>
          )}

          {byCategory.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Where the money goes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {byCategory.map((c) => (
                  <div key={c.value}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span>{c.label}</span>
                      <span className="tabular-nums text-muted">
                        {formatMoney(c.total, trip.currency)}
                      </span>
                    </div>
                    <motion.div
                      className="h-2 rounded-full bg-primary/80"
                      initial={{ width: 0 }}
                      animate={{ width: `${(c.total / maxCategory) * 100}%` }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {entries.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="No expenses yet"
              description="Add flights, stays and activities with estimated costs — then fill in what you actually paid."
              action={
                <Button onClick={() => setNewOpen(true)}>
                  <Plus /> Add the first expense
                </Button>
              }
            />
          ) : (
            <Card className="divide-y divide-line/60">
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </Card>
          )}
        </div>
      )}

      <EntryDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
