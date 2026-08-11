import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTripContext } from '@/hooks/useTrip'
import {
  useCreateItineraryItem, useUpdateItineraryItem, type ItineraryInput,
} from './api'
import { ITINERARY_META } from './meta'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { AmountInput } from '@/components/ui/amount-input'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { isMobileViewport } from '@/lib/utils'
import { geocodeFirst } from '@/lib/geocode'
import { optionalAmount } from '@/lib/forms'
import type { ItineraryCategory, ItineraryItem } from '@/types'

const itinerarySchema = z
  .object({
    title: z.string().trim().min(1, 'Give it a title').max(120, 'Keep it under 120 characters'),
    category: z.enum(['flight', 'hotel', 'activity', 'restaurant', 'transport', 'free']),
    day: z.string().optional().nullable(),
    end_day: z.string().optional().nullable(),
    start_time: z.string().optional().nullable(),
    end_time: z.string().optional().nullable(),
    location: z.string().trim().max(160, 'Keep it under 160 characters').optional().nullable(),
    // Coordinates are never typed by hand — they come from selecting a place
    // suggestion, and are cleared when the location text is edited manually.
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    url: z
      .string()
      .trim()
      .max(2000, 'That link is too long')
      .optional()
      .nullable()
      .refine((v) => !v || /^https?:\/\/.+/i.test(v), {
        message: 'Must be a full http(s) link',
      }),
    notes: z.string().trim().max(2000, 'Keep it under 2000 characters').optional().nullable(),
    /*
      Blank must stay blank — every item saved without a cost used to store a
      real 0.00, which ItemBudgetLink then read as "has a cost" and decorated
      with a "not in budget yet" chip it never earned. See optionalAmount.
    */
    cost: optionalAmount({ negative: 'Cost can’t be negative' }),
  })
  // A closing day needs a start day to hang off, and can't precede it (#166).
  .refine((v) => !v.end_day || !!v.day, {
    message: 'Pick a start day first',
    path: ['end_day'],
  })
  .refine((v) => !v.end_day || !v.day || v.end_day >= v.day, {
    message: 'Ends before it starts',
    path: ['end_day'],
  })
  // The end time must follow the start time only within a single day; on a
  // multi-day span the end time lives on the later `end_day`, so check-out
  // 11:00 after a 15:00 check-in is valid and must not trip this rule.
  .refine(
    (v) =>
      (!!v.end_day && !!v.day && v.end_day > v.day) ||
      !v.start_time ||
      !v.end_time ||
      v.end_time >= v.start_time,
    { message: 'Ends before it starts', path: ['end_time'] }
  )

export type ItineraryFormValues = z.input<typeof itinerarySchema>

const CATEGORY_OPTIONS = Object.entries(ITINERARY_META) as [
  ItineraryCategory,
  (typeof ITINERARY_META)[ItineraryCategory],
][]

/**
 * The shared create/edit dialog for an itinerary item. It owns the single
 * itinerary write path (create + update mutations) and the #201 geocode-on-save
 * behaviour, so every entry point — the itinerary page, a pasted booking, a map
 * "nearby" pick, and the inspiration board's "Add to itinerary" (#204) — routes
 * through exactly this form rather than duplicating the mutation or the geocode.
 */
