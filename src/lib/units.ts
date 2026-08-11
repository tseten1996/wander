/*
  Temperature units (issue #220). The app fetches and reasons in Celsius
  everywhere — Open-Meteo returns °C, and the packing-nudge thresholds in
  `src/features/packing/suggestions.ts` stay in that one internal unit. This is
  the single place that converts to the member's chosen unit for *display*.

  Every formatter emits an explicit unit marker ("27°C" / "81°F") so a bare
  "27°" is never silently read on the wrong scale — the ambiguity this feature
  exists to remove. Pure and dependency-free so it is trivially unit-testable.
*/

export type TempUnit = 'C' | 'F'

/**
 * Locales that conventionally read temperature in Fahrenheit: the United
 * States, Liberia, and Myanmar. Compared case-insensitively against the full
 * BCP-47 tag (`en-us`) or its language subtag (`my`).
 */
const FAHRENHEIT_LOCALES = ['en-us', 'en-lr', 'my']

/**
 * The default unit for a device, derived from the browser locale: °F for the
 * Fahrenheit-first locales above, °C everywhere else. Safe where `navigator`
 * is absent (SSR / tests) — it simply falls back to °C.
 */
export function defaultTempUnit(): TempUnit {
  const locale =
    typeof navigator !== 'undefined' && navigator.language
      ? navigator.language.toLowerCase()
      : ''
  const fahrenheit = FAHRENHEIT_LOCALES.some(
    (l) => locale === l || locale.startsWith(`${l}-`),
  )
  return fahrenheit ? 'F' : 'C'
}

/** Convert a Celsius value to the chosen unit, rounded to a whole degree. */
export function convertTemp(celsius: number, unit: TempUnit): number {
  const value = unit === 'F' ? (celsius * 9) / 5 + 32 : celsius
  return Math.round(value)
}

/**
 * Format a Celsius temperature for display in the chosen unit, always with an
 * explicit unit marker (e.g. "27°C" / "81°F") so the value is never ambiguous.
 */
export function formatTemp(celsius: number, unit: TempUnit): string {
  return `${convertTemp(celsius, unit)}°${unit}`
}
