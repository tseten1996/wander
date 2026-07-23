import { useQuery } from '@tanstack/react-query'
import { fetchTripWeather, type DailyWeather } from '@/lib/weather'
import type { Trip } from '@/types'

// Module-level so React Query keeps a stable `select` identity and only
// rebuilds the Map when the underlying forecast data actually changes.
const toWeatherMap = (days: DailyWeather[]) => new Map(days.map((d) => [d.date, d]))

/**
 * Daily forecast for a trip's destination over its date range, keyed by
 * `YYYY-MM-DD` for O(1) lookup from any day cell. Shared by Calendar and
 * Itinerary (neither owns the other's feature, so this lives in hooks/).
 *
 * Weather is always additive: the query is disabled until a destination and
 * both dates exist, never retries, and the consumers render only when
 * `data` is present — so an offline device, an unresolvable place, or a
 * range beyond the ~16-day horizon just shows no weather, never an error.
 */
export function useTripWeather(trip: Trip) {
  return useQuery({
    queryKey: ['weather', trip.id, trip.destination, trip.start_date, trip.end_date],
    queryFn: ({ signal }) =>
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
    // Forecasts move slowly; an hour-fresh cache avoids refetch storms.
    staleTime: 60 * 60 * 1000,
    gcTime: 6 * 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    select: toWeatherMap,
  })
}
