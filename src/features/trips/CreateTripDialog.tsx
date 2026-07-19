import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { useCreateTrip } from './api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const schema = z
  .object({
    name: z.string().trim().min(1, 'Give the trip a name').max(80),
    destination: z.string().trim().max(120).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    estimated_budget: z.coerce.number().positive().optional().or(z.literal('')),
  })
  .refine(
    (v) => !v.start_date || !v.end_date || v.end_date >= v.start_date,
    { message: 'End date is before the start date', path: ['end_date'] }
  )

type FormValues = z.input<typeof schema>

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

  async function onSubmit(values: FormValues) {
    try {
      const trip = await createTrip.mutateAsync({
        name: values.name!,
        destination: values.destination,
        start_date: values.start_date || null,
        end_date: values.end_date || null,
        estimated_budget:
          values.estimated_budget === '' || values.estimated_budget == null
            ? null
            : Number(values.estimated_budget),
      })
      onOpenChange(false)
      form.reset()
      toast.success('Trip created — invite your friends from Settings')
      navigate(`/trip/${trip.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the trip')
    }
  }

  const err = form.formState.errors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New trip</DialogTitle>
          <DialogDescription>You can change all of this later in Settings.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="trip-name">Trip name</Label>
            <Input id="trip-name" placeholder="Tokyo Adventure" {...form.register('name')} />
            {err.name && <p className="text-xs text-danger">{err.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trip-dest">Destination</Label>
            <Input id="trip-dest" placeholder="Tokyo, Japan" {...form.register('destination')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="trip-start">Start date</Label>
              <Input id="trip-start" type="date" {...form.register('start_date')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trip-end">End date</Label>
              <Input id="trip-end" type="date" {...form.register('end_date')} />
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
      </DialogContent>
    </Dialog>
  )
}
