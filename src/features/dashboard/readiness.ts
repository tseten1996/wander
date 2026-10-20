/**
 * "Before the trip" readiness derivations (#414).
 *
 * The dashboard is phase-adaptive: Today (#281) leads `during`, the recap
 * (#206) leads `after`. The one phase with no dedicated card is `before` — the
 * weeks the group is actually assembling the plan. This fills that gap with a
 * group-aware, read-only summary of what still isn't ready before they go.
 *
 * Every figure is a deterministic count over data already cached for the trip —
 * never a judgement, so no model is involved (the AI-architecture "deterministic
 * first" rule). Pure + dependency-light like `today.ts` / `recap.ts`: it imports
 * only erased `type`s plus the type-only `stayForDay` span helper, so the Node
 * test runner imports it directly after type-stripping.
 */
import type { ChecklistItem, Member, Poll, Stay, Vote } from '@/types'
import { stayForDay } from '../stays/dates'

/** The kinds of unresolved pre-trip signal. The card owns the label text for
 *  each; the helper only reports which fired and how many. */
export type ReadinessKey = 'member-dates' | 'lodging' | 'checklist' | 'polls'

/** One unresolved pre-trip signal: what it is, how many, and the tab that
 *  resolves it. `count` is always ≥ 1 — a cleared signal is omitted, never
 *  returned as a zero row. */
export interface ReadinessSignal {
  key: ReadinessKey
  count: number
  /** Relative route (under `/trip/:id`) the row deep-links to. */
  to: string
}

/** The minimal poll shape the readiness check needs — the open/closed fields
 *  plus the viewer's votes. Structurally compatible with `PollWithVotes` so the
 *  card passes its cached polls straight through, without this pure module
 *  importing the Supabase-bound polls api.ts. */
export type ReadinessPoll = Pick<Poll, 'closed' | 'closes_at'> & {
  votes: Pick<Vote, 'member_id'>[]
}

export interface ReadinessInput {
  startDate: string | null
  endDate: string | null
  members: Pick<Member, 'arrives_on' | 'departs_on'>[]
  stays: Stay[]
  checklist: Pick<ChecklistItem, 'done'>[]
  polls: ReadinessPoll[]
  /** The signed-in member's id — a poll they've already voted in isn't pending. */
  viewerId: string
  /** Comparison instant (ms) for a poll's `closes_at`; defaults to now. Injected
   *  in tests so the open/closed boundary is deterministic. */
  now?: number
}

/** Members who haven't said when they're coming — neither arrival nor departure
 *  set. A blank pair means "here for the whole trip" (#286), i.e. not yet
 *  stated, which is exactly the thing the group can't see at a glance today. */
export function membersMissingDates(
  members: Pick<Member, 'arrives_on' | 'departs_on'>[],
): number {
  return members.filter((m) => !m.arrives_on && !m.departs_on).length
}

/**
 * ISO days from `start` up to but NOT including `end` — the nights of a trip.
 * You sleep each night from the start date through the night before the end
 * date, then check out and leave on the end day, so the departure day is not a
 * night and never needs lodging. UTC calendar math (no date-fns, no DST drift),
 * the same discipline as recap.ts. Empty when `end <= start` (a day trip has no
 * nights).
 */
function nightsBetween(start: string, end: string): string[] {
  const toUTC = (iso: string): number => {
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  const out: string[] = []
  const endMs = toUTC(end)
  for (let ms = toUTC(start); ms < endMs; ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

/**
 * Trip nights with no stay covering them. A night `d` is covered when a stay's
 * half-open `[check_in, check_out)` contains it (`stayForDay`), the same rule
 * the calendar uses to assign a day to a stay (#348). An undated trip (missing
 * either endpoint) has no nights to check and returns 0, so the card degrades to
 * its lighter "set your dates" prompt rather than inventing gaps.
 */
export function nightsWithoutLodging(
  startDate: string | null,
  endDate: string | null,
  stays: Stay[],
): number {
  if (!startDate || !endDate) return 0
  let uncovered = 0
  for (const night of nightsBetween(startDate, endDate)) {
    if (!stayForDay(night, stays)) uncovered++
  }
  return uncovered
}

/** Checklist items still to do. */
export function openChecklistCount(checklist: Pick<ChecklistItem, 'done'>[]): number {
  return checklist.filter((c) => !c.done).length
}

/** Whether a poll would still accept votes — mirrors `isPollOpen` (polls/api.ts)
 *  inline so this pure module stays free of the feature's Supabase-bound code. */
function isOpen(poll: Pick<Poll, 'closed' | 'closes_at'>, now: number): boolean {
  if (poll.closed) return false
  if (poll.closes_at && new Date(poll.closes_at).getTime() < now) return false
  return true
}

/** Open polls the viewer hasn't voted in yet — the group is still waiting on
 *  their call. */
export function pendingPolls(polls: ReadinessPoll[], viewerId: string, now: number): number {
  return polls.filter(
    (p) => isOpen(p, now) && !p.votes.some((v) => v.member_id === viewerId),
  ).length
}

/**
 * The pre-trip readiness signals, in a stable "who → where → what → decide"
 * order, each omitted when it's already clear (zero missing dates → no row). An
 * empty result is the all-set state the card renders as a positive empty state.
 */
export function tripReadiness(input: ReadinessInput): ReadinessSignal[] {
  const now = input.now ?? Date.now()
  const signals: ReadinessSignal[] = []

  const missingDates = membersMissingDates(input.members)
  if (missingDates > 0) signals.push({ key: 'member-dates', count: missingDates, to: 'me' })

  const noLodging = nightsWithoutLodging(input.startDate, input.endDate, input.stays)
  if (noLodging > 0) signals.push({ key: 'lodging', count: noLodging, to: 'calendar' })

  const openTasks = openChecklistCount(input.checklist)
  if (openTasks > 0) signals.push({ key: 'checklist', count: openTasks, to: 'checklist' })

  const polls = pendingPolls(input.polls, input.viewerId, now)
  if (polls > 0) signals.push({ key: 'polls', count: polls, to: 'polls' })

  return signals
}
