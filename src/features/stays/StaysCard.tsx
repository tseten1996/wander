import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  BedDouble, Check, Copy, ExternalLink, KeyRound, MapPin, Pencil, Plus, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useCreateStay, useDeleteStay, useStays, useUpdateStay, type StayInput,
} from './api'
import { geocodeFirst } from '@/lib/geocode'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { Skeleton, ErrorState } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { dateRange } from '@/lib/utils'
import type { Stay } from '@/types'

/**
 * A user-supplied booking link is only ever shown as an external link when it is
 * a real http(s) URL. `javascript:` and other schemes are rejected outright — an
 * `href` is a capability, and a booking record is exactly the kind of shared,
 * member-authored field where a stray scheme must never become a live link.
 * Returns the normalised href, or null when the input isn't a safe web URL.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

const staySchema = z
  .object({
    name: z.string().trim().min(1, 'Give it a name').max(120, 'Keep it under 120 characters'),
    address: z.string().trim().max(300, 'Keep it under 300 characters').optional(),
    // Coordinates come from picking a suggestion; a manual edit of the address
    // clears them (same rule as the itinerary location field), so a stale pin
    // never outlives the address it belonged to.
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    check_in: z.string().optional(),
    check_out: z.string().optional(),
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
  .refine((v) => !v.check_in || !v.check_out || v.check_out >= v.check_in, {
    message: 'Check-out is before check-in',
    path: ['check_out'],
  })

type StayFormValues = z.input<typeof staySchema>

const EMPTY: StayFormValues = {
  name: '', address: '', latitude: null, longitude: null,
  check_in: '', check_out: '', confirmation_code: '', booking_url: '',
}

/** Add / edit a single stay. Name is free text (a hotel or "Dana's place");
 *  the address autocompletes and captures a pin, degrading to plain text. */
