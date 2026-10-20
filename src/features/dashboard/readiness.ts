/**
 * Pre-trip **readiness** derivations (#414). The dashboard is phase-adaptive —
 * it leads with the Today card (#281) `during` the trip and the Trip recap
 * (#206) `after` it — but the `before` phase, the weeks a group is actually
 * assembling the plan, had no dedicated card. This is the missing readiness
 * surface: a deterministic `sum()`/filter over data TanStack Query has already
 * cached for the trip, answering "what still isn't ready before we go?".
 *
 * Every figure is a group-aware count a solo tool structurally can't surface —
 * who hasn't set dates, which nights have no bed, which polls still need the
 * viewer's vote. Pure, dependency-light module (only the erased `import type`
 * plus the pure `stayForDay` derivation) so the Node test runner imports it
 * directly after type-stripping, matching `today.ts` / `recap.ts`.
 */
import type { ChecklistItem, Member, Poll, Stay, Vote } from '@/types'
import { stayForDay } from '../stays/dates'

/** The readiness signals the card can surface, in display order. */
export type ReadinessKind = 'member-dates' | 'lodging' | 'checklist' | 'polls'

/**
 * One outstanding readiness signal. `count` is the headline figure (people,
 * nights, tasks, or polls); `unassigned` is a secondary count used only by
 * `checklist` (how many of the open tasks have no owner) and is 0 otherwise.
 * The card owns the copy, icon, and deep-link for each `kind` — this module
 * stays display-free so it can be unit-tested as pure data.
 */
export interface ReadinessSignal {
  kind: ReadinessKind
  count: number
  unassigned: number
}

/**
 * The minimal poll shape readiness needs: whether it's open and who has voted.
 * Structural (not the full `Poll`) so the card can pass the cached
 * `PollWithVotes` rows and a test can pass plain objects.
 */
export interface ReadinessPoll {
  closed: Poll['closed']
  closes_at: Poll['closes_at']
  votes: Pick<Vote, 'member_id'>[]
}

export interface ReadinessInput {
  /** The trip's own date range. A null on either side skips the lodging signal
   *  (an `undated` trip has no nights to cover). */
  startDate: string | null
  endDate: string | null
  members: Member[]
  stays: Stay[]
  checklist: ChecklistItem[]
  polls: ReadinessPoll[]
  /** The viewer's member id — polls they haven't voted in are "awaiting you". */
  myMemberId: string
  /** "now", for the open-poll comparison. Injectable so tests are deterministic;
   *  defaults to the current time. */
  now?: Date
}

const DAY_MS = 86_400_000

/** Midnight-UTC epoch ms of an ISO `YYYY-MM-DD`, so day stepping is DST-immune
 *  (the same calendar math `recap.ts` uses). */
function toUTC(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** The ISO `YYYY-MM-DD` of a midnight-UTC epoch ms. */
function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * A member who has shared neither an arrival nor a departure day. Both-null is
 * the schema's "here for the whole trip" default (#286), so this counts the
 * members who have not engaged with their dates at all — matching the card's
 * "N haven't shared their travel dates". A member who set even one end has said
 * something and is not nagged.
 */
function hasNoTripDates(m: Member): boolean {
  return !m.arrives_on && !m.departs_on
}

/**
 * Trip nights with no stay covering them. Nights are the half-open range
 * `[startDate, endDate)` — you need a bed every night from arrival through the
 * night before departure, but not the checkout morning you leave — which lines
 * up exactly with a stay's own half-open `[check_in, check_out)` window
 * (`stays/dates.ts`). A single-day or inverted range has zero nights. Dates are
 * required; an `undated` trip yields 0 (no lodging signal).
 */
function nightsWithoutLodging(
  startDate: string | null,
  endDate: string | null,
  stays: Stay[],
): number {
  if (!startDate || !endDate) return 0
  let count = 0
  for (let ms = toUTC(startDate); ms < toUTC(endDate); ms += DAY_MS) {
    if (!stayForDay(toISO(ms), stays)) count += 1
  }
  return count
}

/** Whether a poll would still accept a vote — the same predicate as
 *  `isPollOpen` (closed OR past `closes_at` means no), inlined so this module
 *  stays free of the non-pure polls `api.ts`. */
function isPollStillOpen(poll: ReadinessPoll, now: Date): boolean {
  if (poll.closed) return false
  if (poll.closes_at && new Date(poll.closes_at) < now) return false
  return true
}

/**
 * The outstanding readiness signals for a trip, each present only when it has a
 * non-zero count, in a stable display order (people → lodging → tasks → polls).
 * An empty array is the all-clear state the card renders as a positive empty
 * state. Nothing here fetches or mutates — it reads the already-cached rows the
 * card passes in.
 */
export function tripReadiness(input: ReadinessInput): ReadinessSignal[] {
  const { members, stays, checklist, polls, myMemberId } = input
  const now = input.now ?? new Date()
  const signals: ReadinessSignal[] = []

  const missingDates = members.filter(hasNoTripDates).length
  if (missingDates > 0) {
    signals.push({ kind: 'member-dates', count: missingDates, unassigned: 0 })
  }

  const noLodging = nightsWithoutLodging(input.startDate, input.endDate, stays)
  if (noLodging > 0) {
    signals.push({ kind: 'lodging', count: noLodging, unassigned: 0 })
  }

  const openTasks = checklist.filter((c) => !c.done)
  if (openTasks.length > 0) {
    const unassigned = openTasks.filter((c) => !c.assignee_id).length
    signals.push({ kind: 'checklist', count: openTasks.length, unassigned })
  }

  const awaitingMyVote = polls.filter(
    (p) => isPollStillOpen(p, now) && !p.votes.some((v) => v.member_id === myMemberId),
  ).length
  if (awaitingMyVote > 0) {
    signals.push({ kind: 'polls', count: awaitingMyVote, unassigned: 0 })
  }

  return signals
}
