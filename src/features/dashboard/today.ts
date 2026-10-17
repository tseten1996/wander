/**
 * "During the trip" dashboard derivations (#281). When today falls inside a
 * trip's dates the dashboard leads with a Today card instead of the planning
 * countdown; these pure helpers decide the trip phase and pick today's items in
 * the order they happen. Kept dependency-light (only the erased `import type`
 * plus the pure span helpers) so the Node test runner imports it directly after
 * type-stripping, matching `spans.ts` / `recap.ts`.
 */
import type { ItineraryItem, Stay, Transport } from '@/types'
import { isSpanning } from '../itinerary/spans'
import { departingOn, arrivingOn } from '../transport/dates'

/**
 * Where an ISO `today` (`YYYY-MM-DD`) sits relative to a trip's dates. `during`
 * is inclusive of both the start and end day — the group is on the trip. A trip
 * missing either date is `undated` and keeps the planning view unchanged. ISO
 * date strings compare lexicographically, so plain `<` / `>` are calendar-correct.
 */
export type TripPhase = 'before' | 'during' | 'after' | 'undated'

export function tripPhase(
  startDate: string | null,
  endDate: string | null,
  today: string,
): TripPhase {
  if (!startDate || !endDate) return 'undated'
  if (today < startDate) return 'before'
  if (today > endDate) return 'after'
  return 'during'
}

/**
 * Single-day itinerary items scheduled for `today`, in the order they happen:
 * timed items first in ascending start-time order, then untimed items in their
 * saved position. Multi-day spans (#166) are excluded — they render as their
 * own bands above the list, exactly as on the itinerary page.
 */
export function todaysItems(items: ItineraryItem[], today: string): ItineraryItem[] {
  return items
    .filter((i) => !isSpanning(i) && i.day === today)
    .sort(byTimeThenPosition)
}

function byTimeThenPosition(a: ItineraryItem, b: ItineraryItem): number {
  if (a.start_time && b.start_time) {
    return a.start_time.localeCompare(b.start_time) || a.position - b.position
  }
  // A timed item sorts before an untimed one; two untimed keep their position.
  if (a.start_time) return -1
  if (b.start_time) return 1
  return a.position - b.position
}

/**
 * The id of the next item still ahead of `nowTime` (an ISO `HH:mm[:ss]`) among
 * today's items, or null when every timed item has already started (or none
 * carries a time). `items` is expected pre-sorted by `todaysItems`, so the
 * first item whose start time hasn't passed is the next one up.
 */
export function nextUpcomingId(items: ItineraryItem[], nowTime: string): string | null {
  const next = items.find((i) => i.start_time != null && i.start_time >= nowTime)
  return next?.id ?? null
}

// --- Logistics on the day-of card (#405) ------------------------------------
//
// The structured logistics tables (stays #348, transport #350) shipped after
// the Today card (#281) and were never wired to it, so on the days that matter
// most — the morning you check out, the afternoon you catch a train — the card
// was silent while the calendar and the AI day-context (#375) already read them.
// These pure helpers fold the already-cached stays and transport into the card,
// reusing the feature's own per-day derivations (`departingOn` / `arrivingOn`,
// and the `[check_in, check_out)` rule) so no new query is introduced.

/** A stay the group checks into or out of on a given day — the transition, not
 *  merely a night spent inside a stay (that already shows as a calendar band and
 *  adds no day-of signal). */
export interface StayTransition {
  stay: Stay
  kind: 'check-in' | 'check-out'
}

/**
 * The check-out and check-in transitions landing on an ISO `day`. A stay's
 * window is half-open `[check_in, check_out)`, so the check-out *date* is the
 * morning you leave and the check-in *date* is the afternoon you arrive — only
 * those edge days carry a transition. A day that merely falls inside a stay
 * yields nothing. Check-outs come first (you leave one place before arriving at
 * the next). Stays store date-only windows (no clock time), so a transition
 * names the stay and the day, never an invented time.
 */
export function stayTransitionsForDay(day: string, stays: Stay[]): StayTransition[] {
  const out: StayTransition[] = []
  for (const s of stays) if (s.check_out === day) out.push({ stay: s, kind: 'check-out' })
  for (const s of stays) if (s.check_in === day) out.push({ stay: s, kind: 'check-in' })
  return out
}

/**
 * One slot in today's happen-order sequence: either a single-day itinerary item
 * or a transport hop's departure/arrival. Transport always carries a wall-clock
 * time (a hop only lands on a day via its `depart_at` / `arrive_at`), so only an
 * itinerary item can be untimed. A hop that both departs and arrives today
 * produces two entries, each with its own id (`<hopId>:depart` / `:arrive`).
 */
export type DayEntry =
  | { kind: 'item'; id: string; time: string | null; position: number; item: ItineraryItem }
  | { kind: 'transport'; id: string; time: string; direction: 'depart' | 'arrive'; hop: Transport }

/** Minutes-resolution `HH:mm` for comparison, from an `HH:mm[:ss]` clock time or
 *  the time half of a `YYYY-MM-DDTHH:mm[:ss]` datetime. Null stays null. */
function clockOf(value: string | null): string | null {
  if (!value) return null
  const t = value.includes('T') ? value.slice(11) : value
  return t.slice(0, 5) || null
}

/**
 * Today's itinerary items and transport hops merged into the order they happen:
 * timed entries ascending by wall-clock time (ties by itinerary position, a hop
 * sorting ahead of a same-minute item), then untimed itinerary items in their
 * saved position. Multi-day itinerary spans (#166) are excluded — they render as
 * their own bands, exactly as `todaysItems` leaves them. Mirrors the time order
 * `todaysItems` produced for items alone, now with transport interleaved.
 */
export function todaysTimeline(
  items: ItineraryItem[],
  hops: Transport[],
  today: string,
): DayEntry[] {
  const entries: DayEntry[] = []
  for (const i of items) {
    if (!isSpanning(i) && i.day === today) {
      entries.push({ kind: 'item', id: i.id, time: clockOf(i.start_time), position: i.position, item: i })
    }
  }
  for (const h of departingOn(today, hops)) {
    entries.push({ kind: 'transport', id: `${h.id}:depart`, time: clockOf(h.depart_at)!, direction: 'depart', hop: h })
  }
  for (const h of arrivingOn(today, hops)) {
    entries.push({ kind: 'transport', id: `${h.id}:arrive`, time: clockOf(h.arrive_at)!, direction: 'arrive', hop: h })
  }
  return entries.sort(byEntryTime)
}

/** A hop has no saved position; it sorts ahead of a same-minute itinerary item. */
function entryPosition(e: DayEntry): number {
  return e.kind === 'item' ? e.position : -1
}

function byEntryTime(a: DayEntry, b: DayEntry): number {
  if (a.time && b.time) {
    return a.time < b.time ? -1 : a.time > b.time ? 1 : entryPosition(a) - entryPosition(b)
  }
  // A timed entry sorts before an untimed one; two untimed keep their position.
  if (a.time) return -1
  if (b.time) return 1
  return entryPosition(a) - entryPosition(b)
}

/**
 * The id of the next timeline entry still ahead of `nowTime` (an `HH:mm[:ss]`),
 * so the "next up" highlight lands on whichever comes next — a timed itinerary
 * item *or* a transport hop — or null once every timed entry has passed (or none
 * carries a time). `entries` is expected pre-sorted by `todaysTimeline`.
 */
export function nextTimelineId(entries: DayEntry[], nowTime: string): string | null {
  const now = nowTime.slice(0, 5)
  const next = entries.find((e) => e.time != null && e.time >= now)
  return next?.id ?? null
}
