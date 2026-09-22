/**
 * Transport-for-a-day derivation (#350, epic #346 slice 2).
 *
 * A trip's `transport` hops each carry OPTIONAL wall-clock `depart_at` /
 * `arrive_at` datetimes (`YYYY-MM-DDTHH:mm`, no timezone). A hop *departs on* the
 * calendar day of its `depart_at` and *arrives on* the day of its `arrive_at` —
 * the two can differ (an overnight train, a red-eye flight), so a single hop can
 * surface on two days. The day is the date PREFIX of the stored datetime, so the
 * derivation is timezone-immune: a 23:50 departure shows on that calendar day for
 * every member, whatever their browser timezone.
 *
 * Pure module: it imports only a `type`, so the built-in Node test runner can
 * exercise it directly (`tests/transport.test.mjs`) without resolving the `@/`
 * alias — the same discipline `stays/dates.ts` and `legs.ts` follow.
 */
import type { Transport } from '@/types'

/** The `yyyy-MM-dd` a datetime falls on, or null when it's unset. */
export function dayOf(datetime: string | null): string | null {
  return datetime ? datetime.slice(0, 10) : null
}

/** The hops departing on an ISO `day`, in list order. */
export function departingOn(day: string, hops: Transport[]): Transport[] {
  return hops.filter((h) => dayOf(h.depart_at) === day)
}

/** The hops arriving on an ISO `day`, in list order. */
export function arrivingOn(day: string, hops: Transport[]): Transport[] {
  return hops.filter((h) => dayOf(h.arrive_at) === day)
}

/**
 * Whether any hop touches an ISO `day` — used to mark the calendar cell. A hop
 * whose depart and arrive fall on the same day still counts once.
 */
export function hasTransportOn(day: string, hops: Transport[]): boolean {
  return hops.some((h) => dayOf(h.depart_at) === day || dayOf(h.arrive_at) === day)
}
