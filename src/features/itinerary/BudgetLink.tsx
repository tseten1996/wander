import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Link2, Link2Off, PiggyBank, Plus, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { useBudget, useCreateBudgetEntry } from '@/features/budget/api'
import { tripActual, tripEstimated } from '@/features/budget/amounts'
import { budgetDraftFromItinerary } from '@/features/budget/itineraryLink'
import { searchAnchorId } from '@/features/search/anchor'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/misc'
import { cn, formatMoney } from '@/lib/utils'
import { useUpdateItineraryItem } from './api'
import type { BudgetEntry, ItineraryItem } from '@/types'

/** The linked entry's amount in the trip currency (paid falls back to planned). */
function entryAmount(entry: BudgetEntry): number {
  return tripActual(entry) ?? tripEstimated(entry) ?? 0
}

/**
 * The budget status + actions for a single itinerary item (#151). Turns the
 * dead-end `cost` field into an honest one:
 *
 *  - **Linked** — shows the linked entry's real amount and reads as *tracked*,
 *    tapping through to that expense on the Budget page. Can be unlinked.
 *  - **Unlinked, has a cost** — the cost shows as a muted *planning note*, made
 *    explicit as "not in the budget yet", with one-tap "Add to budget" (creates
 *    a pre-filled, linked entry) and "Link" (points at an existing entry — no
 *    duplicate).
 *  - **Unlinked, no cost** — nothing; there's no money trap to defuse.
 *
 * Totals never read this — the Budget page sums `budget_entries` alone — so an
 * amount is never counted twice. Rendered inside the card's content column,
 * raised above the card's transparent select-overlay so its controls stay
 * clickable.
 */
export function ItemBudgetLink({ item }: { item: ItineraryItem }) {
  const { trip, me } = useTripContext()
  const navigate = useNavigate()
  const budget = useBudget(trip.id)
  const createEntry = useCreateBudgetEntry(trip.id, me.id)
  const updateItem = useUpdateItineraryItem(trip.id)
  const [pickerOpen, setPickerOpen] = React.useState(false)

  const linkedEntry = item.budget_entry_id
    ? budget.data?.find((e) => e.id === item.budget_entry_id)
    : undefined
  const busy = createEntry.isPending || updateItem.isPending

  // Nothing to show for an unlinked item with no cost — no trap, no clutter.
  if (!item.budget_entry_id && item.cost == null) return null

  function goToEntry() {
    if (item.budget_entry_id) {
      navigate(`/trip/${trip.id}/budget#${searchAnchorId(item.budget_entry_id)}`)
    }
  }

  async function addToBudget() {
    try {
      const entryId = await createEntry.mutateAsync(budgetDraftFromItinerary(item))
      await updateItem.mutateAsync({ id: item.id, budget_entry_id: entryId })
      toast.success('Added to the budget')
    } catch {
      // toasted by the mutation's onError
    }
  }

  function unlink() {
    updateItem.mutate(
      { id: item.id, budget_entry_id: null },
      { onSuccess: () => toast.success('Unlinked from the budget') }
    )
  }

  function linkExisting(entry: BudgetEntry) {
    updateItem.mutate(
      { id: item.id, budget_entry_id: entry.id },
      {
        onSuccess: () => {
          setPickerOpen(false)
          toast.success('Linked to the budget')
        },
      }
    )
  }

  return (
    <div className="relative z-20 mt-2 flex flex-wrap items-center gap-2">
      {item.budget_entry_id ? (
        <>
          <button
            type="button"
            onClick={goToEntry}
            data-tap-target
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full bg-primary-faint px-2.5 py-1',
              'text-xs font-medium text-primary transition-colors hover:bg-primary-soft'
            )}
          >
            <PiggyBank className="size-3.5 shrink-0" aria-hidden />
            <span>
              In budget
              {linkedEntry ? ` · ${formatMoney(entryAmount(linkedEntry), trip.currency)}` : ''}
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            data-tap-target
            disabled={busy}
            onClick={unlink}
          >
            <Link2Off /> Unlink
          </Button>
        </>
      ) : (
        <>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1',
              'text-xs font-medium text-muted'
            )}
          >
            {formatMoney(item.cost, trip.currency)}
            <span className="text-faint">· planning note, not in budget</span>
          </span>
          <Button
            variant="soft"
            size="sm"
            data-tap-target
            disabled={busy}
            onClick={addToBudget}
          >
            <Plus /> Add to budget
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-tap-target
            disabled={busy}
            onClick={() => setPickerOpen(true)}
          >
            <Link2 /> Link
          </Button>
        </>
      )}

      <LinkExpenseDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        entries={budget.data ?? []}
        onPick={linkExisting}
        disabled={busy}
      />
    </div>
  )
}

/**
 * Picks an existing budget entry to link to an itinerary item (#151) — the
 * "already logged this expense" path, so linking never creates a duplicate.
 */
function LinkExpenseDialog({
  open,
  onOpenChange,
  entries,
  onPick,
  disabled,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  entries: BudgetEntry[]
  onPick: (entry: BudgetEntry) => void
  disabled: boolean
}) {
  const { trip } = useTripContext()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link an existing expense</DialogTitle>
          <DialogDescription>
            Connect this item to a budget entry you’ve already logged, instead of
            adding it twice. Totals don’t change — nothing is counted again.
          </DialogDescription>
        </DialogHeader>
        {entries.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No expenses yet"
            description="Add an expense on the Budget page first, or use “Add to budget” to create one from this item’s cost."
          />
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(entry)}
                  data-tap-target
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                    'hover:bg-sunken disabled:pointer-events-none disabled:opacity-50'
                  )}
                >
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
      </DialogContent>
    </Dialog>
  )
}
