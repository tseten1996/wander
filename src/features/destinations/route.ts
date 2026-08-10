/**
 * Presentation helpers for legs — the parts that need `@/lib` formatters and so
 * live outside the pure `legs.ts`. Kept tiny and shared by the itinerary
 * headers, the calendar, the dashboard hero and the sidebar so the route reads
 * identically everywhere.
 */
import { dateRange } from '@/lib/utils'
import { MEMBER_COLORS } from '@/lib/colors'
import type { Destination } from '@/types'

/** "Amsterdam · Aug 4 – 6" — a leg's name with its (optional) date range. */
export function legHeading(leg: Destination): string {
  const range = leg.start_date || leg.end_date ? dateRange(leg.start_date, leg.end_date) : ''
  return range ? `${leg.name} · ${range}` : leg.name
}

/** The ordered route across legs — "Paris → Amsterdam → Berlin" — or the single
 *  `trips.destination` fallback when there are no legs. Empty when neither. */
export function routeText(destinations: Destination[], fallback: string | null): string {
  if (destinations.length > 0) return destinations.map((d) => d.name).join(' → ')
  return fallback ?? ''
}

/** A stable colour for a leg, drawn from the sanctioned avatar palette (so no
 *  raw hex enters components and it stays theme-correct) and keyed on the leg's
 *  index among the ranged legs — the same "number is the primary signal, colour
 *  wraps" approach as the itinerary day index. */
export function legColor(leg: Destination, rangedLegs: Destination[]): string {
  const i = rangedLegs.findIndex((d) => d.id === leg.id)
  return MEMBER_COLORS[(i < 0 ? 0 : i) % MEMBER_COLORS.length]
}
