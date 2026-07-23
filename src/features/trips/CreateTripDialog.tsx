import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { MEMBER_COLORS } from '@/lib/colors'
import { cn, isMobileViewport } from '@/lib/utils'
import { useCreateTrip, type CreatedTrip } from './api'
import { CoverPicker } from './CoverPicker'
import { isPresetCover } from './covers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PlaceAutocomplete } from '@/components/ui/place-autocomplete'
import { DateInput } from '@/components/ui/date-picker'
import { Label } from '@/components/ui/label'
import { MemberAvatar } from '@/components/ui/avatar'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const schema = z
  .object({
    name: z.string().trim().min(1, 'Give the trip a name').max(80),
    destination: z.string().trim().max(120).optional(),
    cover_url: z
      .string()
      .trim()
      .max(2000, 'That link is too long')
      .optional()
      .refine((v) => !v || /^https?:\/\/.+/i.test(v) || isPresetCover(v), {
        message: 'Must be a valid http(s) link',
      }),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    estimated_budget: z.coerce.number().positive().optional().or(z.literal('')),
  })
  .refine(
    (v) => !v.start_date || !v.end_date || v.end_date >= v.start_date,
    { message: 'End date is before the start date', path: ['end_date'] }
  )

type FormValues = z.input<typeof schema>

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Give yourself a name').max(40, 'Keep it under 40 characters'),
})

type ProfileFormValues = z.input<typeof profileSchema>

/**
 * The owner's member row is auto-created with their email username as the
 * display name (see the `on_trip_created` DB trigger) — friends get to pick
 * a name and color on join, so the owner gets one shot at the same choice
 * right after creating their first trip.
 */
function WelcomeStep({ created, onDone }: { created: CreatedTrip; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [color, setColor] = React.useState(created.member.color)
  const [saving, setSaving] = React.useState(false)
  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: created.member.display_name },
  })
  const name = form.watch('name')

  async function onSubmit(values: ProfileFormValues) {
    setSaving(true)
    const { error } = await supabase
      .from('members')
      .update({ display_name: values.name.trim(), color })
      .eq('id', created.member.id)
    setSaving(false)
    if (error) {
      toast.error(friendlyError(error, 'Could not save your profile'))
      return
    }
    void queryClient.invalidateQueries({ queryKey: ['trips'] })
    void queryClient.invalidateQueries({ queryKey: ['members', created.trip.id] })
    onDone()
  }

  const err = form.formState.errors

  return (
    <>
      <DialogHeader>
        <DialogTitle>How should we introduce you?</DialogTitle>
        <DialogDescription>
          This is the name and color your friends will see across the trip.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="welcome-name">Your name</Label>
          <div className="flex items-center gap-3">
            <MemberAvatar name={name || '?'} color={color} size="md" />
            <Input
              id="welcome-name"
              autoFocus={!isMobileViewport()}
              maxLength={40}
              aria-invalid={err.name ? true : undefined}
              {...form.register('name')}
            />
          </div>
          {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>Pick your color</Label>
          <div className="flex flex-wrap gap-2">
            {MEMBER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Choose color ${c}`}
                onClick={() => setColor(c)}
                className={cn(
                  'size-8 cursor-pointer rounded-full transition-transform hover:scale-110',
                  color === c && 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" className="flex-1" onClick={onDone} disabled={saving}>
            Skip for now
          </Button>
          <Button type="submit" size="lg" className="flex-1" disabled={saving}>
            {saving ? 'Saving…' : 'Looks good'}
          </Button>
        </div>
      </form>
    </>
  )
}

export function CreateTripDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const createTrip = useCreateTrip()
  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const [created, setCreated] = React.useState<CreatedTrip | null>(null)

  async function onSubmit(values: FormValues) {
    try {
      const result = await createTrip.mutateAsync({
        name: values.name!,
        destination: values.destination,
        cover_url: values.cover_url?.trim() || null,
        start_date: values.start_date || null,
        end_date: values.end_date || null,
        estimated_budget:
          values.estimated_budget === '' || values.estimated_budget == null
            ? null
            : Number(values.estimated_budget),
      })
      form.reset()
      setCreated(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the trip')
    }
  }

  function finish() {
    const tripId = created!.trip.id
    onOpenChange(false)
    setCreated(null)
    toast.success('Trip created — invite your friends from Settings')
    navigate(`/trip/${tripId}`)
  }

  const err = form.formState.errors

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Mid-welcome, closing the dialog (backdrop/Escape) still lands you
        // in the trip — the owner already has a name, just not a chosen one.
        if (!o && created) return finish()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        {created ? (
          <WelcomeStep created={created} onDone={finish} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New trip</DialogTitle>
              <DialogDescription>You can change all of this later in Settings.</DialogDescription>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="trip-name">Trip name</Label>
                <Input
                  id="trip-name"
                  placeholder="Tokyo Adventure"
                  aria-invalid={err.name ? true : undefined}
                  {...form.register('name')}
                />
                {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trip-dest">Destination</Label>
                <Controller
                  control={form.control}
                  name="destination"
                  render={({ field }) => (
                    <PlaceAutocomplete
                      id="trip-dest"
                      placeholder="Tokyo, Japan"
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trip-cover">Cover</Label>
                <Controller
                  control={form.control}
                  name="cover_url"
                  render={({ field }) => (
                    <CoverPicker
                      id="trip-cover"
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      aria-invalid={err.cover_url ? true : undefined}
                    />
                  )}
                />
                {err.cover_url && <p className="text-xs text-danger">{err.cover_url.message}</p>}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="trip-start">Start date</Label>
                  <Controller
                    control={form.control}
                    name="start_date"
                    render={({ field }) => (
                      <DateInput
                        id="trip-start"
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                      />
                    )}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trip-end">End date</Label>
                  <Controller
                    control={form.control}
                    name="end_date"
                    render={({ field }) => (
                      <DateInput
                        id="trip-end"
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
                <Label htmlFor="trip-budget">Estimated budget (per person, optional)</Label>
                <Input
                  id="trip-budget"
                  type="number"
                  min="0"
                  step="50"
                  placeholder="1500"
                  {...form.register('estimated_budget')}
                />
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={createTrip.isPending}>
                {createTrip.isPending ? 'Creating…' : 'Create trip'}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
