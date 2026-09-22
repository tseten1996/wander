import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ArrowRight, Bus, Car, Check, Copy, ExternalLink, KeyRound, Pencil, Plane,
  Plus, Route, Ship, TrainFront, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useCreateTransport, useDeleteTransport, useTransport, useUpdateTransport,
  type TransportInput,
} from './api'
// The booking-URL sanitizer is shared with Stays rather than copied a third time
// (per the #350 build note; the consolidation of these helpers is tracked in
// #354). An `href` is a capability, so a member-supplied link is only ever
// rendered when it is a real http(s) URL — `javascript:`/`data:` are rejected.
import { safeHttpUrl } from '@/features/stays/StaysCard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Skeleton, ErrorState } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { formatTime } from '@/lib/utils'
import type { Transport, TransportMode } from '@/types'

/** The five modes, in display order, with their icon and label. Single source
 *  for the select options, the card icon, the readable mode name, and the
 *  calendar surface (which imports `MODE_MAP` to render a hop's mode). */
export const MODES: { value: TransportMode; label: string; Icon: typeof Plane }[] = [
  { value: 'flight', label: 'Flight', Icon: Plane },
  { value: 'train', label: 'Train', Icon: TrainFront },
  { value: 'bus', label: 'Bus', Icon: Bus },
  { value: 'car', label: 'Car', Icon: Car },
  { value: 'ferry', label: 'Ferry', Icon: Ship },
]
export const MODE_MAP = Object.fromEntries(MODES.map((m) => [m.value, m])) as Record<
  TransportMode,
  (typeof MODES)[number]
>

const transportSchema = z
  .object({
    mode: z.enum(['flight', 'train', 'bus', 'car', 'ferry']),
    depart_place: z.string().trim().max(120, 'Keep it under 120 characters').optional(),
    arrive_place: z.string().trim().max(120, 'Keep it under 120 characters').optional(),
    // Wall-clock datetimes from the native <input type="datetime-local">, kept as
    // the `YYYY-MM-DDTHH:mm` string the control emits (no timezone). '' = unset.
    depart_at: z.string().optional(),
    arrive_at: z.string().optional(),
    confirmation_code: z.string().trim().max(120, 'Keep it under 120 characters').optional(),
    booking_url: z
      .string()
      .trim()
      .max(2000, 'That link is too long')
      .optional()
      .refine((v) => !v || safeHttpUrl(v) !== null, {
        message: 'Enter a full http(s) link, or leave it blank',
      }),
  })
  .refine((v) => !v.depart_at || !v.arrive_at || v.arrive_at >= v.depart_at, {
    message: 'Arrival is before departure',
    path: ['arrive_at'],
  })

type TransportFormValues = z.input<typeof transportSchema>

const EMPTY: TransportFormValues = {
  mode: 'flight', depart_place: '', arrive_place: '',
  depart_at: '', arrive_at: '', confirmation_code: '', booking_url: '',
}

/** The datetime as the `datetime-local` control wants it (`YYYY-MM-DDTHH:mm`);
 *  the stored value may carry trailing seconds, which the control drops. */
function toLocalInput(dt: string | null | undefined): string {
  return dt ? dt.slice(0, 16) : ''
}

/** Add / edit a single transport hop. Mode is required; everything else is
 *  optional so a half-known hop ("we're taking a train, time TBD") still saves. */
