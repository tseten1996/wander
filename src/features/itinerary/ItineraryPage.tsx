import * as React from 'react'
import { motion } from '@/lib/motion'
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CalendarArrowDown, Car, ClipboardPaste, Footprints, GripVertical, List,
  Map as MapIcon, MapPin, MoreHorizontal, Navigation, Pencil, Plus, Sparkles,
  TriangleAlert, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { exportItineraryIcs } from '@/lib/export'
import {
  useCreateItineraryItem, useDeleteItineraryItem, useItinerary,
  useReorderItinerary,
} from './api'
import { ITINERARY_META } from './meta'
import { ItemDialog, type ItineraryFormValues } from './ItemDialog'
import { useDestinations } from '@/features/destinations/api'
import { groupDaysByLeg, hasLegs } from '@/features/destinations/legs'
import { buildDayIndex, type DayInfo } from './days'
import { buildDayDirections } from './directions'
import { onColor } from '@/lib/colors'
import { overlapsByItem } from './overlap'
import { coveredDays, isSpanning, spanPosition } from './spans'
import { parseReservation, type ParsedBooking, type ReservationParse } from './parse'
import { aiParseDisabled, useAiParseBooking } from './aiParse'
import { extractUrls, LinkChip, MapsChip } from './links'
import { ItemBudgetLink } from './BudgetLink'
import { searchAnchorId } from '@/features/search/anchor'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, dateRange, formatTime, isMobileViewport, longDate, positionBetween } from '@/lib/utils'
import { estimateLeg, formatLeg, toGeoPoint } from '@/lib/geo'
import { useTripWeather } from '@/hooks/useWeather'
import { useTempUnit } from '@/hooks/useTempUnit'
import { describeWeather, type DailyWeather } from '@/lib/weather'
import { formatTemp } from '@/lib/units'
import type { NearbyPlace } from '@/lib/places'
import type { Destination, ItineraryCategory, ItineraryItem } from '@/types'

// Leaflet + the map view load only when the Map tab is opened, keeping the
// map library out of the itinerary page's initial chunk (bundle budget).
const ItineraryMap = React.lazy(() => import('./ItineraryMap'))

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
      id={searchAnchorId(item.id)}
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
          <ItemBudgetLink item={item} />
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
                onClick={() =>
                  deleteItem.mutate(item.id, {
                    onSuccess: () => toast.success('Removed from itinerary'),
                  })
                }
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

/**
 * "Directions for this day" (#167) — hands the day's ordered, geocoded stops to
 * the phone's maps app as one multi-stop route, so a group can *follow* the day
 * instead of copying pins across one at a time. Purely a link over data we
 * already hold (`directions.ts`): the `<a target="_blank">` opens
 * google.com/maps/dir, which the OS intercepts into Google/Apple Maps — the same
 * keyless pattern as the per-item `MapsChip`. Hidden when the day has fewer than
 * two located stops (nothing to route); when some stops lack coordinates it says
 * how many made it in, so a partly-geocoded day is honest, never silently short.
 */
function DayDirectionsAction({ items, dayLabel }: { items: ItineraryItem[]; dayLabel: string }) {
  const directions = React.useMemo(() => buildDayDirections(items), [items])
  if (!directions) return null
  const { url, included, total, omitted } = directions
  const stops = included === 1 ? 'stop' : 'stops'
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button asChild variant="secondary" size="sm" data-tap-target>
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={
            `Open ${dayLabel} as a ${included}-${stops} route in Google Maps` +
            (omitted ? `; ${total - included} without a location left off` : '')
          }
        >
          <Navigation aria-hidden />
          Directions
        </a>
      </Button>
      {omitted && (
        <span className="text-xs text-faint" aria-hidden>
          {included} of {total} stops
        </span>
      )}
    </div>
  )
}

/**
 * A multi-day span (#166) rendered as a persistent band pinned atop each day it
 * covers — a lodging strip, a rail pass, a festival — rather than a single
 * draggable row on its start day only. It is deliberately outside the day's
 * sortable list and its leg-distance / overlap math (those are single-day
 * concerns): it just marks "this runs through today", showing where in the span
 * today falls and the check-in / check-out time on the edge days.
 */
