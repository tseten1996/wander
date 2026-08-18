/*
  Candidate day plans, generated and scored in code (#213).

  This module exists because of a measurement, not a preference. Two models
  three tiers apart were asked to *propose* changes to the same Paris day, and
  both made the identical mistake: each resolved one conflict by creating
  another later the same afternoon, and each missed an 8.5 km backtrack it had
  been handed as data. Scaling the model did not fix it, so the task was shaped
  wrong — asking for a schedule is asking a model to satisfy a combined
  temporal-and-spatial constraint problem in one pass, which is exactly the
  "locally plausible, globally incoherent" failure that was observed.

  So the schedule is authored here. Every candidate this module returns is
  conflict-free and respects its fixed anchors BY CONSTRUCTION — the model never
  sees a plan it could break, because it never writes one. Its job is reduced to
  choosing among plans we validated and saying why, which is a judgement, and
  judgement is the only thing worth paying a model for (§7).

  Nothing here touches the network, a clock, or a database. It is a pure
  function from a day to a small set of plans, which is what makes the claims
  above testable rather than aspirational.
*/
import { estimateLeg, haversineKm, toGeoPoint } from '../../lib/geo'

/** One itinerary row as `get_ai_day_context` returns it. */
export interface DayItem {
  id: string
  title: string
  category: string
  /** `HH:MM` or `HH:MM:SS` as Postgres `time` serializes it, or null. */
  startTime: string | null
  endTime: string | null
  day: string | null
  endDay: string | null
  location: string | null
  lat: number | null
  lng: number | null
  position: number
}

/**
 * Categories nobody in the group controls the timing of. A flight leaves when
 * the airline says, a table is booked for a time, a transfer is booked. Moving
 * one is not a suggestion, it is a rebooking — so these are treated as walls to
 * schedule around rather than blocks to shuffle.
 *
 * `activity` and `free` are the two that a group genuinely chooses the time of,
 * and they are the only two this module will ever move.
 */
const FIXED_CATEGORIES = new Set(['flight', 'hotel', 'restaurant', 'transport'])

/**
 * How long a timed item with no end time is assumed to occupy.
 *
 * A single number for every such item, deliberately: the alternative is a
 * per-category table of durations, which is more assumptions dressed as more
 * precision. This one is reported to the user in `assumptions` rather than
 * quietly applied — a plan built on a guess should say which guess.
 */
export const DEFAULT_MINUTES = 60

/**
 * How much travel a reshuffle has to save before it is worth proposing, and
 * what each moved item costs in that arithmetic.
 *
 * Without these the generator would offer to rearrange someone's afternoon to
 * save 300 metres. `MOVE_PENALTY_KM` makes churn a cost rather than a free
 * variable, so a plan that moves one item beats an equal-scoring plan that
 * moves four.
 */
export const MIN_IMPROVEMENT_KM = 0.5
export const MOVE_PENALTY_KM = 0.3

/**
 * Above this many movable items, exhaustive permutation stops being free
 * (7! = 5040 placements) and the generator switches to nearest-neighbour tours.
 * The switch is reported in `notes` — a silent cap reads as "we considered
 * everything" when we did not.
 */
export const MAX_PERMUTED = 6

/** Largest number of plans handed to the model. Output tokens are the expensive side. */
export const MAX_CANDIDATES = 3

/**
 * The latest a generated plan may finish, as minutes since midnight.
 *
 * Only ever reached by an over-committed day. Resolving an overlap means the
 * items need more hours than they currently occupy, and there are exactly two
 * ways to find them: run later, or make something shorter. Shortening a visit
 * is editing what the group wanted; running later is a change they can see and
 * decline — so the generator takes the second, says so, and stops at 22:00
 * rather than proposing a museum at midnight.
 */
export const LATEST_END = 22 * 60

/* ── time helpers ────────────────────────────────────────────────────────── */