export function ItemDialog({
  open,
  onOpenChange,
  item,
  prefill,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item?: ItineraryItem
  /**
   * Create-mode seed values (from a pasted booking, issues 77 / 103, or an
   * inspiration idea, issue 204). Only the detected fields are present; the rest
   * fall back to the empty-form defaults. Ignored when editing an existing `item`.
   */
  prefill?: Partial<ItineraryFormValues>
  /**
   * Called after a successful *create* (never on edit). When provided, the
   * parent decides whether to close the dialog or advance to the next queued
   * draft (a flight/lodging paste yields two, confirmed one at a time, issue 103).
   */
  onCreated?: () => void
}) {
  const { trip, me } = useTripContext()
  const createItem = useCreateItineraryItem(trip.id, me.id)
  const updateItem = useUpdateItineraryItem(trip.id)

  const empty: ItineraryFormValues = {
    title: '',
    category: 'activity',
    day: trip.start_date,
    end_day: '',
    start_time: '',
    end_time: '',
    location: '',
    latitude: null,
    longitude: null,
    url: '',
    notes: '',
    cost: '',
  }
  const form = useForm<ItineraryFormValues>({
    resolver: zodResolver(itinerarySchema),
    defaultValues: empty,
  })

  React.useEffect(() => {
    if (open) {
      form.reset(
        item
          ? {
              title: item.title,
              category: item.category,
              day: item.day ?? '',
              end_day: item.end_day ?? '',
              start_time: item.start_time ?? '',
              end_time: item.end_time ?? '',
              location: item.location ?? '',
              latitude: item.latitude ?? null,
              longitude: item.longitude ?? null,
              url: item.url ?? '',
              notes: item.notes ?? '',
              cost: item.cost ?? '',
            }
          : { ...empty, ...prefill }
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, prefill])

  async function onSubmit(values: ItineraryFormValues) {
    const location = values.location?.trim() || null
    // Persist end_day only when it's a real span (a later day than the start);
    // an equal or empty end_day normalises to a plain single-day item.
    const day = values.day || null
    const end_day = day && values.end_day && values.end_day > day ? values.end_day : null
    // Coordinates only mean anything with a location; a cleared location drops
    // its pin rather than stranding stale coordinates on the map.
    let latitude = location ? values.latitude ?? null : null
    let longitude = location ? values.longitude ?? null : null
    // A typed address that was never confirmed via autocomplete (or one whose
    // text was edited after picking, which clears the pin) reaches here with a
    // location but no coordinates. Resolve it best-effort against the same
    // keyless Photon geocoder so it still pins — never blocking the save: a
    // miss, a timeout, or an unreachable geocoder just saves it unpinned, and
    // the user's typed text is always kept as the label.
    if (location && (latitude == null || longitude == null)) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      try {
        const hit = await geocodeFirst(location, controller.signal)
        if (hit) {
          latitude = hit.lat
          longitude = hit.lon
        }
      } catch {
        // Best-effort only — leave it unpinned on any failure or timeout.
      } finally {
        clearTimeout(timeout)
      }
    }
    const payload: ItineraryInput = {
      title: values.title.trim(),
      category: values.category as ItineraryCategory,
      day,
      end_day,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      location,
      latitude,
      longitude,
      url: values.url?.trim() || null,
      notes: values.notes?.trim() || null,
      // The schema already normalised blank/whitespace to null (see above), so
      // this only has to pass a real number through.
      cost: values.cost == null ? null : Number(values.cost),
    }
    try {
      if (item) {
        await updateItem.mutateAsync({ id: item.id, ...payload })
        onOpenChange(false)
      } else {
        await createItem.mutateAsync(payload)
        // On create, let the parent advance a multi-draft queue (or close);
        // fall back to closing when no queue handler is wired in.
        if (onCreated) onCreated()
        else onOpenChange(false)
      }
    } catch {
      // toasted by the mutation's onError
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? 'Edit itinerary item' : 'Add to itinerary'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="it-title">Title</Label>
            <Input
              id="it-title"
              placeholder="TeamLab Planets"
              autoFocus={!item && !isMobileViewport()}
              aria-invalid={err.title ? true : undefined}
              {...form.register('title')}
            />
            {err.title && <p className="text-xs text-danger">{err.title.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <div className="space-y-1.5">
              <Label htmlFor="it-day">Day</Label>
              <Controller
                control={form.control}
                name="day"
                render={({ field }) => (
                  <DateInput
                    id="it-day"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="it-end-day">End day</Label>
            <Controller
              control={form.control}
              name="end_day"
              render={({ field }) => (
                <DateInput
                  id="it-end-day"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  aria-invalid={err.end_day ? true : undefined}
                />
              )}
            />
            {err.end_day ? (
              <p className="text-xs text-danger">{err.end_day.message}</p>
            ) : (
              <p className="text-xs text-faint">
                Leave blank for a single day. Set it for a stay or pass that runs across nights.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="it-start">Starts</Label>
              <Input id="it-start" type="time" {...form.register('start_time')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="it-end">Ends</Label>
              <Input
                id="it-end"
                type="time"
                aria-invalid={err.end_time ? true : undefined}
                {...form.register('end_time')}
              />
              {err.end_time && <p className="text-xs text-danger">{err.end_time.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
            <div className="space-y-1.5">
              <Label htmlFor="it-loc">Location</Label>
              <Controller
                control={form.control}
                name="location"
                render={({ field }) => (
                  <PlaceAutocomplete
                    id="it-loc"
                    placeholder="Toyosu, Tokyo"
                    aria-invalid={err.location ? true : undefined}
                    value={field.value ?? ''}
                    onChange={(v) => {
                      field.onChange(v)
                      // Typing invalidates a previously-picked pin; selecting a
                      // suggestion re-sets it via onSelectPlace right after.
                      form.setValue('latitude', null)
                      form.setValue('longitude', null)
                    }}
                    onSelectPlace={(place) => {
                      form.setValue('latitude', place.lat)
                      form.setValue('longitude', place.lon)
                    }}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {err.location && <p className="text-xs text-danger">{err.location.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="it-cost">Cost</Label>
              <AmountInput
                id="it-cost"
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                placeholder="0"
                currency={trip.currency}
                aria-invalid={err.cost ? true : undefined}
                {...form.register('cost')}
              />
              {err.cost && <p className="text-xs text-danger">{err.cost.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="it-url">Link</Label>
            <Input
              id="it-url"
              inputMode="url"
              placeholder="https://teamlab.art/e/planets"
              aria-invalid={err.url ? true : undefined}
              {...form.register('url')}
            />
            {err.url && <p className="text-xs text-danger">{err.url.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="it-notes">Notes</Label>
            <Textarea
              id="it-notes"
              placeholder="Booking refs, links, what to bring…"
              className="min-h-16"
              aria-invalid={err.notes ? true : undefined}
              {...form.register('notes')}
            />
            {err.notes && <p className="text-xs text-danger">{err.notes.message}</p>}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {item ? 'Save changes' : 'Add item'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