function TransportDialog({
  open, onOpenChange, hop,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  hop?: Transport
}) {
  const { trip, me } = useTripContext()
  const create = useCreateTransport(trip.id, me.id)
  const update = useUpdateTransport(trip.id, me.id)

  const form = useForm<TransportFormValues>({
    resolver: zodResolver(transportSchema),
    defaultValues: EMPTY,
  })

  React.useEffect(() => {
    if (!open) return
    form.reset(
      hop
        ? {
            mode: hop.mode,
            depart_place: hop.depart_place ?? '',
            arrive_place: hop.arrive_place ?? '',
            depart_at: toLocalInput(hop.depart_at),
            arrive_at: toLocalInput(hop.arrive_at),
            confirmation_code: hop.confirmation_code ?? '',
            booking_url: hop.booking_url ?? '',
          }
        : EMPTY
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hop])

  async function onSubmit(values: TransportFormValues) {
    const payload: TransportInput = {
      mode: values.mode,
      depart_place: values.depart_place?.trim() || null,
      arrive_place: values.arrive_place?.trim() || null,
      depart_at: values.depart_at || null,
      arrive_at: values.arrive_at || null,
      confirmation_code: values.confirmation_code?.trim() || null,
      // Store only a sanitized http(s) link (or null); the schema already
      // rejected anything else, this is the defensive normalisation on save.
      booking_url: safeHttpUrl(values.booking_url),
    }
    try {
      if (hop) await update.mutateAsync({ id: hop.id, ...payload })
      else await create.mutateAsync(payload)
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
          <DialogTitle>{hop ? 'Edit transport' : 'Add transport'}</DialogTitle>
          <DialogDescription>
            The flight, train, bus, car or ferry that gets the group between
            places — with the times and booking reference everyone can pull up.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="transport-mode">Mode</Label>
            <Controller
              control={form.control}
              name="mode"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="transport-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES.map(({ value, label, Icon }) => (
                      <SelectItem key={value} value={value}>
                        <span className="flex items-center gap-2">
                          <Icon className="size-4 text-primary" aria-hidden /> {label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="transport-from">From</Label>
              <Controller
                control={form.control}
                name="depart_place"
                render={({ field }) => (
                  <Input
                    id="transport-from"
                    placeholder="Gare du Nord"
                    aria-invalid={err.depart_place ? true : undefined}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {err.depart_place && <p className="text-xs text-danger">{err.depart_place.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transport-to">To</Label>
              <Controller
                control={form.control}
                name="arrive_place"
                render={({ field }) => (
                  <Input
                    id="transport-to"
                    placeholder="Amsterdam Centraal"
                    aria-invalid={err.arrive_place ? true : undefined}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {err.arrive_place && <p className="text-xs text-danger">{err.arrive_place.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="transport-depart">Departs</Label>
              <Controller
                control={form.control}
                name="depart_at"
                render={({ field }) => (
                  <Input
                    id="transport-depart"
                    type="datetime-local"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transport-arrive">Arrives</Label>
              <Controller
                control={form.control}
                name="arrive_at"
                render={({ field }) => (
                  <Input
                    id="transport-arrive"
                    type="datetime-local"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={err.arrive_at ? true : undefined}
                  />
                )}
              />
              {err.arrive_at ? (
                <p className="text-xs text-danger">{err.arrive_at.message}</p>
              ) : (
                <p className="text-xs text-faint">Optional — set both to place it on the calendar.</p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transport-code">Confirmation code</Label>
            <Controller
              control={form.control}
              name="confirmation_code"
              render={({ field }) => (
                <Input
                  id="transport-code"
                  placeholder="XY7Q2P"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transport-url">Booking link</Label>
            <Controller
              control={form.control}
              name="booking_url"
              render={({ field }) => (
                <Input
                  id="transport-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  aria-invalid={err.booking_url ? true : undefined}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            {err.booking_url && <p className="text-xs text-danger">{err.booking_url.message}</p>}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {hop ? 'Save transport' : 'Add transport'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Copy-to-clipboard chip for a confirmation code — one tap to copy rather than
 *  a select-and-hold on mobile. Mirrors the Stays CodeChip. */
function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the code — try again')
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Confirmation code copied' : `Copy confirmation code ${code}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <KeyRound className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="truncate font-mono">{code}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-success" aria-hidden />
      ) : (
        <Copy className="size-3.5 shrink-0" aria-hidden />
      )}
    </button>
  )
}

/** Sanitized external booking link chip. */
function BookingChip({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Booking</span>
    </a>
  )
}

/** "Fri, Jun 1 · 2:30 PM" for a wall-clock hop datetime, or '' when unset.
 *  Reused by the calendar day surface. */
export function whenLabel(dt: string | null): string {
  if (!dt) return ''
  const day = dt.slice(0, 10)
  const time = dt.slice(11, 16)
  // Build a readable date from the naive prefix without a timezone round-trip.
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, (m || 1) - 1, d || 1)
  const dateText = Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return time ? `${dateText} · ${formatTime(time)}` : dateText
}

/** One hop row: the mode icon, the From → To route, its departure/arrival times,
 *  and the confirmation code + booking chips. */
function TransportRow({
  hop, canManage, onEdit, onRemove,
}: {
  hop: Transport
  canManage: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const { Icon, label } = MODE_MAP[hop.mode]
  const url = safeHttpUrl(hop.booking_url)
  const depart = whenLabel(hop.depart_at)
  const arrive = whenLabel(hop.arrive_at)
  const hasRoute = hop.depart_place || hop.arrive_place
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line bg-sunken/40 px-3 py-2">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-faint text-primary">
        <Icon className="size-4" aria-label={label} />
      </span>
      <div className="min-w-0 flex-1">
        {hasRoute ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm font-medium">
            <span className="min-w-0 break-words">{hop.depart_place || '—'}</span>
            <ArrowRight className="size-3.5 shrink-0 text-muted" aria-label="to" />
            <span className="min-w-0 break-words">{hop.arrive_place || '—'}</span>
          </p>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        {(depart || arrive) && (
          <p className="truncate text-xs text-muted">
            {depart && <span>{depart}</span>}
            {depart && arrive && <span aria-hidden> → </span>}
            {arrive && <span>{arrive}</span>}
          </p>
        )}
        {(hop.confirmation_code || url) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {hop.confirmation_code && <CodeChip code={hop.confirmation_code} />}
            {url && <BookingChip url={url} />}
          </div>
        )}
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit ${label}`}>
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-danger"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  )
}

/** The trip's transport: a shared list of getting-there hops ordered by
 *  departure, each with its route, times, confirmation code and booking link
 *  (#350, epic #346). Any member adds one; the author or the trip owner can edit
 *  or remove it, matching the RLS on the table (the client is UX; Postgres is the
 *  boundary). */
export function TransportCard() {
  const { trip, me, isOwner } = useTripContext()
  const query = useTransport(trip.id)
  const remove = useDeleteTransport(trip.id, me.id)
  const [addOpen, setAddOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Transport | null>(null)

  const hops = query.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-4 text-primary" /> Transport
        </CardTitle>
        <CardDescription>
          How the group gets between places — flights, trains, buses and ferries
          with their times and booking reference. Each hop shows up on the
          calendar the day it departs or arrives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-16" />
        ) : query.isError ? (
          <ErrorState onRetry={() => query.refetch()} isRetrying={query.isFetching} />
        ) : (
          <>
            {hops.length > 0 && (
              <ul className="space-y-2">
                {hops.map((h) => (
                  <TransportRow
                    key={h.id}
                    hop={h}
                    canManage={isOwner || h.member_id === me.id}
                    onEdit={() => setEditing(h)}
                    onRemove={() =>
                      remove.mutate(h, {
                        onSuccess: () => toast.success(`Removed ${MODE_MAP[h.mode].label.toLowerCase()}`),
                      })
                    }
                  />
                ))}
              </ul>
            )}
            {hops.length === 0 && (
              <p className="text-sm text-muted">
                No transport yet. Add the flight, train or ferry between places so
                everyone has the times and confirmation code in one place.
              </p>
            )}
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus /> Add transport
            </Button>
          </>
        )}
      </CardContent>

      <TransportDialog open={addOpen} onOpenChange={setAddOpen} />
      <TransportDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        hop={editing ?? undefined}
      />
    </Card>
  )
}
