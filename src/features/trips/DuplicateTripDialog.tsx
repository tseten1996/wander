import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Copy, ListChecks, Luggage, Map, StickyNote, Wallet } from 'lucide-react'
import { friendlyError } from '@/lib/errors'
import { isMobileViewport } from '@/lib/utils'
import { useDuplicateTrip, type DuplicateSections } from './api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { DateInput } from '@/components/ui/date-picker'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const SECTIONS: {
  key: keyof DuplicateSections
  label: string
  hint: string
  Icon: typeof Map
}[] = [
  { key: 'itinerary', label: 'Itinerary', hint: 'Places & plans (unscheduled — pick new days later)', Icon: Map },
  { key: 'checklist', label: 'Checklist', hint: 'To-dos, reset to not done', Icon: ListChecks },
  { key: 'packing', label: 'Packing list', hint: 'Items, reset to unpacked', Icon: Luggage },
  { key: 'budget', label: 'Budget', hint: 'Categories & estimates, without the actuals', Icon: Wallet },
  { key: 'notes', label: 'Notes', hint: 'Shared notes, copied as-is', Icon: StickyNote },
]

const schema = z
  .object({
    name: z.string().trim().min(1, 'Give the new trip a name').max(80, 'Keep it under 80 characters'),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    sections: z.object({
      itinerary: z.boolean(),
      checklist: z.boolean(),
      packing: z.boolean(),
      budget: z.boolean(),
      notes: z.boolean(),
    }),
  })
  .refine((v) => !v.start_date || !v.end_date || v.end_date >= v.start_date, {
    message: 'End date is before the start date',
    path: ['end_date'],
  })

type FormValues = z.input<typeof schema>

export function DuplicateTripDialog({
  trip,
  open,
  onOpenChange,
}: {
  trip: { id: string; name: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const duplicate = useDuplicateTrip()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: `Copy of ${trip.name}`.slice(0, 80),
      start_date: '',
      end_date: '',
      sections: { itinerary: true, checklist: true, packing: true, budget: true, notes: true },
    },
  })

  // Reopening for a (possibly renamed) trip should start from a fresh default.
  React.useEffect(() => {
    if (open) {
      form.reset({
        name: `Copy of ${trip.name}`.slice(0, 80),
        start_date: '',
        end_date: '',
        sections: { itinerary: true, checklist: true, packing: true, budget: true, notes: true },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trip.name])

  async function onSubmit(values: FormValues) {
    try {
      const newId = await duplicate.mutateAsync({
        sourceTripId: trip.id,
        name: values.name!,
        start_date: values.start_date || null,
        end_date: values.end_date || null,
        sections: values.sections as DuplicateSections,
      })
      onOpenChange(false)
      toast.success('Trip duplicated — set your new dates and invite your friends')
      navigate(`/trip/${newId}`)
    } catch (err) {
      toast.error(friendlyError(err, 'Could not duplicate the trip'))
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate this trip</DialogTitle>
          <DialogDescription>
            Start a fresh trip from this one’s structure. Members, invite link,
            chat, votes and everyone’s progress are left behind — only what you
            pick below is carried over.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dup-name">New trip name</Label>
            <Input
              id="dup-name"
              autoFocus={!isMobileViewport()}
              maxLength={80}
              aria-invalid={err.name ? true : undefined}
              {...form.register('name')}
            />
            {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dup-start">Start date</Label>
              <Controller
                control={form.control}
                name="start_date"
                render={({ field }) => (
                  <DateInput
                    id="dup-start"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dup-end">End date</Label>
              <Controller
                control={form.control}
                name="end_date"
                render={({ field }) => (
                  <DateInput
                    id="dup-end"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={err.end_date ? true : undefined}
                  />
                )}
              />
              {err.end_date && <p className="text-xs text-danger">{err.end_date.message}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>What to copy over</Label>
            <div className="space-y-1">
              {SECTIONS.map(({ key, label, hint, Icon }) => (
                <label
                  key={key}
                  htmlFor={`dup-${key}`}
                  className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-sunken/60"
                >
                  <Controller
                    control={form.control}
                    name={`sections.${key}`}
                    render={({ field }) => (
                      <Checkbox
                        id={`dup-${key}`}
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    )}
                  />
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={duplicate.isPending}>
            <Copy /> {duplicate.isPending ? 'Duplicating…' : 'Create duplicate'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
