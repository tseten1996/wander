import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ArrowRight, Check, HandCoins, MoreHorizontal, Pencil, PiggyBank, Plus, Scale, Trash2, Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useBudget, useCreateBudgetEntry, useCreateRepayment, useDeleteBudgetEntry, useDeleteRepayment,
  useRates, useRepayments, useUpdateBudgetEntry,
  type BudgetInput, type RepaymentInput,
} from './api'
import { CURRENCIES, conversionRate, isSupportedCurrency, toCents, type RateTable } from '@/lib/rates'
import { isForeignEntry, repaymentTripAmount, tripActual, tripEstimated } from './amounts'
import { useRedenominateTrip, useUpdateTripMoney, type TripMoneyInput } from '@/features/trips/api'
import { friendlyError } from '@/lib/errors'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { AmountInput } from '@/components/ui/amount-input'
import { CurrencySelect } from '@/components/ui/currency-select'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { MemberAvatar } from '@/components/ui/avatar'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, formatMoney, isMobileViewport, shortDate } from '@/lib/utils'
import {
  computeBalances, hasSettlementData, isAllSettled, minimalTransfers, type Transfer,
} from './settlement'
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
  currency: z.string().trim().length(3, 'Use a 3-letter code'),
  rate: z.coerce
    .number({ invalid_type_error: 'Enter a rate' })
    .positive('Rate must be positive')
    .optional()
    .nullable()
    .or(z.literal('')),
  paid_by: z.string().optional().nullable(),
  participants: z.array(z.string()).min(1, 'Pick at least one person who shared this'),
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
  const rates = useRates(trip.currency)
  const tripCurrency = trip.currency.toUpperCase()

  // Whether the member has hand-typed a rate — once true we stop re-seeding it
  // from the live table so their override sticks.
  const [rateEdited, setRateEdited] = React.useState(false)

  const allMemberIds = React.useMemo(() => members.map((m) => m.id), [members])
  const empty = React.useMemo<BudgetFormValues>(
    () => ({
      title: '',
      category: 'other',
      estimated: '',
      actual: '',
      currency: tripCurrency,
      rate: '',
      paid_by: SHARED,
      participants: allMemberIds,
      entry_date: '',
      notes: '',
    }),
    [tripCurrency, allMemberIds]
  )
  const form = useForm<BudgetFormValues>({
    resolver: zodResolver(budgetSchema),
    defaultValues: empty,
  })

  React.useEffect(() => {
    if (open) {
      setRateEdited(!!entry?.currency) // a saved entry keeps its frozen rate
      form.reset(
        entry
          ? {
              title: entry.title,
              category: entry.category,
              estimated: entry.estimated ?? '',
              actual: entry.actual ?? '',
              currency: (entry.currency ?? tripCurrency).toUpperCase(),
              rate: entry.exchange_rate ?? '',
              paid_by: entry.paid_by ?? SHARED,
              // Restrict a saved subset to members still on the trip; a null /
              // empty set (or one whose members all left) shows as everyone.
              participants:
                entry.participants?.filter((id) => allMemberIds.includes(id)).length
                  ? entry.participants.filter((id) => allMemberIds.includes(id))
                  : allMemberIds,
              entry_date: entry.entry_date ?? '',
              notes: entry.notes ?? '',
            }
          : empty
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry])

  const selectedCurrency = (form.watch('currency') || tripCurrency).toUpperCase()
  const isForeign = selectedCurrency !== tripCurrency
  const rateTable: RateTable | undefined = rates.data
  const ratesReady = rates.isSuccess && !!rateTable

  // Seed the rate from the live table whenever the picked currency changes,
  // unless the member has overridden it. Foreign → auto rate; back to trip
  // currency → clear.
  React.useEffect(() => {
    if (!open) return
    if (!isForeign) {
      form.setValue('rate', '')
      setRateEdited(false)
      return
    }
    if (rateEdited || !rateTable) return
    const r = conversionRate(selectedCurrency, rateTable)
    if (r != null) form.setValue('rate', toCents(r * 10000) / 10000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedCurrency, isForeign, rateTable])

  // The trip-currency options a member may pick: the trip currency itself, the
  // ECB set when live rates loaded, plus whatever currency a saved entry already
  // uses (so an existing foreign entry still renders even if rates are down).
  const currencyOptions = React.useMemo(() => {
    const codes = new Set<string>([tripCurrency])
    if (ratesReady && rateTable) {
      for (const c of CURRENCIES) if (rateTable[c.code]) codes.add(c.code)
    }
    if (entry?.currency) codes.add(entry.currency.toUpperCase())
    return [...codes].sort()
  }, [ratesReady, rateTable, tripCurrency, entry])

  const rateNum = Number(form.watch('rate'))
  const estNum = Number(form.watch('estimated'))
  const actNum = Number(form.watch('actual'))
  const hasRate = isForeign && Number.isFinite(rateNum) && rateNum > 0
  const previewEst = hasRate && estNum > 0 ? toCents(estNum * rateNum) : null
  const previewAct = hasRate && actNum > 0 ? toCents(actNum * rateNum) : null

  async function onSubmit(values: BudgetFormValues) {
    const currency = (values.currency || tripCurrency).toUpperCase()
    const foreign = currency !== tripCurrency
    const rate = foreign ? Number(values.rate) : null
    if (foreign && !(Number.isFinite(rate!) && rate! > 0)) {
      form.setError('rate', { message: 'Enter a positive rate' })
      return
    }
    const estimated = values.estimated === '' || values.estimated == null ? null : Number(values.estimated)
    const actual = values.actual === '' || values.actual == null ? null : Number(values.actual)
    // Store the canonical "everyone" as null (not the full id list) so a member
    // who joins later is automatically included and settlement keeps the
    // historic default. A real subset is stored verbatim, in member order.
    //
    // Canonicalize against *current* members first: if someone leaves while the
    // dialog is open, a stale id lingers in the form's selection. Comparing the
    // raw picked length to members.length could then read a real subset as
    // "everyone" (e.g. picked A+C, C leaves, members A+B — both length 2) and
    // wrongly persist null, charging a member who never shared the cost. Filter
    // to current members, then decide everyone-vs-subset on the cleaned set.
    const picked = members.filter((m) => (values.participants ?? []).includes(m.id)).map((m) => m.id)
    const participants = picked.length === members.length ? null : picked
    const payload: BudgetInput = {
      title: values.title.trim(),
      category: values.category as BudgetCategory,
      estimated,
      actual,
      currency: foreign ? currency : null,
      exchange_rate: foreign ? rate : null,
      estimated_converted: foreign && estimated != null ? toCents(estimated * rate!) : null,
      actual_converted: foreign && actual != null ? toCents(actual * rate!) : null,
      paid_by: !values.paid_by || values.paid_by === SHARED ? null : values.paid_by,
      participants,
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
              autoFocus={!entry && !isMobileViewport()}
              aria-invalid={err.title ? true : undefined}
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
              <Controller
                control={form.control}
                name="entry_date"
                render={({ field }) => (
                  <DateInput
                    id="b-date"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <Controller
              control={form.control}
              name="currency"
              render={({ field }) => (
                <Select
                  value={(field.value || tripCurrency).toUpperCase()}
                  onValueChange={field.onChange}
                  disabled={currencyOptions.length <= 1}
                >
                  <SelectTrigger aria-label="Entry currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {currencyOptions.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}{code === tripCurrency ? ' · trip currency' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {rates.isError && (
              <p className="text-xs text-muted">
                Live rates unavailable — entries use {tripCurrency} for now.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="b-est">Estimated</Label>
              <AmountInput
                id="b-est"
                type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                currency={selectedCurrency}
                aria-invalid={err.estimated ? true : undefined}
                {...form.register('estimated')}
              />
              {err.estimated && <p className="text-xs text-danger">{err.estimated.message}</p>}
              {previewEst != null && (
                <p className="text-xs text-muted tabular-nums">≈ {formatMoney(previewEst, tripCurrency)}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-act">Actually paid</Label>
              <AmountInput
                id="b-act"
                type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                currency={selectedCurrency}
                aria-invalid={err.actual ? true : undefined}
                {...form.register('actual')}
              />
              {err.actual && <p className="text-xs text-danger">{err.actual.message}</p>}
              {previewAct != null && (
                <p className="text-xs text-muted tabular-nums">≈ {formatMoney(previewAct, tripCurrency)}</p>
              )}
            </div>
          </div>
          {isForeign && (
            <div className="space-y-1.5">
              <Label htmlFor="b-rate">
                Rate — 1 {selectedCurrency} = ? {tripCurrency}
              </Label>
              <Input
                id="b-rate"
                type="number" inputMode="decimal" min="0" step="0.0001" placeholder="0.0000"
                aria-invalid={err.rate ? true : undefined}
                {...form.register('rate', { onChange: () => setRateEdited(true) })}
              />
              {err.rate ? (
                <p className="text-xs text-danger">{err.rate.message}</p>
              ) : (
                <p className="text-xs text-muted">
                  Auto-filled from today’s ECB rate — edit if you got a different one.
                  All totals and settle-up use the {tripCurrency} value.
                </p>
              )}
            </div>
          )}
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
          <Controller
            control={form.control}
            name="participants"
            render={({ field }) => {
              const value = field.value ?? []
              const selected = new Set(value)
              const everyone = value.length === members.length
              const inMemberOrder = (ids: Set<string>) =>
                members.filter((m) => ids.has(m.id)).map((m) => m.id)
              const toggle = (id: string) => {
                const next = new Set(selected)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                field.onChange(inMemberOrder(next))
              }
              return (
                <div className="space-y-2">
                  <Label id="b-split-label">Split between</Label>
                  <div
                    role="group"
                    aria-labelledby="b-split-label"
                    className="flex flex-wrap gap-2"
                  >
                    <button
                      type="button"
                      aria-pressed={everyone}
                      onClick={() => field.onChange(allMemberIds)}
                      className={cn(
                        'inline-flex min-h-11 items-center rounded-full border px-3.5 text-sm font-medium transition-colors',
                        everyone
                          ? 'border-primary bg-primary-faint text-primary'
                          : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-sunken'
                      )}
                    >
                      Everyone
                    </button>
                    {members.map((m) => {
                      const on = selected.has(m.id)
                      return (
                        <button
                          key={m.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggle(m.id)}
                          className={cn(
                            'inline-flex min-h-11 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-sm font-medium transition-colors',
                            on
                              ? 'border-primary bg-primary-faint text-primary'
                              : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-sunken'
                          )}
                        >
                          <MemberAvatar name={m.display_name} color={m.color} size="sm" />
                          {m.display_name}
                        </button>
                      )
                    })}
                  </div>
                  <p aria-live="polite" className="text-xs text-muted">
                    {everyone
                      ? 'Shared by everyone on the trip.'
                      : value.length === 0
                        ? 'Pick who shared this expense.'
                        : `Split ${value.length} ${value.length === 1 ? 'way' : 'ways'}.`}
                  </p>
                  {err.participants && (
                    <p className="text-xs text-danger">{err.participants.message}</p>
                  )}
                </div>
              )
            }}
          />
          <div className="space-y-1.5">
            <Label htmlFor="b-notes">Notes</Label>
            <Textarea
              id="b-notes"
              className="min-h-14"
              aria-invalid={err.notes ? true : undefined}
              {...form.register('notes')}
            />
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
  const foreign = isForeignEntry(entry, trip.currency)

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
          {formatMoney(tripActual(entry) ?? tripEstimated(entry), trip.currency)}
        </p>
        {foreign && (
          <p className="text-[10px] tabular-nums text-muted">
            {formatMoney(entry.actual ?? entry.estimated, entry.currency ?? trip.currency)}
          </p>
        )}
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
              onClick={() =>
                deleteEntry.mutate(entry.id, {
                  onSuccess: () => toast.success('Expense deleted'),
                })
              }
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

const repaymentSchema = z
  .object({
    from_member: z.string().min(1, 'Pick who paid'),
    to_member: z.string().min(1, 'Pick who was paid back'),
    amount: z
      .union([
        z.literal(''),
        z.coerce.number({ invalid_type_error: 'Enter an amount' }),
      ])
      .refine((v) => v !== '' && Number(v) > 0, 'Enter an amount greater than zero'),
    currency: z.string().trim().length(3, 'Use a 3-letter code'),
    rate: z.coerce
      .number({ invalid_type_error: 'Enter a rate' })
      .positive('Rate must be positive')
      .optional()
      .nullable()
      .or(z.literal('')),
  })
  .refine((v) => v.from_member !== v.to_member, {
    message: 'Pick two different people',
    path: ['to_member'],
  })

type RepaymentFormValues = z.input<typeof repaymentSchema>

/**
 * Record a member-to-member payment. Multi-currency mirrors the expense dialog:
 * a foreign amount is frozen into the trip currency (`amount_converted`) at
 * record time, so settle-up nets it on the same footing as the expenses it
 * squares up and a settled balance never drifts when rates later move.
 */
function RepaymentDialog({
  open,
  onOpenChange,
  defaultFrom,
  defaultTo,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  defaultFrom?: string
  defaultTo?: string
}) {
  const { trip, me, members } = useTripContext()
  const createRepayment = useCreateRepayment(trip.id, me.id)
  const rates = useRates(trip.currency)
  const tripCurrency = trip.currency.toUpperCase()
  const rateTable: RateTable | undefined = rates.data
  const ratesReady = rates.isSuccess && !!rateTable

  const [rateEdited, setRateEdited] = React.useState(false)

  const empty = React.useMemo<RepaymentFormValues>(
    () => ({
      from_member: defaultFrom ?? me.id,
      to_member: defaultTo ?? '',
      amount: '',
      currency: tripCurrency,
      rate: '',
    }),
    [defaultFrom, defaultTo, me.id, tripCurrency]
  )
  const form = useForm<RepaymentFormValues>({
    resolver: zodResolver(repaymentSchema),
    defaultValues: empty,
  })

  React.useEffect(() => {
    if (open) {
      setRateEdited(false)
      form.reset(empty)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedCurrency = (form.watch('currency') || tripCurrency).toUpperCase()
  const isForeign = selectedCurrency !== tripCurrency

  // Seed the rate from the live table when a foreign currency is picked, unless
  // the member overrode it — identical behaviour to the expense dialog.
  React.useEffect(() => {
    if (!open) return
    if (!isForeign) {
      form.setValue('rate', '')
      setRateEdited(false)
      return
    }
    if (rateEdited || !rateTable) return
    const r = conversionRate(selectedCurrency, rateTable)
    if (r != null) form.setValue('rate', toCents(r * 10000) / 10000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedCurrency, isForeign, rateTable])

  const currencyOptions = React.useMemo(() => {
    const codes = new Set<string>([tripCurrency])
    if (ratesReady && rateTable) {
      for (const c of CURRENCIES) if (rateTable[c.code]) codes.add(c.code)
    }
    return [...codes].sort()
  }, [ratesReady, rateTable, tripCurrency])

  const rateNum = Number(form.watch('rate'))
  const amtNum = Number(form.watch('amount'))
  const hasRate = isForeign && Number.isFinite(rateNum) && rateNum > 0
  const previewAmount = hasRate && amtNum > 0 ? toCents(amtNum * rateNum) : null

  async function onSubmit(values: RepaymentFormValues) {
    const currency = (values.currency || tripCurrency).toUpperCase()
    const foreign = currency !== tripCurrency
    const rate = foreign ? Number(values.rate) : null
    if (foreign && !(Number.isFinite(rate!) && rate! > 0)) {
      form.setError('rate', { message: 'Enter a positive rate' })
      return
    }
    const amount = Number(values.amount)
    const payload: RepaymentInput = {
      from_member: values.from_member,
      to_member: values.to_member,
      amount,
      currency: foreign ? currency : null,
      exchange_rate: foreign ? rate : null,
      amount_converted: foreign ? toCents(amount * rate!) : null,
    }
    try {
      await createRepayment.mutateAsync(payload)
      toast.success('Payment recorded')
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
          <DialogTitle>Record a payment</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Who paid</Label>
              <Controller
                control={form.control}
                name="from_member"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Who paid">
                      <SelectValue placeholder="Select a person" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {err.from_member && <p className="text-xs text-danger">{err.from_member.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Who they paid back</Label>
              <Controller
                control={form.control}
                name="to_member"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Who they paid back">
                      <SelectValue placeholder="Select a person" />
                    </SelectTrigger>
                    <SelectContent>
                      {members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.display_name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {err.to_member && <p className="text-xs text-danger">{err.to_member.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="r-amount">Amount</Label>
              <AmountInput
                id="r-amount"
                type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                currency={selectedCurrency}
                aria-invalid={err.amount ? true : undefined}
                {...form.register('amount')}
              />
              {err.amount && <p className="text-xs text-danger">{err.amount.message}</p>}
              {previewAmount != null && (
                <p className="text-xs text-muted tabular-nums">≈ {formatMoney(previewAmount, tripCurrency)}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Controller
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <Select
                    value={(field.value || tripCurrency).toUpperCase()}
                    onValueChange={field.onChange}
                    disabled={currencyOptions.length <= 1}
                  >
                    <SelectTrigger aria-label="Payment currency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {currencyOptions.map((code) => (
                        <SelectItem key={code} value={code}>
                          {code}{code === tripCurrency ? ' · trip currency' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {rates.isError && (
                <p className="text-xs text-muted">
                  Live rates unavailable — recorded in {tripCurrency}.
                </p>
              )}
            </div>
          </div>
          {isForeign && (
            <div className="space-y-1.5">
              <Label htmlFor="r-rate">Rate — 1 {selectedCurrency} = ? {tripCurrency}</Label>
              <Input
                id="r-rate"
                type="number" inputMode="decimal" min="0" step="0.0001" placeholder="0.0000"
                aria-invalid={err.rate ? true : undefined}
                {...form.register('rate', { onChange: () => setRateEdited(true) })}
              />
              {err.rate ? (
                <p className="text-xs text-danger">{err.rate.message}</p>
              ) : (
                <p className="text-xs text-muted">
                  Auto-filled from today’s ECB rate. Settle-up uses the {tripCurrency} value.
                </p>
              )}
            </div>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            Record payment
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SettlementCard({ entries }: { entries: BudgetEntry[] }) {
  const { trip, me, isOwner, members, membersById } = useTripContext()
  const repaymentsQuery = useRepayments(trip.id)
  const repayments = React.useMemo(() => repaymentsQuery.data ?? [], [repaymentsQuery.data])
  const createRepayment = useCreateRepayment(trip.id, me.id)
  const deleteRepayment = useDeleteRepayment(trip.id)
  const [recordOpen, setRecordOpen] = React.useState(false)

  const balances = React.useMemo(
    () => computeBalances(entries, members, repayments),
    [entries, members, repayments]
  )
  const transfers = React.useMemo(() => minimalTransfers(balances), [balances])
  const settled = isAllSettled(balances)

  // Owed first (largest positive net), then those who owe.
  const sortedBalances = React.useMemo(
    () => [...balances].sort((a, b) => b.net - a.net),
    [balances]
  )

  // One-tap "mark as paid": record the suggested transfer verbatim. It is already
  // in the trip currency, so no conversion is needed — settle-up nets it and the
  // transfer shrinks or disappears on the next render.
  const markPaid = (t: Transfer) => {
    createRepayment.mutate(
      {
        from_member: t.from.id,
        to_member: t.to.id,
        amount: t.amount,
        currency: null,
        amount_converted: null,
        exchange_rate: null,
      },
      {
        onSuccess: () =>
          toast.success(`Marked ${t.from.display_name} → ${t.to.display_name} as paid`),
      }
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Scale className="size-4 text-muted" aria-hidden />
            Settle up
          </CardTitle>
          <Button variant="secondary" size="sm" data-tap-target onClick={() => setRecordOpen(true)}>
            <HandCoins /> Record a payment
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2.5">
          {sortedBalances.map((b) => {
            const owed = b.net > 0.005
            const owes = b.net < -0.005
            return (
              <li key={b.member.id} className="flex items-center gap-3">
                <MemberAvatar name={b.member.display_name} color={b.member.color} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {b.member.display_name}
                </span>
                <span
                  className={cn(
                    'text-right text-sm font-semibold tabular-nums',
                    owed && 'text-success',
                    owes && 'text-danger',
                    !owed && !owes && 'text-muted'
                  )}
                >
                  {owed && `gets back ${formatMoney(b.net, trip.currency)}`}
                  {owes && `owes ${formatMoney(-b.net, trip.currency)}`}
                  {!owed && !owes && 'settled'}
                </span>
              </li>
            )
          })}
        </ul>

        <div className="border-t border-line/60 pt-3">
          {settled || transfers.length === 0 ? (
            <p className="text-sm text-muted">Everyone’s even — nothing to settle. 🎉</p>
          ) : (
            <>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
                Suggested transfers
              </p>
              <ul className="space-y-2">
                {transfers.map((t, i) => (
                  <li
                    key={`${t.from.id}-${t.to.id}-${i}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <MemberAvatar name={t.from.display_name} color={t.from.color} size="sm" />
                      {t.from.display_name}
                    </span>
                    <ArrowRight className="size-4 text-faint" aria-label="pays" />
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <MemberAvatar name={t.to.display_name} color={t.to.color} size="sm" />
                      {t.to.display_name}
                    </span>
                    <span className="ml-auto font-semibold tabular-nums">
                      {formatMoney(t.amount, trip.currency)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-tap-target
                      className="shrink-0"
                      disabled={createRepayment.isPending}
                      onClick={() => markPaid(t)}
                    >
                      <Check /> Mark paid
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {repayments.length > 0 && (
          <div className="border-t border-line/60 pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
              Recorded payments
            </p>
            <ul className="space-y-2">
              {repayments.map((r) => {
                const from = membersById.get(r.from_member)
                const to = membersById.get(r.to_member)
                const canDelete = isOwner || r.created_by === me.id
                const foreign =
                  !!r.currency && r.currency.toUpperCase() !== trip.currency.toUpperCase()
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      {from && (
                        <MemberAvatar name={from.display_name} color={from.color} size="sm" />
                      )}
                      {from?.display_name ?? 'Someone'}
                    </span>
                    <ArrowRight className="size-4 text-faint" aria-label="paid" />
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      {to && <MemberAvatar name={to.display_name} color={to.color} size="sm" />}
                      {to?.display_name ?? 'Someone'}
                    </span>
                    <span className="ml-auto text-right tabular-nums">
                      <span className="font-semibold">
                        {formatMoney(repaymentTripAmount(r), trip.currency)}
                      </span>
                      {foreign && (
                        <span className="ml-1 text-[10px] text-muted">
                          {formatMoney(r.amount, r.currency ?? trip.currency)}
                        </span>
                      )}
                    </span>
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        aria-label="Undo this payment"
                        disabled={deleteRepayment.isPending}
                        onClick={() =>
                          deleteRepayment.mutate(r.id, {
                            onSuccess: () => toast.success('Payment removed'),
                          })
                        }
                      >
                        <Undo2 />
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </CardContent>
      <RepaymentDialog open={recordOpen} onOpenChange={setRecordOpen} />
    </Card>
  )
}

/* ── Currency & total budget (owner edits; members see read-only) ─────────── */

const tripMoneySchema = z.object({
  currency: z
    .string()
    .trim()
    .refine(isSupportedCurrency, 'Choose a supported currency'),
  estimated_budget: z.coerce
    .number({ invalid_type_error: 'Enter a number' })
    .positive('Must be greater than zero')
    .optional()
    .or(z.literal('')),
})

type TripMoneyFormValues = z.input<typeof tripMoneySchema>

function CurrencyBudgetForm() {
  const { trip } = useTripContext()
  const updateMoney = useUpdateTripMoney(trip.id)
  const redenominate = useRedenominateTrip(trip.id)
  // Live ECB rates based on the CURRENT (old) trip currency — `rates[NEW]` is
  // exactly the old→new multiplier the re-denomination RPC needs (#147).
  const rates = useRates(trip.currency)
  // Existing amounts a currency change would re-denominate. Before letting an
  // owner switch we need to know whether there is anything to convert (#146
  // added the confirmation; #147 makes the confirmed switch actually convert).
  // Both are cached queries — the page already loads entries above.
  const budget = useBudget(trip.id)
  const repayments = useRepayments(trip.id)
  const form = useForm<TripMoneyFormValues>({
    resolver: zodResolver(tripMoneySchema),
    defaultValues: {
      currency: trip.currency,
      estimated_budget: trip.estimated_budget ?? '',
    },
  })
  // The pending write held back while the owner confirms a currency change.
  const [pending, setPending] = React.useState<TripMoneyInput | null>(null)

  // useRates deliberately never retries (the entry form degrades gracefully),
  // but here a missing table blocks the conversion outright — give it one
  // fresh attempt each time the confirm dialog opens after a failure.
  const ratesErrored = rates.isError
  const refetchRates = rates.refetch
  React.useEffect(() => {
    if (pending != null && ratesErrored) void refetchRates()
  }, [pending, ratesErrored, refetchRates])

  // Keep the form in step with the trip row: after a re-denomination the
  // stored budget is a *different number* (converted server-side), and these
  // fields can also change from another device.
  React.useEffect(() => {
    form.reset({ currency: trip.currency, estimated_budget: trip.estimated_budget ?? '' })
  }, [form, trip.currency, trip.estimated_budget])

  // Only skip the confirmation once we've *confirmed* there is nothing to
  // convert; until the queries resolve, treat a currency change as needing
  // confirmation rather than risk converting amounts we haven't seen yet. The
  // total budget counts too — it is converted like everything else.
  const hasAmounts =
    (budget.data?.length ?? 0) > 0 ||
    (repayments.data?.length ?? 0) > 0 ||
    trip.estimated_budget != null
  const amountsKnown = budget.isSuccess && repayments.isSuccess

  async function write(input: TripMoneyInput) {
    try {
      await updateMoney.mutateAsync(input)
      toast.success('Currency & budget updated')
    } catch (error) {
      toast.error(friendlyError(error, 'Could not save currency & budget'))
    }
  }

  function save(values: TripMoneyFormValues) {
    const input: TripMoneyInput = {
      currency: values.currency,
      estimated_budget:
        values.estimated_budget === '' || values.estimated_budget == null
          ? null
          : Number(values.estimated_budget),
    }
    const currencyChanged = input.currency.toUpperCase() !== trip.currency.toUpperCase()
    // A currency change on a trip that has (or might have) amounts is an
    // informed action, not a silent one — hold the write for confirmation.
    if (currencyChanged && (hasAmounts || !amountsKnown)) {
      setPending(input)
      return
    }
    void write(input)
  }

  // Cancelling must leave the trip currency untouched and write nothing:
  // restore the select to the trip's real currency and drop the pending write.
  function cancelChange() {
    form.setValue('currency', trip.currency, { shouldValidate: true })
    setPending(null)
  }

  async function confirmChange() {
    const input = pending
    if (!input) return
    const rate = rates.data?.[input.currency.toUpperCase()]
    if (!rate || rate <= 0) return // Convert button is disabled in this state
    setPending(null)
    try {
      await redenominate.mutateAsync({
        currency: input.currency,
        rate,
        // A budget figure the owner typed in this same save is already in the
        // NEW currency — pass it through; an untouched one is converted by the
        // RPC alongside everything else.
        estimated_budget:
          input.estimated_budget !== (trip.estimated_budget ?? null)
            ? input.estimated_budget
            : null,
      })
      // The RPC can't distinguish "convert the stored budget" (null) from
      // "clear the budget" — clearing during a switch needs a follow-up write.
      if (input.estimated_budget == null && trip.estimated_budget != null) {
        await updateMoney.mutateAsync({ currency: input.currency, estimated_budget: null })
      }
      toast.success(`Converted the trip to ${input.currency.toUpperCase()}`)
    } catch (error) {
      form.setValue('currency', trip.currency, { shouldValidate: true })
      toast.error(friendlyError(error, 'Could not convert the trip'))
    }
  }

  const err = form.formState.errors
  const oldCode = trip.currency.toUpperCase()
  const newCode = (pending?.currency ?? trip.currency).toUpperCase()
  // The old→new rate for the pending switch; null while rates are loading or
  // when the ECB table is unreachable (offline), in which case converting is
  // blocked rather than silently relabelling.
  const pendingRate = pending ? (rates.data?.[newCode] ?? null) : null
  const rateDisplay =
    pendingRate != null
      ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(pendingRate)
      : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Currency &amp; budget</CardTitle>
        <CardDescription>
          The currency every amount here is shown in, and the trip’s total budget.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(save)} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bp-currency">Currency</Label>
              <Controller
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <CurrencySelect
                    id="bp-currency"
                    value={field.value}
                    onValueChange={field.onChange}
                    aria-invalid={err.currency ? true : undefined}
                  />
                )}
              />
              {err.currency && <p className="text-xs text-danger">{err.currency.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-budget">Total budget</Label>
              <AmountInput
                id="bp-budget"
                type="number"
                inputMode="decimal"
                min="0"
                placeholder="Optional"
                currency={form.watch('currency') || trip.currency}
                aria-invalid={err.estimated_budget ? true : undefined}
                {...form.register('estimated_budget')}
              />
              {err.estimated_budget && (
                <p className="text-xs text-danger">{err.estimated_budget.message}</p>
              )}
            </div>
          </div>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>

      <Dialog
        open={pending != null}
        onOpenChange={(o) => {
          // Any dismissal (Cancel, Escape, overlay, ×) restores the currency
          // and writes nothing.
          if (!o) cancelChange()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert this trip to {newCode}?</DialogTitle>
            <DialogDescription>
              {pendingRate != null ? (
                <>
                  Every existing amount — expenses, payments and the total budget —
                  will be <strong>converted</strong> from {oldCode} to {newCode} at
                  today&apos;s rate: 1 {oldCode} ≈ {rateDisplay} {newCode}. Amounts
                  logged in another currency keep their original figures; only what
                  they count as in {newCode} is recalculated.
                </>
              ) : (
                <>
                  Converting needs a live exchange rate, and the rates service is
                  unreachable right now. Try again once you&apos;re back online —
                  amounts are never relabelled without converting.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" className="sm:w-auto" onClick={cancelChange}>
              Keep {oldCode}
            </Button>
            <Button
              className="sm:w-auto"
              disabled={pendingRate == null || redenominate.isPending || updateMoney.isPending}
              onClick={confirmChange}
            >
              Convert to {newCode}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function CurrencyBudgetReadOnly() {
  const { trip } = useTripContext()
  const code = trip.currency.toUpperCase()
  const name = CURRENCIES.find((c) => c.code === code)?.name
  return (
    <Card>
      <CardHeader>
        <CardTitle>Currency &amp; budget</CardTitle>
        <CardDescription>Set by the trip owner.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-medium text-muted">Currency</p>
          <p className="mt-1 text-sm">
            <span className="font-medium">{code}</span>
            {name && <span className="text-muted"> · {name}</span>}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Total budget</p>
          <p className="mt-1 text-sm font-medium tabular-nums">
            {trip.estimated_budget != null
              ? formatMoney(trip.estimated_budget, trip.currency)
              : '—'}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function CurrencyBudgetCard() {
  const { isOwner } = useTripContext()
  return isOwner ? <CurrencyBudgetForm /> : <CurrencyBudgetReadOnly />
}

export default function BudgetPage() {
  const { trip } = useTripContext()
  const budget = useBudget(trip.id)
  const [newOpen, setNewOpen] = React.useState(false)
  // Framer animates `width` directly here (not a transform/layout prop), so the
  // root MotionConfig reducedMotion="user" does NOT suppress it — gate it by
  // hand so the category bars appear filled, not sweeping, under reduced motion (#137).
  const reduceMotion = useReducedMotion()

  const entries = budget.data ?? []
  // All roll-ups run on the trip-currency amount (converted ?? raw) so a
  // multi-currency trip totals correctly — see ./amounts.
  const planned = entries.reduce((s, e) => s + (tripActual(e) ?? tripEstimated(e) ?? 0), 0)
  const spent = entries.reduce((s, e) => s + (tripActual(e) ?? 0), 0)
  const target = trip.estimated_budget
  const remaining = target != null ? target - spent : null
  const over = remaining != null && remaining < 0

  // Spending by category (actual falls back to estimated), for the bar chart
  const byCategory = CATEGORIES.map((c) => ({
    ...c,
    total: entries
      .filter((e) => e.category === c.value)
      .reduce((s, e) => s + (tripActual(e) ?? tripEstimated(e) ?? 0), 0),
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

      <div className="space-y-5">
        <CurrencyBudgetCard />

        {budget.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-28" />
            <Skeleton className="h-48" />
          </div>
        ) : budget.isError ? (
          <ErrorState onRetry={() => budget.refetch()} isRetrying={budget.isFetching} />
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
                      initial={reduceMotion ? false : { width: 0 }}
                      animate={{ width: `${(c.total / maxCategory) * 100}%` }}
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.5, ease: 'easeOut' }}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {hasSettlementData(entries) && <SettlementCard entries={entries} />}

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
      </div>

      <EntryDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
