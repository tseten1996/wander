import * as React from 'react'
import { motion } from 'framer-motion'
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  CalendarArrowDown, Car, ClipboardPaste, Footprints, GripVertical, List,
  Map as MapIcon, MapPin, MoreHorizontal, Pencil, Plus, TriangleAlert, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { exportItineraryIcs } from '@/lib/export'
import {
  useCreateItineraryItem, useDeleteItineraryItem, useItinerary,
  useReorderItinerary, useUpdateItineraryItem, type ItineraryInput,
} from './api'
import { ITINERARY_META } from './meta'
import { buildDayIndex, type DayInfo } from './days'
import { onColor } from '@/lib/colors'
import { overlapsByItem } from './overlap'
import { parseReservation, type ParsedBooking, type ReservationParse } from './parse'
import { extractUrls, LinkChip, MapsChip } from './links'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { AmountInput } from '@/components/ui/amount-input'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, formatMoney, formatTime, isMobileViewport, longDate, positionBetween } from '@/lib/utils'
import { estimateLeg, formatLeg, toGeoPoint } from '@/lib/geo'
import { useTripWeather } from '@/hooks/useWeather'
import { describeWeather, type DailyWeather } from '@/lib/weather'
import type { ItineraryCategory, ItineraryItem } from '@/types'

// Leaflet + the map view load only when the Map tab is opened, keeping the
// map library out of the itinerary page's initial chunk (bundle budget).
const ItineraryMap = React.lazy(() => import('./ItineraryMap'))

const itinerarySchema = z
  .object({
    title: z.string().trim().min(1, 'Give it a title').max(120, 'Keep it under 120 characters'),
    category: z.enum(['flight', 'hotel', 'activity', 'restaurant', 'transport', 'free']),
    day: z.string().optional().nullable(),
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
    cost: z.coerce
      .number({ invalid_type_error: 'Enter a number' })
      .min(0, 'Cost can’t be negative')
      .optional()
      .nullable()
      .or(z.literal('')),
  })
  .refine((v) => !v.start_time || !v.end_time || v.end_time >= v.start_time, {
    message: 'Ends before it starts',
    path: ['end_time'],
  })

type ItineraryFormValues = z.input<typeof itinerarySchema>

/** "Lunch (3:00 PM – 4:00 PM)" — names a conflicting item with its time. */
function conflictLabel(item: ItineraryItem): string {
  const range = item.end_time
    ? `${formatTime(item.start_time)} – ${formatTime(item.end_time)}`
    : formatTime(item.start_time)
  return range ? `${item.title} (${range})` : item.title
}

