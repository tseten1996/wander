import * as React from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  fetchDailyForecast,
  fetchTripWeather,
  forecastWindow,
  type DailyWeather,
} from '@/lib/weather'
import { hasRange, mergeLegWeather } from '@/features/destinations/legs'
import type { Destination, Trip } from '@/types'

// Forecasts move slowly; an hour-fresh cache avoids refetch storms, and a
// 6-hour gc keeps a leg's forecast warm while the group pages across days.
const SHARED = {
  staleTime: 60 * 60 * 1000,
  gcTime: 6 * 60 * 60 * 1000,
  retry: false as const,
  refetchOnWindowFocus: false,
} as const

interface TripWeather {
  /** `YYYY-MM-DD → DailyWeather` for O(1) lookup from any day cell. Always a
   *  Map (empty when nothing resolved); consumers read `.get(date)`. */
  data: Map<string, DailyWeather>
  isLoading: boolean
  isError: boolean
}

/**
 * Daily forecast for a trip, keyed by `YYYY-MM-DD`, shared by Calendar and
 * Itinerary (neither owns the other's feature, so this lives in hooks/).
 *
 * On a multi-destination trip (#197, epic #196) each day resolves to the leg
 * that owns it — day 4 in Kyoto shows Kyoto's forecast, not the trip's single
 * `trips.destination`. Legs are already geocoded, so each ranged, located leg
 * fetches its own window directly (no name lookup) and is cached per
 * `(leg, coords, range)`, so paging across days never refetches. Days in no
 * leg fall back to the single-destination forecast; a leg without coordinates
 * (or one beyond the ~16-day horizon) shows "weather unavailable" for its days
 * rather than borrowing another city's forecast. Pass no `destinations` (or a
 * legless trip) and this is exactly the previous single-destination behaviour.
 *
 * Weather is always additive: every query is disabled until its inputs exist,
 * never retries, and consumers render only when an entry is present — so an
 * offline device, an unresolvable place, or a range beyond the horizon simply
 * shows no weather, never an error.
 */
export function useTripWeather(trip: Trip, destinations: Destination[] = []): TripWeather {
  const rangedLegs = destinations.filter(hasRange)
  // Only legs that carry coordinates can fetch their own forecast; a ranged
  // leg without a pin still owns its days (they read "unavailable"), it just
  // has no query.
  const legFetchable = rangedLegs.filter((d) => d.latitude != null && d.longitude != null)

  const results = useQueries({
    queries: [
      // The single-destination forecast — the day fallback for anywhere no leg
      // covers, and the whole forecast on a legless trip (unchanged behaviour).
      {
        queryKey: ['weather', trip.id, trip.destination, trip.start_date, trip.end_date],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          fetchTripWeather(
            {
              destination: trip.destination,
              startDate: trip.start_date,
              endDate: trip.end_date,
            },
            new Date(),
            signal,
          ),
        enabled: Boolean(trip.destination && trip.start_date && trip.end_date),
        ...SHARED,
      },
      // One query per ranged, located leg, keyed on its coords + range so
      // switching days doesn't refetch and each leg caches independently.
      ...legFetchable.map((leg) => ({
        queryKey: [
          'weather',
          'leg',
          leg.id,
          leg.latitude,
          leg.longitude,
          leg.start_date,
          leg.end_date,
        ],
        queryFn: ({ signal }: { signal: AbortSignal }): Promise<DailyWeather[]> => {
          const window = forecastWindow(leg.start_date, leg.end_date, new Date())
          if (!window) return Promise.resolve([])
          return fetchDailyForecast(
            { lat: leg.latitude as number, lon: leg.longitude as number },
            window,
            signal,
          )
        },
        ...SHARED,
      })),
    ],
  })

  // Rebuild the merged map only when a query's data actually changes (its
  // update stamp moves) or the leg set changes (the results array grows or
  // shrinks) — a fresh Map every render would churn the consumers. Same
  // stamp-joined-deps discipline as useUnreadDots.
  const stamp = results.map((q) => `${q.dataUpdatedAt}:${q.status}`).join('|')
  const data = React.useMemo(
    () => {
      const tripDays = results[0]?.data ?? []
      const legForecasts = legFetchable.map((leg, i) => ({
        leg,
        days: results[i + 1]?.data ?? [],
      }))
      return mergeLegWeather(tripDays, legForecasts, rangedLegs)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp],
  )

  return {
    data,
    isLoading: results.some((q) => q.isLoading),
    isError: results.some((q) => q.isError),
  }
}
