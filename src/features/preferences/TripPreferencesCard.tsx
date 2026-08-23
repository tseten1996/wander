/*
  "How this group travels" — the stated-preferences panel (#268, epic #209 slice 4).

  A light panel, not a wizard: a few chips and a text field. Empty is a valid
  state — the AI "improve this day" feature simply behaves as it does today when
  nothing is stated. Any member can edit it; these are the *group's* preferences,
  stored in one row and fed to the model as data the group stated (never mined
  from chat). Nothing here is owner-gated.
*/
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Compass } from 'lucide-react'
import { useTripContext } from '@/hooks/useTrip'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import type { TripPreferences } from '@/types'
import { useTripPreferences, useSaveTripPreferences } from './api'

/* The chip vocabularies. Single-selects mirror the DB CHECK sets exactly; the
   multi-selects are a starting set — anything not covered goes in the free text. */
const PACE_OPTIONS = [
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'packed', label: 'Packed' },
] as const

const BUDGET_OPTIONS = [
  { value: 'budget', label: 'Budget' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'luxury', label: 'Luxury' },
] as const

const INTEREST_OPTIONS = [
  'Food & drink', 'Museums & art', 'History', 'Nature & outdoors', 'Nightlife',
  'Shopping', 'Architecture', 'Local markets', 'Relaxation', 'Live music',
  'Photography', 'Off the beaten path',
]

const DIETARY_OPTIONS = [
  'Vegetarian', 'Vegan', 'Pescatarian', 'Halal', 'Kosher',
  'Gluten-free', 'Dairy-free', 'Nut allergy',
]

const schema = z.object({
  pace: z.enum(['relaxed', 'balanced', 'packed']).nullable(),
  budget_style: z.enum(['budget', 'moderate', 'comfortable', 'luxury']).nullable(),
  interests: z.array(z.string()).max(24),
  dietary: z.array(z.string()).max(24),
  notes: z.string().max(500, 'Keep it under 500 characters'),
})
type FormValues = z.infer<typeof schema>

function toForm(prefs: TripPreferences | null): FormValues {
  return {
    pace: prefs?.pace ?? null,
    budget_style: prefs?.budget_style ?? null,
    interests: prefs?.interests ?? [],
    dietary: prefs?.dietary ?? [],
    notes: prefs?.notes ?? '',
  }
}

/** A single toggle chip. A button, not a checkbox, but announces its pressed
 *  state to assistive tech and clears the 44px mobile tap-target floor. */
function Chip({
  label,
  selected,
  onToggle,
}: {
  label: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'inline-flex min-h-11 items-center rounded-xl border px-3.5 text-sm font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-pointer',
        selected
          ? 'border-primary bg-primary text-on-primary'
          : 'border-line bg-surface text-ink hover:border-line-strong hover:bg-sunken',
      )}
    >
      {label}
    </button>
  )
}

/** A labelled group of chips. `single` clears on re-tap (deselect); multi
 *  toggles membership. Rendered as a fieldset so the legend labels the set. */
function ChipGroup({
  legend,
  options,
  selected,
  onChange,
  single = false,
}: {
  legend: string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (next: string[]) => void
  single?: boolean
}) {
  const toggle = (value: string) => {
    if (single) {
      onChange(selected.includes(value) ? [] : [value])
      return
    }
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    )
  }
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            selected={selected.includes(o.value)}
            onToggle={() => toggle(o.value)}
          />
        ))}
      </div>
    </fieldset>
  )
}

/** The form itself, mounted only once the current preferences have loaded so
 *  its default values are the real stored ones. */
function PreferencesForm({ initial }: { initial: TripPreferences | null }) {
  const { trip, me } = useTripContext()
  const save = useSaveTripPreferences(trip.id, me.id)

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toForm(initial) })

  const onSubmit = (v: FormValues) => {
    const trimmed = v.notes.trim()
    save.mutate(
      {
        pace: v.pace,
        budget_style: v.budget_style,
        interests: v.interests,
        dietary: v.dietary,
        notes: trimmed ? trimmed : null,
      },
      // Reset the form's baseline to what we just saved, so the button returns
      // to disabled and a later realtime refetch does not fight the editor.
      { onSuccess: () => reset(v) },
    )
  }

  const asOptions = (labels: string[]) => labels.map((l) => ({ value: l, label: l }))

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <Controller
        control={control}
        name="pace"
        render={({ field }) => (
          <ChipGroup
            legend="Pace"
            single
            options={PACE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            selected={field.value ? [field.value] : []}
            onChange={(next) => field.onChange((next[0] as FormValues['pace']) ?? null)}
          />
        )}
      />

      <Controller
        control={control}
        name="budget_style"
        render={({ field }) => (
          <ChipGroup
            legend="Budget style"
            single
            options={BUDGET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            selected={field.value ? [field.value] : []}
            onChange={(next) => field.onChange((next[0] as FormValues['budget_style']) ?? null)}
          />
        )}
      />

      <Controller
        control={control}
        name="interests"
        render={({ field }) => (
          <ChipGroup
            legend="Interests"
            options={asOptions(INTEREST_OPTIONS)}
            selected={field.value}
            onChange={field.onChange}
          />
        )}
      />

      <Controller
        control={control}
        name="dietary"
        render={({ field }) => (
          <ChipGroup
            legend="Dietary needs"
            options={asOptions(DIETARY_OPTIONS)}
            selected={field.value}
            onChange={field.onChange}
          />
        )}
      />

      <div className="space-y-2">
        <Label htmlFor="preferences-notes">Anything else</Label>
        <Textarea
          id="preferences-notes"
          placeholder="Accessibility needs, dietary details, or how you'd like this trip to feel — e.g. “a slow architecture trip, one great meal a day, easy on the walking.”"
          aria-invalid={errors.notes ? true : undefined}
          {...register('notes')}
        />
        {errors.notes && (
          <p className="text-xs text-danger" role="alert">
            {errors.notes.message}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!isDirty || save.isPending}>
          {save.isPending && <Spinner className="size-4 text-on-primary" />}
          Save preferences
        </Button>
        <p className="text-xs text-faint">
          Wander uses these to tailor “Improve this day” suggestions to your group.
        </p>
      </div>
    </form>
  )
}

export function TripPreferencesCard() {
  const { trip } = useTripContext()
  const { data, isLoading } = useTripPreferences(trip.id)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Compass className="size-4 text-primary" aria-hidden />
          How this group travels
        </CardTitle>
        <CardDescription>
          Stated by the group and shared across the trip. Optional — it just makes AI suggestions
          feel more like yours.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-soft">
            <Spinner className="size-4" />
            Loading preferences…
          </div>
        ) : (
          <PreferencesForm initial={data ?? null} />
        )}
      </CardContent>
    </Card>
  )
}
