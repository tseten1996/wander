import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ChevronDown, ChevronUp, MapPin, Pencil, Plus, Route, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import {
  useCreateDestination, useDeleteDestination, useDestinations,
  useReorderDestination, useUpdateDestination, type DestinationInput,
} from './api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { Skeleton, ErrorState } from '@/components/ui/misc'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { dateRange, positionBetween } from '@/lib/utils'
import type { Destination } from '@/types'

const destinationSchema = z
  .object({
    name: z.string().trim().min(1, 'Give it a name').max(120, 'Keep it under 120 characters'),
    // Coordinates are never typed by hand — they come from picking a suggestion,
    // and are cleared when the name is edited manually (same rule as the
    // itinerary location field).
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
  })
  .refine((v) => !v.start_date || !v.end_date || v.end_date >= v.start_date, {
    message: 'End date is before the start date',
    path: ['end_date'],
  })

type DestinationFormValues = z.input<typeof destinationSchema>

const EMPTY: DestinationFormValues = {
  name: '', latitude: null, longitude: null, start_date: '', end_date: '',
}

/** Add / edit a single leg. Mirrors the itinerary ItemDialog shape: a place
 *  autocomplete for the name (capturing a pin), plus an optional date range. */
function DestinationDialog({
  open, onOpenChange, destination,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  destination?: Destination
}) {
  const { trip, me } = useTripContext()
  const create = useCreateDestination(trip.id, me.id)
  const update = useUpdateDestination(trip.id, me.id)

  const form = useForm<DestinationFormValues>({
    resolver: zodResolver(destinationSchema),
    defaultValues: EMPTY,
  })

  React.useEffect(() => {
    if (!open) return
    form.reset(
      destination
        ? {
            name: destination.name,
            latitude: destination.latitude ?? null,
            longitude: destination.longitude ?? null,
            start_date: destination.start_date ?? '',
            end_date: destination.end_date ?? '',
          }
        : EMPTY
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, destination])

  async function onSubmit(values: DestinationFormValues) {
    const name = values.name.trim()
    const payload: DestinationInput = {
      name,
      latitude: values.latitude ?? null,
      longitude: values.longitude ?? null,
      start_date: values.start_date || null,
      end_date: values.end_date || null,
    }
    try {
      if (destination) await update.mutateAsync({ id: destination.id, ...payload })
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
          <DialogTitle>{destination ? 'Edit destination' : 'Add destination'}</DialogTitle>
          <DialogDescription>
            A place on the trip, with optional dates. Days in that range group
            under this leg on the itinerary and calendar.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dest-name">Place</Label>
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <PlaceAutocomplete
                  id="dest-name"
                  placeholder="Amsterdam"
                  aria-invalid={err.name ? true : undefined}
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
            {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dest-start">Arrive</Label>
              <Controller
                control={form.control}
                name="start_date"
                render={({ field }) => (
                  <DateInput
                    id="dest-start"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dest-end">Leave</Label>
              <Controller
                control={form.control}
                name="end_date"
                render={({ field }) => (
                  <DateInput
                    id="dest-end"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={err.end_date ? true : undefined}
                  />
                )}
              />
              {err.end_date ? (
                <p className="text-xs text-danger">{err.end_date.message}</p>
              ) : (
                <p className="text-xs text-faint">Optional — set both to group days here.</p>
              )}
            </div>
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
            {destination ? 'Save destination' : 'Add destination'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Owner-only editor for the trip's ordered legs, folded into Settings (#197).
 *  Add, reorder (move up/down), edit and remove destinations; each carries an
 *  optional geocoded place and date range. */
export function DestinationsCard() {
  const { trip, me } = useTripContext()
  const query = useDestinations(trip.id)
  const reorder = useReorderDestination(trip.id)
  const remove = useDeleteDestination(trip.id, me.id)
  const [addOpen, setAddOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Destination | null>(null)

  const destinations = query.data ?? []

  // Move the leg at `index` one slot in `dir` (-1 up / +1 down) by writing the
  // midpoint of its new neighbours' positions — no renumbering, same pattern as
  // the itinerary drag reorder.
  function move(index: number, dir: -1 | 1) {
    const target = index + dir
    if (target < 0 || target >= destinations.length) return
    const position =
      dir === -1
        ? positionBetween(destinations[index - 2]?.position ?? null, destinations[index - 1].position)
        : positionBetween(destinations[index + 1].position, destinations[index + 2]?.position ?? null)
    reorder.mutate({ id: destinations[index].id, position })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-4 text-primary" /> Destinations
        </CardTitle>
        <CardDescription>
          Building a multi-city trip? Add each place in order, with the dates
          you’re there. The itinerary, calendar and trip header group around
          your legs. Leave it empty for a single-destination trip.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-16" />
        ) : query.isError ? (
          <ErrorState onRetry={() => query.refetch()} isRetrying={query.isFetching} />
        ) : (
          <>
            {destinations.length > 0 && (
              <ul className="space-y-2">
                {destinations.map((d, i) => (
                  <li
                    key={d.id}
                    className="flex items-center gap-3 rounded-xl border border-line bg-sunken/40 px-3 py-2"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-faint text-primary">
                      <MapPin className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{d.name}</p>
                      {(d.start_date || d.end_date) && (
                        <p className="truncate text-xs text-muted">{dateRange(d.start_date, d.end_date)}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${d.name} up`}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => move(i, 1)}
                        disabled={i === destinations.length - 1}
                        aria-label={`Move ${d.name} down`}
                      >
                        <ChevronDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(d)}
                        aria-label={`Edit ${d.name}`}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-danger"
                        onClick={() =>
                          remove.mutate(d, {
                            onSuccess: () => toast.success(`Removed ${d.name}`),
                          })
                        }
                        aria-label={`Remove ${d.name}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              <Plus /> Add destination
            </Button>
          </>
        )}
      </CardContent>

      <DestinationDialog open={addOpen} onOpenChange={setAddOpen} />
      <DestinationDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        destination={editing ?? undefined}
      />
    </Card>
  )
}
