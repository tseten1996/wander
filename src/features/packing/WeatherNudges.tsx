import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CloudSun, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTripContext } from '@/hooks/useTrip'
import { useTripWeather } from '@/hooks/useWeather'
import { useTempUnit } from '@/hooks/useTempUnit'
import { formatTemp } from '@/lib/units'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useAddPackingItem } from './api'
import { derivePackingSuggestions, type PackingSuggestion } from './suggestions'

/** A single dismissible nudge row: message + one-tap add + dismiss. */
function NudgeRow({
  suggestion,
  onAdd,
  onDismiss,
}: {
  suggestion: PackingSuggestion
  onAdd: (s: PackingSuggestion) => Promise<void>
  onDismiss: (id: string) => void
}) {
  const { Icon, message } = suggestion
  const [adding, setAdding] = React.useState(false)

  async function handleAdd() {
    setAdding(true)
    try {
      await onAdd(suggestion)
    } finally {
      setAdding(false)
    }
  }

  return (
    <motion.li
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className="flex items-center gap-3 py-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon className="size-4" />
        </span>
        <p className="min-w-0 flex-1 text-sm text-ink-soft">{message}</p>
        <Button
          size="sm"
          variant="soft"
          onClick={handleAdd}
          disabled={adding}
          className="shrink-0"
        >
          <Plus /> Add
        </Button>
        <button
          type="button"
          data-icon-button=""
          onClick={() => onDismiss(suggestion.id)}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-faint transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label={`Dismiss suggestion: ${message}`}
        >
          <X className="size-4" />
        </button>
      </div>
    </motion.li>
  )
}

/**
 * Weather-derived packing suggestions (issue #178). Reads the already-fetched
 * trip forecast and surfaces at most three dismissible nudges (rain / cold /
 * heat). Renders nothing when there's no forecast or nothing is outstanding, so
 * it never clutters the list or blocks it on a missing forecast.
 */
export default function WeatherNudges() {
  const { trip, me } = useTripContext()
  const weather = useTripWeather(trip)
  const { unit } = useTempUnit()
  const addItem = useAddPackingItem(trip.id, me.id)
  const [dismissed, setDismissed] = React.useState<Set<string>>(() => new Set())

  const days = React.useMemo(
    () => (weather.data ? Array.from(weather.data.values()) : []),
    [weather.data],
  )

  const suggestions = React.useMemo(
    () =>
      derivePackingSuggestions(days, (c) => formatTemp(c, unit)).filter(
        (s) => !dismissed.has(s.id),
      ),
    [days, dismissed, unit],
  )

  function dismiss(id: string) {
    setDismissed((prev) => new Set(prev).add(id))
  }

  async function add(suggestion: PackingSuggestion) {
    try {
      // Add each item sequentially so a mid-list failure still lands the earlier
      // ones; the mutation toasts its own error.
      for (const item of suggestion.items) {
        await addItem.mutateAsync(item)
      }
      const names = suggestion.items.map((i) => i.name).join(', ')
      toast.success(`Added ${names} to your packing list`)
      dismiss(suggestion.id)
    } catch {
      // toasted by the mutation's onError; keep the nudge so it can be retried.
    }
  }

  if (suggestions.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="mb-4"
    >
      <Card className="p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <CloudSun className="size-4" />
          </span>
          <div>
            <h2 className="font-display font-semibold">Weather suggestions</h2>
            <p className="text-xs text-muted">Based on the forecast for your trip</p>
          </div>
        </div>
        <ul className="mt-2 divide-y divide-line">
          <AnimatePresence initial={false}>
            {suggestions.map((s) => (
              <NudgeRow key={s.id} suggestion={s} onAdd={add} onDismiss={dismiss} />
            ))}
          </AnimatePresence>
        </ul>
      </Card>
    </motion.div>
  )
}