/** Minutes since midnight, or null for an absent or malformed time. */
export function toMinutes(t: string | null): number | null {
  if (!t) return null
  const [h, m] = t.split(':')
  const hours = Number(h)
  const mins = Number(m ?? 0)
  if (!Number.isInteger(hours) || !Number.isInteger(mins)) return null
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null
  return hours * 60 + mins
}

/** Minutes since midnight back to `HH:MM`. */
export function toHm(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`
}

/* ── classification ──────────────────────────────────────────────────────── */

interface Scheduled {
  item: DayItem
  start: number
  end: number
  /** True when `end` came from DEFAULT_MINUTES rather than from the item. */
  assumedEnd: boolean
}

export interface DayShape {
  /** Timed, single-day, not-ours-to-move. Walls the plan schedules around. */
  anchors: Scheduled[]
  /** Timed activities and free time — the only things this module will move. */
  movable: Scheduled[]
  /** Everything left out, with the reason, so nothing is silently ignored. */
  excluded: { id: string; title: string; reason: string }[]
}

/**
 * Split a day into what can move, what cannot, and what this module refuses to
 * reason about.
 *
 * The `excluded` list is not bookkeeping — it is the honesty requirement. An
 * item with no time cannot be *moved*, only *given* a time, which is inventing
 * information the group never supplied; an item with no coordinates cannot be
 * weighed in a travel score at all. Both are reported so a suggestion can say
 * what it did not look at, the way `DayDirectionsAction` already says "3 of 5
 * stops".
 */
export function classifyDay(items: DayItem[], day: string): DayShape {
  const anchors: Scheduled[] = []
  const movable: Scheduled[] = []
  const excluded: DayShape['excluded'] = []

  for (const item of items) {
    // A stay that spans this day was scheduled on another one; its check-in
    // time says nothing about today, so it neither blocks nor moves. Leaving it
    // in as a wall would block 15:00 on every night of the stay.
    if (item.day && item.endDay && item.endDay > item.day && item.day !== day) {
      excluded.push({ id: item.id, title: item.title, reason: 'spans several days' })
      continue
    }

    const start = toMinutes(item.startTime)
    if (start == null) {
      excluded.push({ id: item.id, title: item.title, reason: 'no start time' })
      continue
    }

    const rawEnd = toMinutes(item.endTime)
    const assumedEnd = rawEnd == null || rawEnd <= start
    const end = assumedEnd ? start + DEFAULT_MINUTES : rawEnd
    const scheduled: Scheduled = { item, start, end, assumedEnd }

    if (FIXED_CATEGORIES.has(item.category)) anchors.push(scheduled)
    else movable.push(scheduled)
  }

  anchors.sort((a, b) => a.start - b.start)
  movable.sort((a, b) => a.start - b.start)
  return { anchors, movable, excluded }
}

/* ── scoring ─────────────────────────────────────────────────────────────── */

/**
 * Straight-line travel across a day's located stops, in kilometres.
 *
 * Items without coordinates are skipped rather than guessed at, which means the
 * chain closes over them: A → (unlocated) → C scores the A→C distance. That is
 * the honest reading — we know the group goes from A to C, we just cannot see
 * the detour. Callers report the count so a number built from half a day is
 * never presented as if it were the whole one.
 */
export function travelKm(ordered: Scheduled[]): { km: number; located: number } {
  const points = ordered
    .map((s) => toGeoPoint({ latitude: s.item.lat, longitude: s.item.lng }))
    .filter((p): p is NonNullable<typeof p> => p != null)
  let km = 0
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i])
  return { km, located: points.length }
}

/** Pairs of items whose intervals intersect. Touching endpoints do not count. */
export function countConflicts(ordered: Scheduled[]): number {
  let n = 0
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[i].start < ordered[j].end && ordered[j].start < ordered[i].end) n++
    }
  }
  return n
}

/* ── generation ──────────────────────────────────────────────────────────── */

export interface PlanAction {
  itemId: string
  title: string
  /** `HH:MM`. Always set — a plan that changes nothing is not a plan. */
  startTime: string
  /** `HH:MM`, or null for an item that never had an end time. See below. */
  endTime: string | null
}

export interface Candidate {
  /** Stable within one request; what the model returns to choose a plan. */
  id: string
  /** The items whose times change, in the new order. Never includes anchors. */
  actions: PlanAction[]
  /** Straight-line kilometres across the day's located stops under this plan. */
  travelKm: number
  /** How many items move. Fewer is better at equal travel. */
  moved: number
  /** Ordered titles, for the prompt and the preview card. */
  order: string[]
  /**
   * Every item on the day in the new order, anchors included, as ids.
   *
   * Separate from `actions` because they answer different questions: an action
   * changes a *time*, this fixes the *list order*. The anchors do not move in
   * time but they do move relative to the items around them, and the itinerary
   * list is sorted by `position` — so without this, applying a plan would
   * rearrange the clock and leave the list looking untouched.
   */
  sequence: string[]
  /** When the last movable stop finishes, `HH:MM`. Surfaced so a plan that runs
   *  later than the group's own finish is something they can see and decline. */
  endsAt: string
}

export interface DayPlans {
  /** The day as it stands: what any candidate has to beat. */
  baseline: { travelKm: number; conflicts: number; located: number; total: number }
  candidates: Candidate[]
  /** Assumptions and caps applied, stated rather than buried. */
  notes: string[]
  excluded: DayShape['excluded']
}

/** Every ordering of a list. Only ever called with MAX_PERMUTED or fewer. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs]
  const out: T[][] = []
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)]
    for (const p of permutations(rest)) out.push([xs[i], ...p])
  }
  return out
}

/**
 * Nearest-neighbour tours, one per possible first stop.
 *
 * The fallback above MAX_PERMUTED. Not optimal and not claimed to be — the
 * point is that a long day still gets a handful of genuinely different, valid
 * orderings to choose between rather than nothing at all.
 */
function greedyTours(movable: Scheduled[]): Scheduled[][] {
  const tours: Scheduled[][] = []
  for (let seed = 0; seed < movable.length; seed++) {
    const remaining = movable.filter((_, i) => i !== seed)
    const tour = [movable[seed]]
    while (remaining.length) {
      const from = toGeoPoint({
        latitude: tour[tour.length - 1].item.lat,
        longitude: tour[tour.length - 1].item.lng,
      })
      let best = 0
      if (from) {
        let bestKm = Infinity
        remaining.forEach((cand, i) => {
          const to = toGeoPoint({ latitude: cand.item.lat, longitude: cand.item.lng })
          // An unlocated candidate cannot be compared on distance, so it waits
          // rather than being assigned an invented one.
          const km = to ? haversineKm(from, to) : Infinity
          if (km < bestKm) {
            bestKm = km
            best = i
          }
        })
      }
      tour.push(remaining.splice(best, 1)[0])
    }
    tours.push(tour)
  }
  return tours
}

/**
 * How late a plan may run.
 *
 * Normally the group's own finishing time — a rearrangement should give back
 * the same day in a better order. But a day whose items overlap is a day asking
 * for more hours than it has, and no reordering fixes that inside the original
 * span. When the items provably cannot fit, the window extends to LATEST_END
 * and the caller reports it.
 */
function windowEndFor(movable: Scheduled[], anchors: Scheduled[]): { end: number; extended: boolean } {
  const start = Math.min(...movable.map((s) => s.start))
  const natural = Math.max(...movable.map((s) => s.end))
  const needed = movable.reduce((sum, s) => sum + (s.end - s.start), 0)
  // Available minutes inside the natural window once the anchors are removed.
  // Transit is ignored here on purpose: this is a lower bound on what is
  // needed, so it only extends the day when it is definitely impossible.
  const blocked = anchors.reduce(
    (sum, a) => sum + Math.max(0, Math.min(a.end, natural) - Math.max(a.start, start)),
    0,
  )
  if (needed <= natural - start - blocked) return { end: natural, extended: false }
  return { end: Math.max(natural, LATEST_END), extended: true }
}

/**
 * Free intervals inside the day's window, with the anchors cut out.
 *
 * The start is never moved earlier than the group's own earliest stop: an
 * 07:30 museum proposed because the arithmetic worked out is a day nobody
 * agreed to. The end is the caller's to decide — see `windowEndFor`.
 */
function freeWindows(
  movable: Scheduled[],
  anchors: Scheduled[],
  windowEnd: number,
): [number, number][] {
  const windowStart = Math.min(...movable.map((s) => s.start))
  let windows: [number, number][] = [[windowStart, windowEnd]]

  for (const a of anchors) {
    const next: [number, number][] = []
    for (const [ws, we] of windows) {
      if (a.end <= ws || a.start >= we) {
        next.push([ws, we])
        continue
      }
      if (a.start > ws) next.push([ws, a.start])
      if (a.end < we) next.push([a.end, we])
    }
    windows = next
  }
  return windows.sort((x, y) => x[0] - y[0])
}

/**
 * Minutes to get from one stop to the next, or 0 when either is unlocated.
 *
 * Zero is the honest answer for an unlocated pair — not "probably 20 minutes" —
 * and it is reported through the same "travel could not be measured" note that
 * covers the distance score.
 */
function transitMinutes(from: Scheduled, to: Scheduled): number {
  const a = toGeoPoint({ latitude: from.item.lat, longitude: from.item.lng })
  const b = toGeoPoint({ latitude: to.item.lat, longitude: to.item.lng })
  if (!a || !b) return 0
  return Math.ceil(estimateLeg(a, b).minutes)
}

/**
 * Lay one ordering into the free windows, earliest-fit, preserving durations
 * and leaving room to travel between consecutive stops.
 *
 * Returns null when it does not fit — which is the mechanism behind "every
 * candidate is valid by construction". An ordering that cannot be placed
 * without colliding with an anchor or with itself simply never becomes a
 * candidate; there is no repair step that could leave a broken plan behind.
 *
 * The transit gap matters more than it looks. Packing stops back to back is
 * precisely the "locally plausible, globally incoherent" plan this module
 * exists to rule out: it would let a candidate win on paper by assuming the
 * group teleports across the city, and it is the arithmetic version of the
 * mistake both measured models made.
 */
function place(order: Scheduled[], windows: [number, number][]): Scheduled[] | null {
  const placed: Scheduled[] = []
  let wi = 0
  let cursor = windows.length ? windows[0][0] : 0

  for (const s of order) {
    const duration = s.end - s.start
    const prev = placed[placed.length - 1]
    // Crossing into a later window means an anchor sits between the two stops,
    // and whatever travel that implies is the anchor's problem, not this gap's.
    const withTravel = prev ? cursor + transitMinutes(prev, s) : cursor
    let from = withTravel
    while (wi < windows.length) {
      const [ws, we] = windows[wi]
      if (Math.max(from, ws) + duration <= we) break
      wi++
      if (wi < windows.length) from = windows[wi][0]
    }
    if (wi >= windows.length) return null
    const start = Math.max(from, windows[wi][0])
    placed.push({ ...s, start, end: start + duration })
    cursor = start + duration
  }
  return placed
}

/**
 * Generate, score and rank the plans worth showing for one day.
 *
 * Returns an empty `candidates` array — never a fabricated one — when the day
 * cannot be improved: fewer than two movable items, nothing that fits, or
 * nothing that beats today by more than MIN_IMPROVEMENT_KM. The caller turns
 * that into a plain message and makes no model call.
 */
export function planDay(items: DayItem[], day: string): DayPlans {
  const { anchors, movable, excluded } = classifyDay(items, day)
  const notes: string[] = []

  const current = [...anchors, ...movable].sort((a, b) => a.start - b.start)
  const currentTravel = travelKm(current)
  const baseline = {
    travelKm: currentTravel.km,
    conflicts: countConflicts(current),
    located: currentTravel.located,
    total: current.length,
  }

  if (movable.some((s) => s.assumedEnd) || anchors.some((s) => s.assumedEnd)) {
    notes.push(`Items with no end time are assumed to last ${DEFAULT_MINUTES} minutes.`)
  }
  if (baseline.located < baseline.total) {
    notes.push(
      `${baseline.total - baseline.located} of ${baseline.total} stops have no location, so travel could not be measured for them.`,
    )
  }

  // Two movable items is the floor: with one there is no ordering to choose
  // between, and "improving" it would mean moving it somewhere for its own sake.
  if (movable.length < 2) return { baseline, candidates: [], notes, excluded }

  const naturalEnd = Math.max(...movable.map((s) => s.end))
  const { end: windowEnd, extended } = windowEndFor(movable, anchors)
  const windows = freeWindows(movable, anchors, windowEnd)
  let orders: Scheduled[][]
  if (movable.length <= MAX_PERMUTED) {
    orders = permutations(movable)
  } else {
    orders = greedyTours(movable)
    notes.push(
      `This day has ${movable.length} movable items, so ${orders.length} routes were compared rather than every possible order.`,
    )
  }

  const seen = new Set<string>()
  const scored: Candidate[] = []
  for (const order of orders) {
    const placed = place(order, windows)
    if (!placed) continue

    // Signature over the resulting schedule, not the input order: two different
    // permutations that land on the same times are the same plan.
    const signature = placed.map((s) => `${s.item.id}@${s.start}`).join('|')
    if (seen.has(signature)) continue
    seen.add(signature)

    const full = [...anchors, ...placed].sort((a, b) => a.start - b.start)
    const moved = placed.filter((s) => s.start !== toMinutes(s.item.startTime)).length
    scored.push({
      id: `plan-${scored.length + 1}`,
      travelKm: travelKm(full).km,
      moved,
      endsAt: toHm(placed[placed.length - 1].end),
      order: full.map((s) => s.item.title),
      sequence: full.map((s) => s.item.id),
      actions: placed.map((s) => ({
        itemId: s.item.id,
        title: s.item.title,
        startTime: toHm(s.start),
        // An item that never had an end time does not gain one here. The
        // duration was an assumption used to lay the day out; writing it back
        // would turn that assumption into data the group never entered.
        endTime: s.assumedEnd ? null : toHm(s.end),
      })),
    })
  }

  const cost = (c: Candidate) => c.travelKm + MOVE_PENALTY_KM * c.moved
  const worthwhile = scored
    .filter((c) => c.moved > 0)
    .filter(
      (c) =>
        // A candidate earns its place by saving real distance, or by resolving
        // a collision the day currently has. Both are things the group can see.
        c.travelKm + MIN_IMPROVEMENT_KM <= baseline.travelKm || baseline.conflicts > 0,
    )
    .sort((a, b) => cost(a) - cost(b))
    .slice(0, MAX_CANDIDATES)
    // Re-id after ranking so `plan-1` always means "the top-scored plan", which
    // is what the fallback in the handler falls back to.
    .map((c, i) => ({ ...c, id: `plan-${i + 1}` }))

  if (worthwhile.length) {
    notes.push('Travel between stops is a straight-line estimate, so allow a little slack.')
    if (extended && worthwhile.some((c) => toMinutes(c.endsAt)! > naturalEnd)) {
      notes.push(
        `These items need more hours than ${toHm(naturalEnd)} allows, so the day runs later.`,
      )
    }
  }

  return { baseline, candidates: worthwhile, notes, excluded }
}
