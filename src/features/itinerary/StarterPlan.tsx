/*
  "Suggest a starting point" — the blank-day preview card and its apply path (#284).

  The sibling of ImproveDay.tsx, one step earlier: that reorders a day that has
  items, this proposes a first few for a day that has none. It decides just as
  little. The places were fetched, ranked and (when a model runs) chosen on the
  server (src/server/ai/starter.ts); this renders that proposal and, only if a
  member approves, adds each place through the same `useCreateItineraryItem` a
  hand-added "nearby" suggestion uses — so a suggested day joins the pins,
  routing and activity feed exactly as a manually built one would.

  Rejecting mutates nothing. There is no draft row and nothing to clean up: a
  rejected suggestion is a component that unmounts. The apply call is the only
  place this module writes, which is the property tests/ai-starter.test.mjs
  asserts by construction and the reason the feature is safe to try on a blank day.
*/
import * as React from 'react'
import { z } from 'zod'
import { MapPin, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { AiUnavailableError, callAi } from '@/features/ai/api'
import { useCreateItineraryItem } from './api'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/misc'

/**
 * The endpoint's reply, re-validated in the browser.
 *
 * The handler already validated everything here; re-checking is the cheapest
 * guard against deploy skew, exactly as ImproveDay.tsx re-validates its own
 * result. The app and the Pages Function ship separately, so a shape change
 * lands on one side first — this turns that window into a clean toast rather than
 * `undefined` rendered into a card or, worse, an item created from it.
 */
const StarterItem = z.object({
  placeId: z.string(),
  name: z.string(),
  category: z.enum(['activity', 'restaurant']),
  startTime: z.string(),
  lat: z.number(),
  lon: z.number(),
})
type StarterItem = z.infer<typeof StarterItem>

const StarterResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('nothing'), message: z.string() }),
  z.object({
    status: z.literal('suggested'),
    reason: z.string(),
    reasonSource: z.enum(['model', 'computed']),
    placeName: z.string().nullable(),
    considered: z.number(),
    items: z.array(StarterItem).min(1),
  }),
])
type StarterResult = z.infer<typeof StarterResult>

/** `HH:MM:SS` or `HH:MM`, rendered as `HH:MM`. */
const hm = (t: string): string => t.slice(0, 5)

/**
 * Ask the server for a starting point for one day.
 *
 * Deliberately not a `useQuery`: it must never run because a component mounted.
 * A blank day is only looked at when someone taps, which is what keeps the quota
 * spent on requests people actually made.
 */
function useStarterPlan(tripId: string) {
  const [state, setState] = React.useState<
    { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; result: StarterResult }
  >({ phase: 'idle' })

  const ask = React.useCallback(
    async (day: string) => {
      setState({ phase: 'loading' })
      try {
        const response = await callAi({ intent: 'suggest_starter', tripId, day })
        if (!response.ok) {
          toast(response.message)
          setState({ phase: 'idle' })
          return
        }
        const parsed = StarterResult.safeParse(response.result)
        if (!parsed.success) {
          toast('Couldn’t work out a starting point just now')
          setState({ phase: 'idle' })
          return
        }
        setState({ phase: 'done', result: parsed.data })
      } catch (err) {
        toast(
          err instanceof AiUnavailableError ? err.message : 'Wander AI is unavailable right now',
        )
        setState({ phase: 'idle' })
      }
    },
    [tripId],
  )

  return { state, ask, dismiss: () => setState({ phase: 'idle' }) }
}

/**
 * The empty-day action and its preview card.
 *
 * Rendered by ItineraryPage only for a day that has no items — a day with items
 * gets "Improve this day" instead (#213), never both. The button is the whole
 * affordance until it is tapped; the card appears in place once the server
 * answers.
 */
export function StarterPlanAction({ day, dayLabel }: { day: string; dayLabel: string }) {
  const { trip, me } = useTripContext()
  const { state, ask, dismiss } = useStarterPlan(trip.id)
  const create = useCreateItineraryItem(trip.id, me.id)
  const [applying, setApplying] = React.useState(false)

  /**
   * Add each suggested place through the ordinary itinerary create.
   *
   * Sequential on purpose: `useCreateItineraryItem` stamps `position` from the
   * clock, so awaiting each insert in turn keeps the places in the order the
   * suggestion put them. Every add leaves exactly the trail a hand-added place
   * would — same activity entry, same realtime broadcast, same invalidation.
   */
  async function apply(items: StarterItem[]) {
    setApplying(true)
    try {
      for (const item of items) {
        await create.mutateAsync({
          title: item.name,
          category: item.category,
          day,
          end_day: null,
          start_time: hm(item.startTime),
          end_time: null,
          location: item.name,
          latitude: item.lat,
          longitude: item.lon,
          url: null,
          notes: null,
          cost: null,
        })
      }
      toast.success(`Added ${items.length} ${items.length === 1 ? 'place' : 'places'} to ${dayLabel}`)
      dismiss()
    } catch {
      // useCreateItineraryItem has already toasted the failure. Leave the card
      // open so the member can see what was being added and retry — the ones
      // that did land stay, exactly as they would if added by hand.
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
          aria-label={`Suggest a starting point for ${dayLabel}`}
        >
          {state.phase === 'loading' ? <Spinner className="size-4" /> : <Sparkles aria-hidden />}
          Suggest a starting point
        </Button>
      </div>
    )
  }

  if (state.result.status === 'nothing') {
    return (
      <Card className="mb-3 flex items-start gap-3 p-3">
        <p className="text-sm text-ink-soft">{state.result.message}</p>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <X aria-hidden />
        </Button>
      </Card>
    )
  }

  const { items, reason, reasonSource, considered } = state.result

  return (
    <Card className="mb-3 space-y-3 p-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p className="text-sm text-ink">{reason}</p>
        <Button
          variant="ghost"
          size="icon"
          className="-mt-1 ml-auto shrink-0"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <X aria-hidden />
        </Button>
      </div>

      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.placeId} className="flex items-center gap-2 text-sm">
            <span className="shrink-0 tabular-nums font-medium text-ink">{hm(item.startTime)}</span>
            <MapPin className="size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink-soft">{item.name}</span>
          </li>
        ))}
      </ul>

      {/* What the suggestion is honest about, in the same card as the suggestion:
          where the places came from and that the times are a starting point. */}
      <p className="text-xs text-faint">
        Chosen from {considered} nearby {considered === 1 ? 'place' : 'places'}.{' '}
        {reasonSource === 'computed' && <>Picked by the app rather than Wander AI. </>}
        Add these, then edit the times or swap anything.
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={applying} onClick={() => apply(items)}>
          {applying && <Spinner className="size-4 text-on-primary" />}
          Add to this day
        </Button>
        <Button variant="ghost" size="sm" disabled={applying} onClick={dismiss}>
          Not now
        </Button>
      </div>
    </Card>
  )
}