function SortableItemCard({
  item,
  conflicts,
  selected,
  onSelect,
}: {
  item: ItineraryItem
  conflicts?: ItineraryItem[]
  /** True when this item is the shared list↔map selection. */
  selected: boolean
  /** Toggle this item as the shared selection (used to sync with the map). */
  onSelect: (id: string) => void
}) {
  const { trip, me, isOwner } = useTripContext()
  const deleteItem = useDeleteItineraryItem(trip.id)
  const [editOpen, setEditOpen] = React.useState(false)
  const meta = ITINERARY_META[item.category]
  const canDelete = isOwner || item.created_by === me.id

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id })

  // Compose the dnd node ref with a local one so we can scroll this row into
  // view when it becomes the selection (e.g. after selecting its pin on the map
  // and switching back to the List tab).
  const rowRef = React.useRef<HTMLDivElement | null>(null)
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el
      setNodeRef(el)
    },
    [setNodeRef]
  )
  React.useEffect(() => {
    if (!selected || !rowRef.current) return
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    rowRef.current.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  }, [selected])

  return (
    <div
      ref={setRefs}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-80')}
    >
      <Card
        className={cn(
          'flex items-center gap-3 p-3.5',
          selected && 'ring-2 ring-primary'
        )}
      >
        {/* Transparent overlay makes the whole card a "select / show on map"
            target. It sits above the passive title/meta but below the real
            controls (grip, links, menu) which are raised to z-20 so they stay
            independently clickable — a valid alternative to nesting buttons. */}
        <button
          type="button"
          onClick={() => onSelect(item.id)}
          aria-pressed={selected}
          aria-label={`${selected ? 'Deselect' : 'Show'} ${item.title} on the map`}
          className="absolute inset-0 z-10 rounded-[inherit]"
        />
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="relative z-20 cursor-grab touch-none text-faint hover:text-muted active:cursor-grabbing"
          aria-label={`Reorder ${item.title}`}
        >
          <GripVertical className="size-4" />
        </button>
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', meta.chip)}>
          <meta.icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{item.title}</p>
          <p className="truncate text-xs text-muted">
            {[
              item.start_time &&
                `${formatTime(item.start_time)}${item.end_time ? ` – ${formatTime(item.end_time)}` : ''}`,
              item.location,
              item.cost != null ? formatMoney(item.cost, trip.currency) : null,
            ]
              .filter(Boolean)
              .join(' · ') || meta.label}
          </p>
          {item.notes && <p className="mt-0.5 truncate text-xs text-faint">{item.notes}</p>}
          {(() => {
            // Explicit url field first, then any URLs pasted into title/notes.
            const urls = [...new Set(
              [item.url, ...extractUrls(item.title), ...extractUrls(item.notes)]
                .filter((u): u is string => !!u)
            )]
            if (urls.length === 0 && !item.location) return null
            return (
              <span className="relative z-20 mt-1.5 flex flex-wrap items-center gap-1.5">
                {urls.map((u) => <LinkChip key={u} url={u} />)}
                {item.location && <MapsChip location={item.location} />}
              </span>
            )
          })()}
          {conflicts && conflicts.length > 0 && (
            <p className="mt-1.5 flex items-start gap-1 text-xs text-danger" role="note">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Overlaps with {conflicts.map(conflictLabel).join(', ')}
              </span>
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative z-20"
              aria-label="Itinerary item actions"
            >
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
                  deleteItem.mutate(item.id)
                  toast.success('Removed from itinerary')
                }}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Card>
      <ItemDialog open={editOpen} onOpenChange={setEditOpen} item={item} />
    </div>
  )
}

/**
 * The connector between two consecutive same-day stops, showing a rough
 * straight-line distance and travel time (issue 123, Map epic slice 3). Rendered
 * only when *both* stops carry coordinates — an unlocated stop simply produces
 * no hint, never a fabricated one. The estimate is pure client compute
 * (haversine + a coarse walk/drive speed), so it can't rate-limit or fail; the
 * "~" makes the approximation explicit. Reordering re-renders the list, which
 * recomputes each affected leg for free.
 */
