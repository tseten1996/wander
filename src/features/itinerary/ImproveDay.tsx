/*
  "Improve this day" — the preview card and the apply path (#213).

  The important thing about this file is how little it decides. The plan it
  renders was generated and validated on the server (src/server/ai/day.ts), the
  reason was either written by a model choosing between those plans or computed
  from them, and applying it goes through the same `useUpdateItineraryItem` a
  manual edit uses — so realtime, activity logging and optimistic updates
  behave exactly as they do when someone drags a row.

  Rejecting mutates nothing. There is no draft row, no pending state in the
  database, nothing to clean up: a rejected suggestion is a component that
  unmounts. That is asserted in tests/ai-day.test.mjs by construction — the
  apply call is the only place this module writes — and it is the property that
  makes the whole feature safe to try.
*/
import * as React from 'react'
import { z } from 'zod'
import { ArrowRight, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ItineraryItem } from '@/types'
import { useTripContext } from '@/hooks/useTrip'
import { callAi } from '@/features/ai/api'
import { useUpdateItineraryItem } from './api'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/misc'

/**
 * The endpoint's reply, re-validated in the browser.
 *
 * The handler already validated everything here. Re-checking is not distrust of
 * our own server so much as the cheapest guard against deploy skew: the app and
 * the Pages Function ship separately, so a shape change lands on one side
 * first, and this turns that window into a clean "couldn't work that out" toast
 * rather than `undefined` rendered into a card.
 */
const PlanAction = z.object({
  itemId: z.string(),
  title: z.string(),
  startTime: z.string(),
  endTime: z.string().nullable(),
})

const ImproveResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('nothing'),
    message: z.string(),
  }),
  z.object({
    status: z.literal('suggested'),
    reason: z.string(),
    reasonSource: z.enum(['model', 'computed']),
    plan: z.object({
      id: z.string(),
      actions: z.array(PlanAction).min(1),
      sequence: z.array(z.string()).min(1),
      order: z.array(z.string()),
      travelKm: z.number(),
      moved: z.number(),
      endsAt: z.string(),
    }),
    alternatives: z.number(),
    baseline: z.object({ travelKm: z.number(), conflicts: z.number() }),
    notes: z.array(z.string()),
  }),
])
type ImproveResult = z.infer<typeof ImproveResult>

/**
 * Ask the server what it would do with this day.
 *
 * Deliberately not a `useQuery`: this must never run because a component
 * mounted. A day is only looked at when someone taps, which is what keeps the
 * quota spent on requests people actually made.
 */
function useImproveDay(tripId: string) {
  const [state, setState] = React.useState<
    { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; result: ImproveResult }
  >({ phase: 'idle' })

  const ask = React.useCallback(
    async (day: string) => {
      setState({ phase: 'loading' })
      try {
        const response = await callAi({ intent: 'improve_day', tripId, day })
        if (!response.ok) {
          toast(response.message)
          setState({ phase: 'idle' })
          return
        }
        const parsed = ImproveResult.safeParse(response.result)
        if (!parsed.success) {
          toast('Couldn’t work that day out just now')
          setState({ phase: 'idle' })
          return
        }
        setState({ phase: 'done', result: parsed.data })
      } catch {
        // Offline, or the function is unreachable. The PWA works offline, so
        // this is an ordinary state and the day is unchanged either way.
        toast('Wander AI is unavailable right now')
        setState({ phase: 'idle' })
      }
    },
    [tripId],
  )

  return { state, ask, dismiss: () => setState({ phase: 'idle' }) }
}

/** `HH:MM:SS` from Postgres, or `HH:MM` from a plan, rendered as `HH:MM`. */
const hm = (t: string | null): string => (t ? t.slice(0, 5) : '')

/**
 * Apply one plan through the ordinary itinerary mutations.
 *
 * Times first, then positions, and both through `useUpdateItineraryItem` rather
 * than a bespoke batch write. It is slower than one round trip and that is the
 * trade: an approved suggestion is a set of edits the member could have made by
 * hand, so it should leave exactly the trail those edits would — same activity
 * entries, same realtime broadcast, same cache invalidation.
 */