function SpanBandCard({ item, day }: { item: ItineraryItem; day: string }) {
  const { trip, me, isOwner } = useTripContext()
  const deleteItem = useDeleteItineraryItem(trip.id)
  const [editOpen, setEditOpen] = React.useState(false)
  const meta = ITINERARY_META[item.category]
  const canDelete = isOwner || item.created_by === me.id

  const pos = spanPosition(item, day)
  const isFirst = pos?.index === 1
  const isLast = pos != null && pos.index === pos.total
  const isHotel = item.category === 'hotel'
  // Only the edge days carry a clock time: check-in on the first, check-out on
  // the last. The middle days of a stay have no time of their own.
  const edgeTime = isFirst ? item.start_time : isLast ? item.end_time : null
  const edgeLabel = isFirst
    ? isHotel ? 'Check-in' : 'Starts'
    : isLast
      ? isHotel ? 'Check-out' : 'Ends'
      : null

  const detail =
    [
      pos && `Day ${pos.index} of ${pos.total}`,
      edgeTime && edgeLabel ? `${edgeLabel} ${formatTime(edgeTime)}` : null,
      item.location,
    ]
      .filter(Boolean)
      .join(' · ') || meta.label

  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-sunken/60 px-3 py-2">
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', meta.chip)}>
        <meta.icon className="size-4.5" />
      </span>
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Edit ${item.title}`}
      >
        <p className="truncate text-sm font-semibold">{item.title}</p>
        <p className="truncate text-xs text-muted">{detail}</p>
      </button>
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
              onClick={() =>
                deleteItem.mutate(item.id, {
                  onSuccess: () => toast.success('Removed from itinerary'),
                })
              }
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ItemDialog open={editOpen} onOpenChange={setEditOpen} item={item} />
    </div>
  )
}

function DaySection({
  day,
  items,
  spanning,
  weather,
  dayInfo,
  selectedId,
  onSelect,
}: {
  day: string | null
  items: ItineraryItem[]
  /** Multi-day span items covering this day, shown as bands above the rows. */
  spanning: ItineraryItem[]
  weather?: DailyWeather
  /** Day number + colour, matching the map's pins/legend (absent when undated). */
  dayInfo?: DayInfo
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const { trip } = useTripContext()
  const reorder = useReorderItinerary(trip.id)
  const { unit } = useTempUnit()
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
        {(() => {
          // Spanning bands count toward the day's total so a gap day in the
          // middle of a stay never reads as "0 items".
          const count = items.length + spanning.length
          return (
            <span className="text-xs font-normal text-faint">
              {count} {count === 1 ? 'item' : 'items'}
            </span>
          )
        })()}
        {weather && (() => {
          const { label, Icon } = describeWeather(weather.code)
          const hi = formatTemp(weather.tempMax, unit)
          const lo = formatTemp(weather.tempMin, unit)
          return (
            <span
              className="ml-auto flex items-center gap-1 self-center rounded-full bg-sunken px-2 py-0.5 text-xs font-normal text-muted"
              title={`${label} · High ${hi} Low ${lo}`}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="tabular-nums">{hi} / {lo}</span>
              <span className="sr-only">{`${label}, high ${hi}, low ${lo}`}</span>
            </span>
          )
        })()}
      </h2>
      {/* Multi-day spans (#166) sit at the top of every day they cover, pinned
          above the day's own rows and outside the drag list. */}
      {day && spanning.length > 0 && (
        <div className="mb-3 space-y-2">
          {spanning.map((s) => (
            <SpanBandCard key={s.id} item={s} day={day} />
          ))}
        </div>
      )}
      {/* Route action for real days only — the "Not scheduled yet" bucket shares
          no actual day to navigate, exactly as the leg hints below are skipped. */}
      {day && <DayDirectionsAction items={items} dayLabel={longDate(day)} />}
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

/**
 * A leg header banding the days of one destination together (#197). Rendered
 * only when the trip has dated legs; days that fall in no leg's range group
 * under an "Unassigned" header so nothing is ever hidden.
 */
function LegHeader({ leg }: { leg: Destination | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line pb-1.5">
      <span className="flex items-center gap-1.5 font-display text-lg font-bold">
        <MapPin className="size-4 shrink-0 self-center text-primary" aria-hidden />
        {leg ? leg.name : 'Unassigned'}
      </span>
      {leg && (leg.start_date || leg.end_date) && (
        <span className="text-xs font-medium text-muted">{dateRange(leg.start_date, leg.end_date)}</span>
      )}
    </div>
  )
}

/** Keep only the fields the parser actually detected, so undetected ones fall
 *  through to the create form's own defaults (e.g. day = the trip start). */
function toPrefill(p: ParsedBooking): Partial<ItineraryFormValues> {
  const pf: Partial<ItineraryFormValues> = {}
  if (p.title) pf.title = p.title
  if (p.category) pf.category = p.category
  if (p.day) pf.day = p.day
  if (p.end_day) pf.end_day = p.end_day
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
 *
 * When the parser comes back empty it offers the model fallback (#212) instead
 * of closing. The offer is a *tap*, never automatic: the free path has to fail
 * first, and then the user has to ask, so a call is always something someone
 * chose. Declining, or the model failing, lands on exactly the behaviour this
 * dialog had before — the create form with the raw text in its notes.
 */
function PasteBookingDialog({
  open,
  onOpenChange,
  onParsed,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onParsed: (parsed: ReservationParse, viaAi?: boolean) => void
}) {
  const { trip } = useTripContext()
  const [text, setText] = React.useState('')
  // The heuristic result that came back empty, held so the fallback panel can
  // offer the model and still fall through to this exact draft if it declines.
  const [stuck, setStuck] = React.useState<ReservationParse | null>(null)
  const aiParse = useAiParseBooking()

  React.useEffect(() => {
    if (open) {
      setText('')
      setStuck(null)
    }
  }, [open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Year-less dates ("Jul 24") adopt the trip's own year, not today's, so a
    // trip in a different calendar year doesn't silently mis-date. Falls back
    // to the parser's wall-clock default when the trip has no start date.
    const referenceYear = trip.start_date
      ? new Date(trip.start_date).getFullYear()
      : undefined
    const parsed = parseReservation(text, referenceYear)
    // Nothing structured, and AI is available to ask: stay open and offer it.
    // Otherwise behave exactly as this dialog always has.
    if (!parsed.matched && !aiParseDisabled()) setStuck(parsed)
    else onParsed(parsed)
  }

  async function handleAskAi() {
    if (!stuck) return
    const outcome = await aiParse.mutateAsync({ tripId: trip.id, text, base: stuck.drafts[0] })
    if (outcome.status === 'parsed') {
      onParsed({ kind: 'generic', drafts: [outcome.booking], matched: true }, true)
      return
    }
    // 'empty' and every refusal converge here deliberately: to the person
    // pasting, "the model found nothing" and "the model was unavailable" have
    // the same next step, and the original draft is still exactly what they get.
    if (outcome.status === 'refused' && outcome.reason !== 'disabled') {
      toast(outcome.message)
    }
    onParsed(stuck)
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
        {stuck ? (
          <div className="space-y-4">
            <Card className="space-y-1 p-4">
              <p className="text-sm font-medium text-ink">
                Couldn&rsquo;t find a date, time, or place in that
              </p>
              <p className="text-sm text-ink-soft">
                Wander AI can have a closer read — it only sees the text above, and you
                still review everything before it&rsquo;s saved.
              </p>
            </Card>
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={handleAskAi}
              disabled={aiParse.isPending}
            >
              {aiParse.isPending ? <Spinner className="size-4 text-on-primary" /> : <Sparkles />}
              {aiParse.isPending ? 'Reading\u2026' : 'Let Wander read it'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="w-full"
              onClick={() => onParsed(stuck)}
              disabled={aiParse.isPending}
            >
              Fill it in myself
            </Button>
          </div>
        ) : (
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
        )}
      </DialogContent>
    </Dialog>
  )
}

export default function ItineraryPage() {
  const { trip, me } = useTripContext()
  const itinerary = useItinerary(trip.id)
  const destinations = useDestinations(trip.id).data ?? []
  const weather = useTripWeather(trip)
  // One-tap "Add to itinerary" from a Nearby map suggestion (#165). A found
  // place becomes a plain itinerary item — name + coordinates prefilled, day
  // defaulted to the trip start (editable afterwards like any other item), so
  // it immediately joins the pins, routing, and selection sync.
  const createSuggestion = useCreateItineraryItem(trip.id, me.id)
  const addNearby = React.useCallback(
    async (place: NearbyPlace) => {
      const category: ItineraryCategory = place.category === 'see' ? 'activity' : 'restaurant'
      try {
        await createSuggestion.mutateAsync({
          title: place.name,
          category,
          day: trip.start_date,
          end_day: null,
          start_time: null,
          end_time: null,
          location: place.name,
          latitude: place.lat,
          longitude: place.lon,
          url: null,
          notes: null,
          cost: null,
        })
        toast.success(`Added “${place.name}” to your itinerary`)
      } catch {
        // The mutation's onError already toasts the failure.
      }
    },
    [createSuggestion, trip.start_date],
  )
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

  function handleParsed(result: ReservationParse, viaAi = false) {
    setPrefillQueue(result.drafts.map(toPrefill))
    setPasteOpen(false)
    setNewOpen(true)
    if (!result.matched) {
      toast('Couldn’t read that automatically — added it to the notes')
    } else if (viaAi) {
      // Named as a read rather than a result: the model is more likely to be
      // wrong here than the regexes are, so the toast should send someone to
      // check the dates rather than tell them it worked.
      toast.success('Wander AI read it — check the dates before saving')
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

  // Multi-day spans (#166) render as bands across every day they cover, so they
  // are grouped separately from the single-day rows that fill each day's list.
  const spanItems = items.filter(isSpanning)
  const byDay = new Map<string | null, ItineraryItem[]>()
  for (const item of items) {
    if (isSpanning(item)) continue
    const key = item.day
    byDay.set(key, [...(byDay.get(key) ?? []), item])
  }
  // A day is shown when a single-day item is on it OR a span covers it — the
  // latter surfaces gap days in the middle of a stay that have no rows of their own.
  const datedDays = new Set<string>()
  for (const key of byDay.keys()) if (key) datedDays.add(key)
  for (const s of spanItems) for (const d of coveredDays(s)) datedDays.add(d)
  const sortedDatedDays = [...datedDays].sort((a, b) => a.localeCompare(b))
  const hasUndated = byDay.has(null) // undated bucket always sinks to the end
  // Group the dated days under their destination leg (#197). With no dated
  // legs this is a single headerless group of every day, so the list renders
  // exactly as before; with legs, days outside every range fall under an
  // "Unassigned" group. The undated bucket stays separate, below the legs.
  const legged = hasLegs(destinations)
  const legGroups = groupDaysByLeg(sortedDatedDays, destinations)
  // Which spans cover each day, precomputed once so DaySection stays a pure view.
  const spansByDay = new Map<string, ItineraryItem[]>()
  for (const s of spanItems) for (const d of coveredDays(s)) {
    spansByDay.set(d, [...(spansByDay.get(d) ?? []), s])
  }
  const renderDay = (day: string | null) => (
    <DaySection
      key={day ?? 'unscheduled'}
      day={day}
      items={byDay.get(day) ?? []}
      spanning={day ? spansByDay.get(day) ?? [] : []}
      weather={day ? weather.data?.get(day) : undefined}
      dayInfo={day ? dayIndex.get(day) : undefined}
      selectedId={selectedId}
      onSelect={toggleSelect}
    />
  )

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
              {legGroups.map((group) => (
                <div key={group.key} className="space-y-8">
                  {legged && <LegHeader leg={group.leg} />}
                  {group.days.map((day) => renderDay(day))}
                </div>
              ))}
              {hasUndated && renderDay(null)}
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
                onAddNearby={addNearby}
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
