import type { ItineraryItem } from '@/types'

/** A multi-day span (#166) — mirrors `isSpanning` in `spans.ts`, inlined so this
 *  module stays dependency-free and loadable raw by the Node test runner. */
function isSpan(i: ItineraryItem): boolean {
  return !!i.day && !!i.end_day && i.end_day > i.day
}

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
 *
 * Multi-day span items (#166 — a hotel checked in on this day, a rail pass) are
 * excluded entirely: they anchor to a day but occupy no single clock interval,
 * so a check-in time colliding with a dinner is not a real "you can't be in two
 * places" conflict. Excluding them keeps the same-day overlap warning honest.
 */
export function overlapsByItem(items: ItineraryItem[]): Map<string, ItineraryItem[]> {
  const timed = items.filter((i) => !isSpan(i))
  const conflicts = new Map<string, ItineraryItem[]>()
  const add = (id: string, other: ItineraryItem) =>
    conflicts.set(id, [...(conflicts.get(id) ?? []), other])
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (intervalsOverlap(timed[i], timed[j])) {
        add(timed[i].id, timed[j])
        add(timed[j].id, timed[i])
      }
    }
  }
  return conflicts
}
