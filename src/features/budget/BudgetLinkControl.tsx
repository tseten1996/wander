import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Link2, Link2Off, PiggyBank, Plus, Receipt, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { searchAnchorId } from '@/features/search/anchor'
import { Button } from '@/components/ui/button'
import { AmountInput } from '@/components/ui/amount-input'
import { Label } from '@/components/ui/label'
import { cn, formatMoney } from '@/lib/utils'
import type { BudgetCategory, BudgetEntry } from '@/types'
import { useBudget, useCreateBudgetEntry } from './api'
import { tripActual, tripEstimated } from './amounts'
import { budgetDraftFromBooking } from './bookingLink'

/** A linked entry's amount in the trip currency (paid falls back to planned). */
function entryAmount(entry: BudgetEntry): number | null {
  return tripActual(entry) ?? tripEstimated(entry)
}

/**
 * Deep-link to a budget entry on the Budget page (its search anchor id is stamped
 * on every entry row), the same tap-through the itinerary budget link uses.
 */
function budgetHref(tripId: string, entryId: string): string {
  return `/trip/${tripId}/budget#${searchAnchorId(entryId)}`
}

/**
 * The "Link a cost" control for a stay or transport hop (#370, epic #346),
 * rendered inside the booking's edit dialog. Connects a booking to the budget
 * entry that paid for it — the last unclosed surface of the logistics epic, so a
 * group finally sees "the €600 Airbnb, split among us" in one place instead of
 * once as a nameless expense and once as a costless booking.
 *
 *  - **Linked** — shows the linked entry's real amount, taps through to it on the
 *    Budget page, and can be unlinked.
 *  - **Unlinked** — "Add a cost" creates a trip-currency entry pre-filled from
 *    the booking and links it (refine the payer/split on the Budget page); "Link
 *    an existing expense" points at one already logged, so linking never
 *    double-counts.
 *
 * The link is a pointer between two existing rows: budget totals and settle-up
 * read `budget_entries` alone, so nothing is ever counted twice, and a freshly
 * created cost is settle-up-neutral until someone sets who paid.
 */
export function BudgetLinkControl({
  linkedEntryId,
  onChange,
  draftTitle,
  category,
  busy,
}: {
  linkedEntryId: string | null
  onChange: (entryId: string | null) => void
  draftTitle: string
  category: BudgetCategory
  busy?: boolean
}) {
  const { trip, me, members } = useTripContext()
  const navigate = useNavigate()
  const budget = useBudget(trip.id)
  const createEntry = useCreateBudgetEntry(trip.id, me.id, members.map((m) => m.id))

  // Track the link locally so the control reflects a link/unlink immediately: the
  // parent dialog holds a cached snapshot of the booking that doesn't update until
  // it reopens, so relying on the prop alone would leave the UI a step behind.
  // Re-seed if the prop changes (e.g. the dialog reopens on a different booking).
  const [currentId, setCurrentId] = React.useState<string | null>(linkedEntryId)
  React.useEffect(() => setCurrentId(linkedEntryId), [linkedEntryId])

  // Which unlinked sub-panel is open: the amount form, the existing-entry picker,
  // or neither (the two entry-point buttons).
  const [mode, setMode] = React.useState<'idle' | 'add' | 'pick'>('idle')
  const [amount, setAmount] = React.useState('')
  const amountId = React.useId()

  const linkedEntry = currentId
    ? budget.data?.find((e) => e.id === currentId)
    : undefined
  const working = busy || createEntry.isPending

  function apply(entryId: string | null) {
    setCurrentId(entryId)
    onChange(entryId)
  }

  function goToEntry() {
    if (currentId) navigate(budgetHref(trip.id, currentId))
  }

  async function addCost() {
    const parsed = Number.parseFloat(amount)
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : null
    try {
      const entryId = await createEntry.mutateAsync(
        budgetDraftFromBooking(draftTitle, category, value),
      )
      apply(entryId)
      setMode('idle')
      setAmount('')
      toast.success('Added to the budget')
    } catch {
      // toasted by the mutation's onError
    }
  }

  function pickExisting(entry: BudgetEntry) {
    apply(entry.id)
    setMode('idle')
    toast.success('Linked to the budget')
  }

  return (
    <div className="space-y-1.5">
      <Label>Cost</Label>
      {currentId ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={goToEntry}
            data-tap-target
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 rounded-full bg-primary-faint px-2.5 py-1',
              'text-xs font-medium text-primary transition-colors hover:bg-primary-soft',
            )}
          >
            <PiggyBank className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              In budget
              {linkedEntry
                ? ` · ${formatMoney(entryAmount(linkedEntry), trip.currency)}`
                : ''}
            </span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-tap-target
            disabled={working}
            onClick={() => apply(null)}
          >
            <Link2Off /> Unlink
          </Button>
        </div>
      ) : mode === 'add' ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={amountId} className="text-xs text-muted">
              Amount in {trip.currency}
            </Label>
            <AmountInput
              id={amountId}
              currency={trip.currency}
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" disabled={working} onClick={addCost}>
              <Check /> Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => {
                setMode('idle')
                setAmount('')
              }}
            >
              <X /> Cancel
            </Button>
          </div>
        </div>
      ) : mode === 'pick' ? (
        <div className="space-y-1.5">
          {(budget.data ?? []).length === 0 ? (
            <p className="rounded-xl border border-line bg-sunken/40 px-3 py-2 text-xs text-muted">
              No expenses logged yet. Use “Add a cost” to create one from this
              booking, or add it on the Budget page first.
            </p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-1">
              {(budget.data ?? []).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => pickExisting(entry)}
                    data-tap-target
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                      'hover:bg-sunken disabled:pointer-events-none disabled:opacity-50',
                    )}
                  >
                    <Receipt className="size-3.5 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {entry.title}
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-muted">
                      {formatMoney(entryAmount(entry), trip.currency)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMode('idle')}
          >
            <X /> Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="soft"
            size="sm"
            data-tap-target
            disabled={working}
            onClick={() => setMode('add')}
          >
            <Plus /> Add a cost
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-tap-target
            disabled={working}
            onClick={() => setMode('pick')}
          >
            <Link2 /> Link an existing expense
          </Button>
        </div>
      )}
      {mode === 'idle' && !currentId && (
        <p className="text-xs text-faint">
          Tie this booking to what it cost — set who paid and how it splits on the
          Budget page.
        </p>
      )}
    </div>
  )
}

/**
 * A read-only "In budget · €X" chip for a booking card (#370). Shows the linked
 * entry's amount and taps through to it on the Budget page; renders nothing when
 * the booking has no linked cost, so an unlinked card is unchanged. Any member
 * sees it — the amount is trip-member data — while only the author/owner can set
 * or clear the link (in the edit dialog).
 */
export function BookingCostChip({ entryId }: { entryId: string }) {
  const { trip } = useTripContext()
  const navigate = useNavigate()
  const budget = useBudget(trip.id)
  const entry = budget.data?.find((e) => e.id === entryId)
  return (
    <button
      type="button"
      onClick={() => navigate(budgetHref(trip.id, entryId))}
      data-tap-target
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <PiggyBank className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="truncate">
        {entry ? formatMoney(entryAmount(entry), trip.currency) : 'In budget'}
      </span>
    </button>
  )
}
