import { CloudRain, Snowflake, Sun, type LucideIcon } from 'lucide-react'
import type { DailyWeather } from '@/lib/weather'
import type { PackingCategory } from '@/types'

/**
 * Weather-aware packing nudges (issue #178). Pure derivation over the daily
 * forecast the app *already* fetches (`useTripWeather` / `src/lib/weather.ts`) —
 * no new network calls, no new tables. When the forecast is empty (no dates,
 * unresolvable destination, or a range beyond the ~16-day horizon) this returns
 * an empty list, so the Packing page simply shows no nudges rather than an error.
 */

export interface SuggestedItem {
  name: string
  category: PackingCategory
}

/** Minimal shape of an item already on the packing list, for dedupe (#412). */
export type ExistingItem = { name: string; category: PackingCategory }

/**
 * Normalized identity of a packing item: the same name (trimmed,
 * case-insensitive) in the same category. Both the nudge suppression and the
 * one-tap-add dedupe key off this single definition so they never disagree.
 */
function itemKey(item: { name: string; category: PackingCategory }): string {
  return `${item.category}\u0000${item.name.trim().toLowerCase()}`
}

/**
 * Drop the items that are already on the list (#412). Used by the one-tap add
 * so re-adding an item already present in the same category is a no-op rather
 * than inserting a duplicate into the shared list.
 */
export function filterNewPackingItems(
  items: SuggestedItem[],
  existing: readonly ExistingItem[],
): SuggestedItem[] {
  if (existing.length === 0) return items
  const have = new Set(existing.map(itemKey))
  return items.filter((i) => !have.has(itemKey(i)))
}

export interface PackingSuggestion {
  /** Stable id — used as the React key and the dismissal key. */
  id: 'rain' | 'cold' | 'heat'
  Icon: LucideIcon
  /** One-line advisory shown to the member. */
  message: string
  /** Item(s) added, in a sensible category, when the nudge is accepted in one tap. */
  items: SuggestedItem[]
}

// Thresholds picked to fire only when the weather would actually change the bag.
const COLD_C = 5 // a daily low at/below this wants warm layers
const HEAT_C = 30 // a daily high at/above this wants sun protection

/** WMO codes that mean liquid precipitation (drizzle, rain, showers, thunder). */
function isWetCode(code: number): boolean {
  return (
    (code >= 51 && code <= 57) || // drizzle
    (code >= 61 && code <= 67) || // rain
    (code >= 80 && code <= 82) || // rain showers
    code >= 95 // thunderstorm
  )
}

/**
 * Format a Celsius temperature for a nudge message. Defaults to °C so the
 * behaviour is unchanged when no formatter is supplied — the display unit is
 * injected by the caller (`WeatherNudges`) rather than imported here, so this
 * module keeps its single runtime dependency (lucide-react) and stays directly
 * importable by the Node unit tests without any path-alias resolution.
 */
export type TempFormatter = (celsius: number) => string

const defaultFormatTemp: TempFormatter = (c) => `${Math.round(c)}°C`

/**
 * Derive advisory packing nudges from the trip's daily forecast. Purely
 * additive: at most one nudge each for rain, cold, and heat, and nothing at all
 * when the forecast is unavailable. Temperatures in the copy are rendered
 * through `formatTemp`, so the member's unit preference is respected without
 * moving the thresholds off their internal Celsius scale.
 *
 * `existingItems` is the trip's current packing list (#412): a nudge is
 * suppressed once every item it would add is already on the list. Because that
 * list is shared server state, this is the natural cross-device dismissal — add
 * the item on one device and the nudge stops reappearing everywhere, and after
 * a reload. Defaults to empty, leaving the pre-#412 behaviour unchanged.
 */
export function derivePackingSuggestions(
  days: DailyWeather[],
  formatTemp: TempFormatter = defaultFormatTemp,
  existingItems: readonly ExistingItem[] = [],
): PackingSuggestion[] {
  if (days.length === 0) return []

  // A nudge still has something to offer only while at least one of its items
  // is missing from the list; once all are present it has served its purpose.
  const outstanding = (items: SuggestedItem[]) =>
    filterNewPackingItems(items, existingItems).length > 0

  const suggestions: PackingSuggestion[] = []

  const rainyDays = days.filter((d) => isWetCode(d.code)).length
  if (rainyDays > 0) {
    const items: SuggestedItem[] = [
      { name: 'Rain jacket', category: 'clothes' },
      { name: 'Umbrella', category: 'misc' },
    ]
    if (outstanding(items)) {
      suggestions.push({
        id: 'rain',
        Icon: CloudRain,
        message: `Rain likely on ${rainyDays} of ${days.length} ${
          days.length === 1 ? 'day' : 'days'
        } — pack a rain jacket and umbrella.`,
        items,
      })
    }
  }

  const coldest = Math.min(...days.map((d) => d.tempMin))
  if (coldest <= COLD_C) {
    const items: SuggestedItem[] = [{ name: 'Warm layers', category: 'clothes' }]
    if (outstanding(items)) {
      suggestions.push({
        id: 'cold',
        Icon: Snowflake,
        message: `Lows near ${formatTemp(coldest)} — bring warm layers.`,
        items,
      })
    }
  }

  const hottest = Math.max(...days.map((d) => d.tempMax))
  if (hottest >= HEAT_C) {
    const items: SuggestedItem[] = [
      { name: 'Sunscreen', category: 'toiletries' },
      { name: 'Sunglasses', category: 'misc' },
      { name: 'Water bottle', category: 'misc' },
    ]
    if (outstanding(items)) {
      suggestions.push({
        id: 'heat',
        Icon: Sun,
        message: `Highs around ${formatTemp(hottest)} — sun protection and water.`,
        items,
      })
    }
  }

  return suggestions
}