async function applyPlan(
  update: ReturnType<typeof useUpdateItineraryItem>,
  plan: Extract<ImproveResult, { status: 'suggested' }>['plan'],
): Promise<void> {
  for (const action of plan.actions) {
    await update.mutateAsync({
      id: action.itemId,
      start_time: action.startTime,
      end_time: action.endTime,
    })
  }
  // The list is sorted by `position`, so the clock and the list would otherwise
  // disagree. Anchors are in this sequence too: they keep their times but their
  // place among the rows changes.
  for (const [index, id] of plan.sequence.entries()) {
    await update.mutateAsync({ id, position: index + 1 })
  }
}

/**
 * The day-header action and its preview card.
 *
 * Hidden below two items, which is the same floor the server enforces — a day
 * with one thing in it cannot be reordered, and offering to try would be an
 * invitation to spend a request on nothing.
 */
export function ImproveDayAction({
  day,
  dayLabel,
  items,
}: {
  day: string
  dayLabel: string
  items: ItineraryItem[]
}) {
  const { trip } = useTripContext()
  const { state, ask, dismiss } = useImproveDay(trip.id)
  const update = useUpdateItineraryItem(trip.id)
  const [applying, setApplying] = React.useState(false)

  if (items.length < 2) return null

  async function approve(plan: Extract<ImproveResult, { status: 'suggested' }>['plan']) {
    setApplying(true)
    try {
      await applyPlan(update, plan)
      toast.success('Day rearranged')
      dismiss()
    } catch {
      // useUpdateItineraryItem has already shown the failure. Leave the card
      // open so the member can see what was being attempted and retry.
    } finally {
      setApplying(false)
    }
  }

  if (state.phase !== 'done') {
    return (
      <div className="mb-3">
        <Button
          variant="secondary"
          size="sm"
          data-tap-target
          disabled={state.phase === 'loading'}
          onClick={() => ask(day)}
          aria-label={`Suggest a better order for ${dayLabel}`}
        >
          {state.phase === 'loading' ? <Spinner className="size-4" /> : <Sparkles aria-hidden />}
          Improve this day
        </Button>
      </div>
    )
  }

  if (state.result.status === 'nothing') {
    return (
      <Card className="mb-3 flex items-start gap-3 p-3">
        <p className="text-sm text-ink-soft">{state.result.message}</p>
        <Button variant="ghost" size="icon" className="ml-auto shrink-0" onClick={dismiss} aria-label="Dismiss">
          <X aria-hidden />
        </Button>
      </Card>
    )
  }

  const { plan, reason, reasonSource, baseline, alternatives, notes } = state.result
  const saved = baseline.travelKm - plan.travelKm
  const byId = new Map(items.map((i) => [i.id, i]))
  // Only the rows that actually move. A plan lists every movable item so the
  // apply step is one pass, but "09:00 → 09:00" in a preview is noise that
  // makes the real changes harder to find.
  const changes = plan.actions.filter((a) => hm(byId.get(a.itemId)?.start_time ?? null) !== a.startTime)

  return (
    <Card className="mb-3 space-y-3 p-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p className="text-sm text-ink">{reason}</p>
        <Button variant="ghost" size="icon" className="-mt-1 ml-auto shrink-0" onClick={dismiss} aria-label="Dismiss">
          <X aria-hidden />
        </Button>
      </div>

      <ul className="space-y-1">
        {changes.map((action) => {
          const before = byId.get(action.itemId)
          return (
            <li key={action.itemId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink-soft">{action.title}</span>
              <span className="shrink-0 tabular-nums text-faint line-through">
                {hm(before?.start_time ?? null)}
              </span>
              <ArrowRight className="size-3 shrink-0 text-faint" aria-hidden />
              <span className="shrink-0 font-medium tabular-nums text-ink">{action.startTime}</span>
            </li>
          )
        })}
      </ul>

      {/* Everything the suggestion is *not* sure about, in the same card as the
          suggestion. A caveat on another screen is a caveat nobody reads. */}
      <p className="text-xs text-faint">
        {saved >= 0.1 && <>Saves about {saved.toFixed(1)} km. </>}
        {alternatives > 0 && (
          <>
            {alternatives} other {alternatives === 1 ? 'order was' : 'orders were'} considered.{' '}
          </>
        )}
        {reasonSource === 'computed' && <>Chosen by score rather than by Wander AI. </>}
        {notes.join(' ')}
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={applying} onClick={() => approve(plan)}>
          {applying && <Spinner className="size-4 text-on-primary" />}
          Rearrange the day
        </Button>
        <Button variant="ghost" size="sm" disabled={applying} onClick={dismiss}>
          Keep it as it is
        </Button>
      </div>
    </Card>
  )
}
