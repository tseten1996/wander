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
  CalendarArrowDown, GripVertical, MapPin, MoreHorizontal, Pencil, Plus,
  TriangleAlert, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { exportItineraryIcs } from '@/lib/export'
import {
  useCreateItineraryItem, useDeleteItineraryItem, useItinerary,
  useReorderItinerary, useUpdateItineraryItem, type ItineraryInput,
} from './api'
import { ITINERARY_META } from './meta'
import { overlapsByItem } from './overlap'
import { extractUrls, LinkChip, MapsChip } from './links'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, formatMoney, formatTime, isMobileViewport, longDate, positionBetween } from '@/lib/utils'
import { useTripWeather } from '@/hooks/useWeather'
import { describeWeather, type DailyWeather } from '@/lib/weather'
import type { ItineraryCategory, ItineraryItem } from '@/types'

const itinerarySchema = z
  .object({
    title: z.string().trim().min(1, 'Give it a title').max(120, 'Keep it under 120 characters'),
    category: z.enum(['flight', 'hotel', 'activity', 'restaurant', 'transport', 'free']),
    day: z.string().optional().nullable(),
    start_time: z.string().optional().nullable(),
    end_time: z.string().optional().nullable(),
    location: z.string().trim().max(160, 'Keep it under 160 characters').optional().nullable(),
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
}: {
  item: ItineraryItem
  conflicts?: ItineraryItem[]
}) {
  const { trip, me, isOwner } = useTripContext()
  const deleteItem = useDeleteItineraryItem(trip.id)
  const [editOpen, setEditOpen] = React.useState(false)
  const meta = ITINERARY_META[item.category]
  const canDelete = isOwner || item.created_by === me.id

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-80')}
    >
      <Card className="flex items-center gap-3 p-3.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none text-faint hover:text-muted active:cursor-grabbing"
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
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
            <Button variant="ghost" size="icon" aria-label="Itinerary item actions">
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

function DaySection({
  day,
  items,
  weather,
}: {
  day: string | null
  items: ItineraryItem[]
  weather?: DailyWeather
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
            {items.map((item) => (
              <SortableItemCard key={item.id} item={item} conflicts={conflicts.get(item.id)} />
            ))}
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
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  item?: ItineraryItem
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
              url: item.url ?? '',
              notes: item.notes ?? '',
              cost: item.cost ?? '',
            }
          : empty
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item])

  async function onSubmit(values: ItineraryFormValues) {
    const payload: ItineraryInput = {
      title: values.title.trim(),
      category: values.category as ItineraryCategory,
      day: values.day || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      location: values.location?.trim() || null,
      url: values.url?.trim() || null,
      notes: values.notes?.trim() || null,
      cost: values.cost === '' || values.cost == null ? null : Number(values.cost),
    }
    try {
      if (item) await updateItem.mutateAsync({ id: item.id, ...payload })
      else await createItem.mutateAsync(payload)
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
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {err.location && <p className="text-xs text-danger">{err.location.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="it-cost">Cost</Label>
              <Input
                id="it-cost"
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                placeholder="0"
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

export default function ItineraryPage() {
  const { trip } = useTripContext()
  const itinerary = useItinerary(trip.id)
  const weather = useTripWeather(trip)
  const [newOpen, setNewOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  const items = itinerary.data ?? []

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
            <Button onClick={() => setNewOpen(true)}>
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
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> Add the first item
            </Button>
          }
        />
      ) : (
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
            />
          ))}
        </motion.div>
      )}
      <ItemDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