function StayDialog({
  open, onOpenChange, stay,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  stay?: Stay
}) {
  const { trip, me } = useTripContext()
  const create = useCreateStay(trip.id, me.id)
  const update = useUpdateStay(trip.id, me.id)

  const form = useForm<StayFormValues>({
    resolver: zodResolver(staySchema),
    defaultValues: EMPTY,
  })

  React.useEffect(() => {
    if (!open) return
    form.reset(
      stay
        ? {
            name: stay.name,
            address: stay.address ?? '',
            latitude: stay.latitude ?? null,
            longitude: stay.longitude ?? null,
            check_in: stay.check_in ?? '',
            check_out: stay.check_out ?? '',
            confirmation_code: stay.confirmation_code ?? '',
            booking_url: stay.booking_url ?? '',
          }
        : EMPTY
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stay])

  async function onSubmit(values: StayFormValues) {
    const address = values.address?.trim() || null
    // Coordinates only mean anything with an address; a cleared address drops
    // its pin rather than stranding stale coordinates.
    let latitude = address ? values.latitude ?? null : null
    let longitude = address ? values.longitude ?? null : null
    // A typed address never confirmed via autocomplete (or edited after picking,
    // which clears the pin) reaches here with an address but no coordinates.
    // Resolve it best-effort against the same keyless geocoder itinerary items
    // use — never blocking the save: a miss, timeout, or unreachable geocoder
    // just saves it unpinned, and the typed address is always kept.
    if (address && (latitude == null || longitude == null)) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      try {
        const hit = await geocodeFirst(address, controller.signal)
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
    const payload: StayInput = {
      name: values.name.trim(),
      address,
      latitude,
      longitude,
      check_in: values.check_in || null,
      check_out: values.check_out || null,
      confirmation_code: values.confirmation_code?.trim() || null,
      // Store only a sanitized http(s) link (or null); the schema already
      // rejected anything else, this is the defensive normalisation on save.
      booking_url: safeHttpUrl(values.booking_url),
    }
    try {
      if (stay) await update.mutateAsync({ id: stay.id, ...payload })
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
          <DialogTitle>{stay ? 'Edit stay' : 'Add a stay'}</DialogTitle>
          <DialogDescription>
            Where you’re sleeping — hotel, rental, a friend’s place — with the
            dates, address and check-in details everyone can pull up.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="stay-name">Name</Label>
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  id="stay-name"
                  placeholder="Hotel Sunrise"
                  aria-invalid={err.name ? true : undefined}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stay-address">Address</Label>
            <Controller
              control={form.control}
              name="address"
              render={({ field }) => (
                <PlaceAutocomplete
                  id="stay-address"
                  placeholder="123 Hauptstraße, Berlin"
                  aria-invalid={err.address ? true : undefined}
                  value={field.value ?? ''}
                  onChange={(v) => {
                    field.onChange(v)
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
            {err.address && <p className="text-xs text-danger">{err.address.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="stay-checkin">Check-in</Label>
              <Controller
                control={form.control}
                name="check_in"
                render={({ field }) => (
                  <DateInput
                    id="stay-checkin"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stay-checkout">Check-out</Label>
              <Controller
                control={form.control}
                name="check_out"
                render={({ field }) => (
                  <DateInput
                    id="stay-checkout"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={err.check_out ? true : undefined}
                  />
                )}
              />
              {err.check_out ? (
                <p className="text-xs text-danger">{err.check_out.message}</p>
              ) : (
                <p className="text-xs text-faint">Optional — set both to place it on the calendar.</p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stay-code">Confirmation code</Label>
            <Controller
              control={form.control}
              name="confirmation_code"
              render={({ field }) => (
                <Input
                  id="stay-code"
                  placeholder="ABC-12345"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stay-url">Booking link</Label>
            <Controller
              control={form.control}
              name="booking_url"
              render={({ field }) => (
                <Input
                  id="stay-url"
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
            {stay ? 'Save stay' : 'Add stay'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Copy-to-clipboard chip for a confirmation code — the front-desk field, so it
 *  is one tap to copy rather than a select-and-hold on mobile. */
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

/** The trip's lodging: a shared list of stays ordered by check-in, each with its
 *  address, dates, confirmation code and booking link (#348, epic #346). Any
 *  member adds one; the author or the trip owner can edit or remove it, matching
 *  the RLS on the table (the client is UX; Postgres is the boundary). */
export function StaysCard() {
  const { trip, me, isOwner } = useTripContext()
  const query = useStays(trip.id)
  const remove = useDeleteStay(trip.id, me.id)
  const [addOpen, setAddOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Stay | null>(null)

  const stays = query.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BedDouble className="size-4 text-primary" /> Stays
        </CardTitle>
        <CardDescription>
          Where the group is sleeping each night — hotels and rentals with their
          address, check-in dates and confirmation code. Each place shows up on
          the calendar for the days it covers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-16" />
        ) : query.isError ? (
          <ErrorState onRetry={() => query.refetch()} isRetrying={query.isFetching} />
        ) : (
          <>
            {stays.length > 0 && (
              <ul className="space-y-2">
                {stays.map((s) => {
                  const canManage = isOwner || s.member_id === me.id
                  const url = safeHttpUrl(s.booking_url)
                  return (
                    <li
                      key={s.id}
                      className="flex items-start gap-3 rounded-xl border border-line bg-sunken/40 px-3 py-2"
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-faint text-primary">
                        <BedDouble className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        {(s.check_in || s.check_out) && (
                          <p className="truncate text-xs text-muted">{dateRange(s.check_in, s.check_out)}</p>
                        )}
                        {s.address && (
                          <p className="mt-0.5 flex items-start gap-1 text-xs text-muted">
                            <MapPin className="mt-px size-3 shrink-0" aria-hidden />
                            <span className="min-w-0 break-words">{s.address}</span>
                          </p>
                        )}
                        {(s.confirmation_code || url) && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {s.confirmation_code && <CodeChip code={s.confirmation_code} />}
                            {url && <BookingChip url={url} />}
                          </div>
                        )}
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditing(s)}
                            aria-label={`Edit ${s.name}`}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-danger"
                            onClick={() =>
                              remove.mutate(s, {
                                onSuccess: () => toast.success(`Removed ${s.name}`),
                              })
                            }
                            aria-label={`Remove ${s.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {stays.length === 0 && (
              <p className="text-sm text-muted">
                No stays yet. Add where you’re sleeping so everyone has the address
                and check-in code in one place.
              </p>
            )}
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus /> Add stay
            </Button>
          </>
        )}
      </CardContent>

      <StayDialog open={addOpen} onOpenChange={setAddOpen} />
      <StayDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        stay={editing ?? undefined}
      />
    </Card>
  )
}
