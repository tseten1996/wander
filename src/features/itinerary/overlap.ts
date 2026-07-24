import type { ItineraryItem } from '@/types'

/** Minutes since midnight, or null if the time string is empty/malformed. */
function toMinutes(t: string | null): number | null {
  if (!t) return null
  const [h, m] = t.split(':')
  const hours = Number(h)
  const mins = Number(m ?? 0)
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null
  return hours * 60 + mins
}

/**
 * Whether two timed items' intervals intersect. A missing `end_time` is treated
 * as a zero-length point at `start_time`. Back-to-back items that merely touch
 * at a shared endpoint don't conflict; two items pinned to the same instant do.
 * Items without a `start_time` are never considered timed and never match.
 */
function intervalsOverlap(a: ItineraryItem, b: ItineraryItem): boolean {
  const aStart = toMinutes(a.start_time)
  const bStart = toMinutes(b.start_time)
  if (aStart == null || bStart == null) return false
  // Clamp a malformed end-before-start up to the start so it reads as a point.
  const aEnd = Math.max(aStart, toMinutes(a.end_time) ?? aStart)
  const bEnd = Math.max(bStart, toMinutes(b.end_time) ?? bStart)
  // Two zero-length points conflict only when they land on the same instant.
  if (aStart === aEnd && bStart === bEnd) return aStart === bStart
  return aStart < bEnd && bStart < aEnd
}

/**
 * For one day's items, map each item id to the other items whose times overlap
 * it. Derived purely from the already-loaded rows — no query, no migration.
 * Items without a `start_time` never appear in the map and are never matched.
 */
export function overlapsByItem(items: ItineraryItem[]): Map<string, ItineraryItem[]> {
  const conflicts = new Map<string, ItineraryItem[]>()
  const add = (id: string, other: ItineraryItem) =>
    conflicts.set(id, [...(conflicts.get(id) ?? []), other])
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (intervalsOverlap(items[i], items[j])) {
        add(items[i].id, items[j])
        add(items[j].id, items[i])
      }
    }
  }
  return conflicts
}
