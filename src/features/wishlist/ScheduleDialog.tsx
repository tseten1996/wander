import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { useCreateItineraryItem, type ItineraryInput } from '@/features/itinerary/api'
import { ITINERARY_META } from '@/features/itinerary/meta'
import { useRemoveScheduledWishlistItem } from './api'
import { itineraryCategoryFor, tripScheduleDays } from './schedule'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DateInput } from '@/components/ui/date-picker'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { ItineraryCategory, WishlistItem } from '@/types'

const scheduleSchema = z.object({
  day: z.string().min(1, 'Pick a day'),
  start_time: z.string().optional(),
  category: z.enum(['flight', 'hotel', 'activity', 'restaurant', 'transport', 'free']),
})

type ScheduleFormValues = z.input<typeof scheduleSchema>

const CATEGORY_OPTIONS = Object.entries(ITINERARY_META) as [
  ItineraryCategory,
  (typeof ITINERARY_META)[ItineraryCategory],
][]

/** "Day 3 · Wed, Oct 7" — the day number mirrors the itinerary's own Day-N
 *  numbering, with the weekday + date so a picker is readable at a glance. */
function dayOptionLabel(iso: string, index: number): string {
  return `Day ${index + 1} · ${format(parseISO(iso), 'EEE, MMM d')}`
}

/**
 * Schedule a saved wishlist place onto a day (#377, epic #164 slice 3) — the
 * last step of browse → save → plan. Reuses slice 1's add-to-itinerary create
 * path (no new table, no RLS change): confirming creates a normal
 * `itinerary_item` carrying the saved **name and coordinates** (plus any note /
 * link, which the removed shelf row would otherwise lose), so the place
 * immediately joins the pins / routing / weather it powers — no retyping.
 *
 * The two-step mutation is ordered so a scheduled item is never lost: the
 * itinerary insert runs first, and only on its success is the wishlist row
 * removed. A failed insert leaves the shelf entry untouched and toasts a
 * friendly error (via the create mutation); a failed cleanup after a successful
 * insert degrades quietly — the place is on the day, and the shelf row lingers
 * until the next wishlist mutation.
 *
 * Any member may schedule any member's saved place (the shelf is shared); the
 * created item is self-attributed to the scheduler by the existing itinerary
 * insert policy — no new RLS, no forged authorship.
 */
export function ScheduleDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item: WishlistItem | null
}) {
  const { trip, me } = useTripContext()
  const createItem = useCreateItineraryItem(trip.id, me.id)
  const removeScheduled = useRemoveScheduledWishlistItem(trip.id)

  // The trip's own days power a "Day N · date" picker; a dateless trip has no
  // days to enumerate, so the field falls back to a free date picker instead.
  const days = React.useMemo(
    () => tripScheduleDays(trip.start_date, trip.end_date),
    [trip.start_date, trip.end_date],
  )

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: { day: days[0] ?? '', start_time: '', category: 'activity' },
  })

  React.useEffect(() => {
    if (!open || !item) return
    form.reset({
      day: days[0] ?? trip.start_date ?? '',
      start_time: '',
      category: itineraryCategoryFor(item.category),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item])

  async function onSubmit(values: ScheduleFormValues) {
    if (!item) return
    const payload: ItineraryInput = {
      title: item.name,
      category: values.category as ItineraryCategory,
      day: values.day || null,
      end_day: null,
      start_time: values.start_time || null,
      end_time: null,
      // Carry the saved name as the location label too, so a pinned place keeps
      // a sensible marker title on the map.
      location: item.name,
      // Coordinates (if the place was saved from the map) carry over verbatim, so
      // it pins exactly where it was found; a hand-added place with no pin stays
      // unpinned, exactly as it was on the shelf.
      latitude: item.latitude ?? null,
      longitude: item.longitude ?? null,
      // Keep the note and link the shelf row held — removing the row would
      // otherwise discard them.
      url: item.url ?? null,
      notes: item.note ?? null,
      cost: null,
    }

    try {
      // Source of truth first: if this fails the shelf row is untouched and the
      // create mutation has already toasted a friendly error.
      await createItem.mutateAsync(payload)
    } catch {
      return
    }
    try {
      await removeScheduled.mutateAsync(item)
    } catch {
      // Degrade quietly — the item is scheduled; the row clears on the next
      // wishlist mutation. Never surface this as an error.
    }
    toast.success(`Added “${item.name}” to your itinerary`)
    onOpenChange(false)
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to a day</DialogTitle>
          <DialogDescription>
            {item
              ? `Schedule “${item.name}” onto a day — it joins the itinerary with its place and pin already filled in.`
              : 'Schedule this saved place onto a day.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-day">Day</Label>
            <Controller
              control={form.control}
              name="day"
              render={({ field }) =>
                days.length > 0 ? (
                  <Select value={field.value || undefined} onValueChange={field.onChange}>
                    <SelectTrigger id="schedule-day" aria-invalid={err.day ? true : undefined}>
                      <SelectValue placeholder="Pick a day" />
                    </SelectTrigger>
                    <SelectContent>
                      {days.map((d, i) => (
                        <SelectItem key={d} value={d}>
                          {dayOptionLabel(d, i)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <DateInput
                    id="schedule-day"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={err.day ? true : undefined}
                  />
                )
              }
            />
            {err.day && (
              <p className="text-xs text-danger" aria-live="polite">
                {err.day.message}
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-time">Time</Label>
              <Input id="schedule-time" type="time" {...form.register('start_time')} />
              <p className="text-xs text-faint">Optional — leave blank for a whenever stop.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Controller
                control={form.control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map(([value, meta]) => (
                        <SelectItem key={value} value={value}>
                          {meta.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            Add to day
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
