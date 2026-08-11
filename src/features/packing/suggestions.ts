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
 */
export function derivePackingSuggestions(
  days: DailyWeather[],
  formatTemp: TempFormatter = defaultFormatTemp,
): PackingSuggestion[] {
  if (days.length === 0) return []

  const suggestions: PackingSuggestion[] = []

  const rainyDays = days.filter((d) => isWetCode(d.code)).length
  if (rainyDays > 0) {
    suggestions.push({
      id: 'rain',
      Icon: CloudRain,
      message: `Rain likely on ${rainyDays} of ${days.length} ${
        days.length === 1 ? 'day' : 'days'
      } — pack a rain jacket and umbrella.`,
      items: [
        { name: 'Rain jacket', category: 'clothes' },
        { name: 'Umbrella', category: 'misc' },
      ],
    })
  }

  const coldest = Math.min(...days.map((d) => d.tempMin))
  if (coldest <= COLD_C) {
    suggestions.push({
      id: 'cold',
      Icon: Snowflake,
      message: `Lows near ${formatTemp(coldest)} — bring warm layers.`,
      items: [{ name: 'Warm layers', category: 'clothes' }],
    })
  }

  const hottest = Math.max(...days.map((d) => d.tempMax))
  if (hottest >= HEAT_C) {
    suggestions.push({
      id: 'heat',
      Icon: Sun,
      message: `Highs around ${formatTemp(hottest)} — sun protection and water.`,
      items: [
        { name: 'Sunscreen', category: 'toiletries' },
        { name: 'Sunglasses', category: 'misc' },
        { name: 'Water bottle', category: 'misc' },
      ],
    })
  }

  return suggestions
}