function LegHint({ from, to }: { from: ItineraryItem; to: ItineraryItem }) {
  const leg = React.useMemo(() => {
    const a = toGeoPoint(from)
    const b = toGeoPoint(to)
    return a && b ? estimateLeg(a, b) : null
  }, [from, to])
  if (!leg) return null
  const { distance, duration } = formatLeg(leg)
  const Icon = leg.mode === 'walk' ? Footprints : Car
  return (
    <p
      className="flex items-center gap-1.5 pl-4 text-xs text-faint"
      aria-label={`About ${distance} and ${duration} ${
        leg.mode === 'walk' ? 'walking' : 'driving'
      } to the next stop`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span aria-hidden>~{distance} · ~{duration}</span>
    </p>
  )
}

function DaySection({
  day,
  items,
  weather,
  dayInfo,
  selectedId,
  onSelect,
}: {
  day: string | null
  items: ItineraryItem[]
  weather?: DailyWeather
  /** Day number + colour, matching the map's pins/legend (absent when undated). */
  dayInfo?: DayInfo
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const { trip } = useTripContext()
  const reorder = useReorderItinerary(trip.id)
  // Same-day timed items whose intervals intersect are flagged inline. Skipped
  // for the "Not scheduled yet" bucket, where items share no actual day.
  const conflicts = React.useMemo(
    () => (day ? overlapsByItem(items) : new Map<string, ItineraryItem[]>()),
    [day, items]
  )
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    // Keyboard alternative to drag (#44): focus a grip handle, Space/Enter
    // picks the item up, arrows move it, Space drops, Escape cancels.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = items.findIndex((i) => i.id === active.id)
    const overIndex = items.findIndex((i) => i.id === over.id)
    if (oldIndex < 0 || overIndex < 0) return
    // New position = midpoint of the neighbours in the final ordering
    const finalOrder = arrayMove(items, oldIndex, overIndex)
    const idx = finalOrder.findIndex((i) => i.id === active.id)
    const prev = finalOrder[idx - 1] ?? null
    const next = finalOrder[idx + 1] ?? null
    reorder.mutate({
      id: String(active.id),
      position: positionBetween(prev?.position ?? null, next?.position ?? null),
    })
  }

  return (
    <section>
      <h2 className="mb-2.5 flex items-baseline gap-2 font-display text-base font-semibold">
        {dayInfo && (
          <span
            className="flex size-5 shrink-0 items-center justify-center self-center rounded-full text-[10px] font-bold"
            style={{ backgroundColor: dayInfo.color, color: onColor(dayInfo.color) }}
            title={dayInfo.label}
          >
            {dayInfo.number}
            <span className="sr-only">{dayInfo.label}</span>
          </span>
        )}
        {day ? longDate(day) : 'Not scheduled yet'}
        <span className="text-xs font-normal text-faint">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
        {weather && (() => {
          const { label, Icon } = describeWeather(weather.code)
          const hi = Math.round(weather.tempMax)
          const lo = Math.round(weather.tempMin)
          return (
            <span
              className="ml-auto flex items-center gap-1 self-center rounded-full bg-sunken px-2 py-0.5 text-xs font-normal text-muted"
              title={`${label} · High ${hi}° Low ${lo}°`}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="tabular-nums">{hi}° / {lo}°</span>
              <span className="sr-only">{`${label}, high ${hi} degrees, low ${lo} degrees`}</span>
            </span>
          )
        })()}
      </h2>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map((item, i) => {
              const next = items[i + 1]
              return (
                <React.Fragment key={item.id}>
                  <SortableItemCard
                    item={item}
                    conflicts={conflicts.get(item.id)}
                    selected={item.id === selectedId}
                    onSelect={onSelect}
                  />
                  {/* Leg to the next stop — only within a real day, never in the
                      "Not scheduled yet" bucket where rows share no actual day. */}
                  {day && next && <LegHint from={item} to={next} />}
                </React.Fragment>
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
}

const CATEGORY_OPTIONS = Object.entries(ITINERARY_META) as [
  ItineraryCategory,
  (typeof ITINERARY_META)[ItineraryCategory],
][]

function ItemDialog({
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
   * Create-mode seed values (from a pasted booking, issues 77 / 103). Only the
   * detected fields are present; the rest fall back to the empty-form defaults.
   * Ignored when editing an existing `item`.
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
    const payload: ItineraryInput = {
      title: values.title.trim(),
      category: values.category as ItineraryCategory,
      day: values.day || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      location,
      // Coordinates only mean anything with a location; a cleared location
      // drops its pin rather than stranding stale coordinates on the map.
      latitude: location ? values.latitude ?? null : null,
      longitude: location ? values.longitude ?? null : null,
      url: values.url?.trim() || null,
      notes: values.notes?.trim() || null,
      cost: values.cost === '' || values.cost == null ? null : Number(values.cost),
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

/** Keep only the fields the parser actually detected, so undetected ones fall
 *  through to the create form's own defaults (e.g. day = the trip start). */
function toPrefill(p: ParsedBooking): Partial<ItineraryFormValues> {
  const pf: Partial<ItineraryFormValues> = {}
  if (p.title) pf.title = p.title
  if (p.category) pf.category = p.category
  if (p.day) pf.day = p.day
  if (p.start_time) pf.start_time = p.start_time
  if (p.end_time) pf.end_time = p.end_time
  if (p.location) pf.location = p.location
  if (p.notes) pf.notes = p.notes
  return pf
}

/**
 * Paste-a-booking entry point (#77). Collects raw confirmation text and hands
 * it to the heuristic parser; the caller opens the pre-filled create form. This
 * dialog never saves anything itself — it only prepares the form.
 */
function PasteBookingDialog({
  open,
  onOpenChange,
  onParsed,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onParsed: (parsed: ReservationParse) => void
}) {
  const { trip } = useTripContext()
  const [text, setText] = React.useState('')

  React.useEffect(() => {
    if (open) setText('')
  }, [open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Year-less dates ("Jul 24") adopt the trip's own year, not today's, so a
    // trip in a different calendar year doesn't silently mis-date. Falls back
    // to the parser's wall-clock default when the trip has no start date.
    const referenceYear = trip.start_date
      ? new Date(trip.start_date).getFullYear()
      : undefined
    onParsed(parseReservation(text, referenceYear))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paste a booking</DialogTitle>
          <DialogDescription>
            Paste a flight, hotel, or restaurant confirmation and we&rsquo;ll pre-fill a new
            itinerary item with whatever we can read. You review and confirm before it&rsquo;s saved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="paste-booking">Confirmation text</Label>
            <Textarea
              id="paste-booking"
              className="min-h-40"
              autoFocus={!isMobileViewport()}
              placeholder={
                'Paste here, e.g.\n\nFlight confirmation — United UA 837\nDeparts July 24, 2026 at 10:30 AM\nSFO to NRT'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={!text.trim()}>
            Review pre-filled item
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function ItineraryPage() {
  const { trip } = useTripContext()
  const itinerary = useItinerary(trip.id)
  const weather = useTripWeather(trip)
  const [newOpen, setNewOpen] = React.useState(false)
  const [pasteOpen, setPasteOpen] = React.useState(false)
  // A pasted booking can produce several drafts (a flight that lands past
  // midnight, or a hotel's check-in + check-out — issue 103). They're confirmed one
  // at a time in the create form: the head of this queue seeds the open dialog,
  // and each successful create shifts it until the queue drains.
  const [prefillQueue, setPrefillQueue] = React.useState<Partial<ItineraryFormValues>[]>([])
  const prefill = prefillQueue[0]
  const [exporting, setExporting] = React.useState(false)
  // Selecting a pin (or an unlocated row) in the Map view opens this item for
  // editing — the map has no cards of its own to host a per-item dialog.
  const [editItem, setEditItem] = React.useState<ItineraryItem | null>(null)
  // The one item highlighted across the List and Map tabs (map epic slice 2).
  // A pin click sets it; a list row toggles it; both views sync to this value.
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const toggleSelect = React.useCallback(
    (id: string) => setSelectedId((cur) => (cur === id ? null : id)),
    []
  )

  function openBlankCreate() {
    setPrefillQueue([])
    setNewOpen(true)
  }

  function handleParsed(result: ReservationParse) {
    setPrefillQueue(result.drafts.map(toPrefill))
    setPasteOpen(false)
    setNewOpen(true)
    if (!result.matched) {
      toast('Couldn’t read that automatically — added it to the notes')
    } else if (result.drafts.length > 1) {
      toast.success(`Found ${result.drafts.length} items — review and save each`)
    } else {
      toast.success('Filled in what we found — review and save')
    }
  }

  // Advance the draft queue after a successful create: keep the dialog open and
  // re-seed it with the next draft, or close once the last one is saved.
  function handleItemCreated() {
    // Keep the setPrefillQueue updater pure; drive the dialog side effect from
    // the already-current queue in this closure (React may double-invoke the
    // updater in dev Strict Mode, so a setState inside it can misfire).
    const rest = prefillQueue.slice(1)
    setPrefillQueue(rest)
    if (rest.length === 0) setNewOpen(false)
  }

  const items = itinerary.data ?? []
  // Day -> {number, colour, label}, shared by the list day-headers and the
  // map's pins + legend so both speak the same "Day N" language.
  const dayIndex = React.useMemo(() => buildDayIndex(items), [items])

  async function exportCalendar() {
    setExporting(true)
    try {
      const count = await exportItineraryIcs(trip.id, trip.name)
      if (count === 0) toast('Add a day to itinerary items to export them to a calendar')
      else toast.success(`Exported ${count} ${count === 1 ? 'event' : 'events'} to calendar`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not export the calendar')
    } finally {
      setExporting(false)
    }
  }

  const byDay = new Map<string | null, ItineraryItem[]>()
  for (const item of items) {
    const key = item.day
    byDay.set(key, [...(byDay.get(key) ?? []), item])
  }
  const days = [...byDay.keys()].sort((a, b) => {
    if (a === null) return 1
    if (b === null) return -1
    return a.localeCompare(b)
  })

  return (
    <div>
      <PageHeader
        title="Itinerary"
        description="Your trip, day by day. Drag to reorder within a day."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={exportCalendar}
              disabled={exporting || items.length === 0}
              aria-label="Export itinerary to a calendar file"
            >
              <CalendarArrowDown /> Export
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPasteOpen(true)}
              aria-label="Paste a booking confirmation"
            >
              <ClipboardPaste />
              {/* Short label below the app's md breakpoint (768px, the same
                  mobile/desktop boundary as isMobileViewport) so the
                  three-action row never overflows a 375px header. */}
              <span className="md:hidden">Paste</span>
              <span className="hidden md:inline">Paste a booking</span>
            </Button>
            <Button onClick={openBlankCreate}>
              <Plus /> Add item
            </Button>
          </div>
        }
      />
      {itinerary.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : itinerary.isError ? (
        <ErrorState onRetry={() => itinerary.refetch()} isRetrying={itinerary.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="The itinerary is empty"
          description="Add flights, stays, restaurants and activities — they'll organize themselves by day."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={openBlankCreate}>
                <Plus /> Add the first item
              </Button>
              <Button variant="secondary" onClick={() => setPasteOpen(true)}>
                <ClipboardPaste /> Paste a booking
              </Button>
            </div>
          }
        />
      ) : (
        <Tabs defaultValue="list">
          <TabsList className="mb-5">
            <TabsTrigger value="list">
              <List className="size-4" /> List
            </TabsTrigger>
            <TabsTrigger value="map">
              <MapIcon className="size-4" /> Map
            </TabsTrigger>
          </TabsList>
          <TabsContent value="list">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-8"
            >
              {days.map((day) => (
                <DaySection
                  key={day ?? 'unscheduled'}
                  day={day}
                  items={byDay.get(day)!}
                  weather={day ? weather.data?.get(day) : undefined}
                  dayInfo={day ? dayIndex.get(day) : undefined}
                  selectedId={selectedId}
                  onSelect={toggleSelect}
                />
              ))}
            </motion.div>
          </TabsContent>
          <TabsContent value="map">
            <React.Suspense fallback={<Skeleton className="h-[22rem] rounded-2xl sm:h-[28rem]" />}>
              <ItineraryMap
                items={items}
                dayIndex={dayIndex}
                selectedId={selectedId}
                onSelectItem={setSelectedId}
                onOpenItem={setEditItem}
              />
            </React.Suspense>
          </TabsContent>
        </Tabs>
      )}
      <PasteBookingDialog open={pasteOpen} onOpenChange={setPasteOpen} onParsed={handleParsed} />
      <ItemDialog
        open={newOpen}
        // Closing (Escape/backdrop/last save) abandons any remaining drafts so
        // a half-confirmed queue never lingers into the next create.
        onOpenChange={(o) => {
          setNewOpen(o)
          if (!o) setPrefillQueue([])
        }}
        prefill={prefill}
        onCreated={handleItemCreated}
      />
      <ItemDialog
        open={editItem !== null}
        onOpenChange={(o) => !o && setEditItem(null)}
        item={editItem ?? undefined}
      />
    </div>
  )
}
