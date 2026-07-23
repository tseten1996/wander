/*
  Daily weather forecast via Open-Meteo — free, no API key, no attribution
  burden — the same zero-cost/no-key posture as the Photon geocoder in
  `geocode.ts` (see docs/ARCHITECTURE.md §"No backend, no paid anything").

  Two public endpoints are used, both keyless:
    • geocoding-api.open-meteo.com — resolves the trip's destination *name*
      to coordinates (until a stored-coordinates column lands, #46).
    • api.open-meteo.com/v1/forecast — the daily high/low + condition code.

  Forecasts only exist ~16 days out, so callers clamp the requested window to
  [today, today+15] with `forecastWindow()`; days outside it simply have no
  entry (no error). Every fetch is signal-aware and throws on network/HTTP
  failure so the calling TanStack Query degrades to "no weather" rather than
  breaking the page — weather is always additive.
*/

import {
  Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow,
  CloudSun, Sun, type LucideIcon,
} from 'lucide-react'
import { addDays, format } from 'date-fns'

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

// Open-Meteo publishes ~16 days of daily forecast (today included).
const FORECAST_HORIZON_DAYS = 15

export interface DailyWeather {
  date: string // YYYY-MM-DD, in the destination's local timezone
  tempMax: number
  tempMin: number
  code: number // WMO weather-interpretation code (-1 = unknown/missing)
}

export interface Coordinates {
  lat: number
  lon: number
}

/**
 * The intersection of a trip's [start, end] range with the forecast horizon
 * [today, today+15]. Returns null when the trip has no dates or when the
 * whole range is in the past or beyond the horizon — in which case there is
 * nothing to fetch and the UI shows no weather.
 */
export function forecastWindow(
  startDate: string | null,
  endDate: string | null,
  today: Date,
): { start: string; end: string } | null {
  if (!startDate || !endDate) return null
  const todayStr = format(today, 'yyyy-MM-dd')
  const horizonStr = format(addDays(today, FORECAST_HORIZON_DAYS), 'yyyy-MM-dd')
  // ISO date strings compare lexicographically, so plain string max/min work.
  const start = startDate > todayStr ? startDate : todayStr
  const end = endDate < horizonStr ? endDate : horizonStr
  if (start > end) return null
  return { start, end }
}

/**
 * Resolve a free-text destination to coordinates via Open-Meteo's keyless
 * geocoder. Returns null when nothing matches (a made-up or empty place),
 * so weather stays absent rather than erroring. Only the first segment
 * before a comma is queried ("Lisbon, Portugal" → "Lisbon") because the
 * geocoder matches a single place name.
 */
export async function geocodeDestination(
  destination: string,
  signal?: AbortSignal,
): Promise<Coordinates | null> {
  const name = destination.split(',')[0]?.trim()
  if (!name) return null

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`)
  const data: unknown = await res.json()
  const results =
    data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)
      ? (data as { results: unknown[] }).results
      : []
  const first = results[0]
  if (!first || typeof first !== 'object') return null
  const { latitude, longitude } = first as { latitude?: unknown; longitude?: unknown }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  return { lat: latitude, lon: longitude }
}

/**
 * Fetch the daily high/low + condition code for a coordinate over the given
 * inclusive date window. `timezone=auto` aligns each daily bucket to the
 * destination's local calendar day. Days the API returns with a null
 * temperature are dropped.
 */
export async function fetchDailyForecast(
  { lat, lon }: Coordinates,
  window: { start: string; end: string },
  signal?: AbortSignal,
): Promise<DailyWeather[]> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    start_date: window.start,
    end_date: window.end,
  })
  const res = await fetch(`${FORECAST_URL}?${params.toString()}`, { signal })
  if (!res.ok) throw new Error(`Forecast returned ${res.status}`)
  const data: unknown = await res.json()
  const daily =
    data && typeof data === 'object' ? (data as { daily?: unknown }).daily : undefined
  if (!daily || typeof daily !== 'object') return []

  const { time, temperature_2m_max: maxes, temperature_2m_min: mins, weather_code: codes } =
    daily as {
      time?: unknown
      temperature_2m_max?: unknown
      temperature_2m_min?: unknown
      weather_code?: unknown
    }
  if (!Array.isArray(time) || !Array.isArray(maxes) || !Array.isArray(mins) || !Array.isArray(codes))
    return []

  const days: DailyWeather[] = []
  for (let i = 0; i < time.length; i++) {
    const date = time[i]
    const tempMax = maxes[i]
    const tempMin = mins[i]
    const code = codes[i]
    if (typeof date !== 'string' || typeof tempMax !== 'number' || typeof tempMin !== 'number')
      continue
    // -1 is a non-WMO sentinel: a missing/invalid code should read as the
    // neutral "Cloudy" default, not be mislabelled "Clear" (WMO 0).
    days.push({ date, tempMax, tempMin, code: typeof code === 'number' ? code : -1 })
  }
  return days
}

/**
 * End-to-end: clamp the window, geocode the destination, fetch the forecast.
 * Returns [] whenever there is nothing to show (no dates, no resolvable
 * place, or a range entirely outside the horizon). Network/HTTP errors
 * propagate so the caller's query lands in an error state that the UI
 * renders as simply no weather.
 */
export async function fetchTripWeather(
  { destination, startDate, endDate }: {
    destination: string | null
    startDate: string | null
    endDate: string | null
  },
  today: Date,
  signal?: AbortSignal,
): Promise<DailyWeather[]> {
  if (!destination?.trim()) return []
  const window = forecastWindow(startDate, endDate, today)
  if (!window) return []
  const coords = await geocodeDestination(destination, signal)
  if (!coords) return []
  return fetchDailyForecast(coords, window, signal)
}

export interface WeatherPresentation {
  label: string
  Icon: LucideIcon
}

/**
 * Map a WMO weather-interpretation code to a short label and a lucide icon.
 * Grouped to the handful of conditions worth an at-a-glance icon; unknown
 * codes fall back to a neutral cloud. (WMO code table per Open-Meteo docs.)
 */
export function describeWeather(code: number): WeatherPresentation {
  switch (true) {
    case code === 0:
      return { label: 'Clear', Icon: Sun }
    case code === 1 || code === 2:
      return { label: 'Partly cloudy', Icon: CloudSun }
    case code === 3:
      return { label: 'Overcast', Icon: Cloud }
    case code === 45 || code === 48:
      return { label: 'Fog', Icon: CloudFog }
    case code >= 51 && code <= 57:
      return { label: 'Drizzle', Icon: CloudDrizzle }
    case (code >= 61 && code <= 67) || (code >= 80 && code <= 82):
      return { label: 'Rain', Icon: CloudRain }
    case (code >= 71 && code <= 77) || code === 85 || code === 86:
      return { label: 'Snow', Icon: CloudSnow }
    case code >= 95:
      return { label: 'Thunderstorm', Icon: CloudLightning }
    default:
      return { label: 'Cloudy', Icon: Cloud }
  }
}
