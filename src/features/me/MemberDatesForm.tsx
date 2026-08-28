import * as React from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DateInput } from '@/components/ui/date-picker'
import { shortDate } from '@/lib/utils'
import type { Member, Trip } from '@/types'
import { useUpdateMemberDates } from './api'

/*
  The editor for a member's arrival/departure dates (#286), shared by the Me
  page (a member sets their own) and Settings (the owner sets anyone's). Both
  dates are optional — leaving them blank means "here for the whole trip".
  Client validation mirrors the server (order + trip-range); the `members`
  trigger and CHECK are the real enforcement.
*/

function makeSchema(trip: Pick<Trip, 'start_date' | 'end_date'>) {
  const inRange = (d: string) =>
    (!trip.start_date || d >= trip.start_date) && (!trip.end_date || d <= trip.end_date)
  return z
    .object({
      arrives_on: z.string().optional(),
      departs_on: z.string().optional(),
    })
    .refine((v) => !v.arrives_on || inRange(v.arrives_on), {
      message: 'Outside the trip dates', path: ['arrives_on'],
    })
    .refine((v) => !v.departs_on || inRange(v.departs_on), {
      message: 'Outside the trip dates', path: ['departs_on'],
    })
    .refine((v) => !v.arrives_on || !v.departs_on || v.departs_on >= v.arrives_on, {
      message: 'Departure is before arrival', path: ['departs_on'],
    })
}

type FormValues = { arrives_on?: string; departs_on?: string }

export function MemberDatesForm({
  trip,
  member,
  actorId,
  isSelf,
}: {
  trip: Trip
  member: Member
  /** The editor's own member id — who the activity entry is attributed to. */
  actorId: string
  /** true = a member editing their own row; false = the owner editing someone. */
  isSelf: boolean
}) {
  const update = useUpdateMemberDates(trip.id)
  const form = useForm<FormValues>({
    resolver: zodResolver(makeSchema(trip)),
    defaultValues: {
      arrives_on: member.arrives_on ?? '',
      departs_on: member.departs_on ?? '',
    },
  })

  // Keep the fields in sync when the underlying row changes (realtime, or the
  // owner switching which member they're editing). `form` is stable across
  // renders, so it's intentionally not a dependency.
  React.useEffect(() => {
    form.reset({ arrives_on: member.arrives_on ?? '', departs_on: member.departs_on ?? '' })
  }, [member.id, member.arrives_on, member.departs_on, form])

  async function persist(arrives_on: string | null, departs_on: string | null) {
    const cleared = !arrives_on && !departs_on
    const verb = isSelf
      ? cleared ? 'cleared their trip dates' : 'updated their trip dates'
      : cleared ? 'cleared trip dates for' : 'updated trip dates for'
    try {
      await update.mutateAsync({
        memberId: member.id,
        arrives_on,
        departs_on,
        actorId,
        verb,
        subject: isSelf ? undefined : member.display_name,
      })
      toast.success(cleared ? 'Dates cleared' : 'Dates saved')
    } catch {
      /* rollback + error toast handled in the mutation's onError */
    }
  }

  const submit = (values: FormValues) =>
    persist(values.arrives_on || null, values.departs_on || null)

  const clear = () => {
    form.reset({ arrives_on: '', departs_on: '' })
    void persist(null, null)
  }

  const err = form.formState.errors
  const hasDates = !!(member.arrives_on || member.departs_on)
  const range =
    trip.start_date && trip.end_date
      ? `${shortDate(trip.start_date)} – ${shortDate(trip.end_date)}`
      : null

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`arrives-${member.id}`}>Arrives</Label>
          <Controller
            control={form.control}
            name="arrives_on"
            render={({ field }) => (
              <DateInput
                id={`arrives-${member.id}`}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                aria-invalid={err.arrives_on ? true : undefined}
              />
            )}
          />
          {err.arrives_on && <p className="text-xs text-danger">{err.arrives_on.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`departs-${member.id}`}>Departs</Label>
          <Controller
            control={form.control}
            name="departs_on"
            render={({ field }) => (
              <DateInput
                id={`departs-${member.id}`}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                aria-invalid={err.departs_on ? true : undefined}
              />
            )}
          />
          {err.departs_on && <p className="text-xs text-danger">{err.departs_on.message}</p>}
        </div>
      </div>
      <p className="text-xs text-muted">
        {range ? `Leave blank for the whole trip (${range}).` : 'Leave blank to be here for the whole trip.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Saving…' : 'Save dates'}
        </Button>
        {hasDates && (
          <Button type="button" variant="ghost" onClick={clear} disabled={form.formState.isSubmitting}>
            Clear
          </Button>
        )}
      </div>
    </form>
  )
}
