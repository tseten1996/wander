import { MEMBER_COLORS, FALLBACK_MEMBER_COLOR } from '@/lib/colors'
import type { ItineraryItem } from '@/types'

/**
 * Day-view encoding shared by the itinerary list and the map — slice 2 of the
 * Map epic (#60). Each distinct scheduled day gets a stable 1-based number
 * and a colour, so a pin, a legend entry, and a list day-header all speak the
 * same "Day N + colour" language. The colour comes from the avatar palette
 * (`src/lib/colors.ts`) — the sanctioned runtime palette — so it stays
 * theme-correct in light and dark without introducing raw hex into components.
 *
 * The number, not the colour, is the primary signal: with more than
 * `MEMBER_COLORS.length` days the colours wrap, but the day number is always
 * unique, keeping the encoding legible for colour-vision deficiency.
 */
export interface DayInfo {
  /** 1-based day number in chronological order; null for undated items. */
  number: number | null
  /** Palette colour (readable behind white text), neutral for undated items. */
  color: string
  /** "Day 1" … or "No day" for undated items. */
  label: string
}

/** Shared entry for items with no scheduled day — neutral, unnumbered. */
export const UNSCHEDULED_DAY: DayInfo = {
  number: null,
  color: FALLBACK_MEMBER_COLOR,
  label: 'No day',
}

/**
 * Builds a `day -> DayInfo` map from an itinerary. Days are numbered in
 * chronological order (ISO `day` strings sort correctly), matching the order
 * the list already renders them in, so "Day 1" is the trip's first day
 * everywhere.
 */
export function buildDayIndex(items: ItineraryItem[]): Map<string, DayInfo> {
  const days = [...new Set(items.map((i) => i.day).filter((d): d is string => !!d))].sort((a, b) =>
    a.localeCompare(b)
  )
  const index = new Map<string, DayInfo>()
  days.forEach((day, i) => {
    index.set(day, {
      number: i + 1,
      color: MEMBER_COLORS[i % MEMBER_COLORS.length],
      label: `Day ${i + 1}`,
    })
  })
  return index
}

/** Resolves the DayInfo for an item, falling back to the undated entry. */
export function dayInfoFor(item: ItineraryItem, index: Map<string, DayInfo>): DayInfo {
  return (item.day ? index.get(item.day) : undefined) ?? UNSCHEDULED_DAY
}
