/**
 * Time-based reminders (#195, epic #181 slice 3).
 *
 * Every stored notification in Wander is *reactive* — it exists only because a
 * member acted (assigned a task, opened a poll, logged an expense, @-mentioned
 * you). The failures that actually sink group trips are *time-based* and nobody
 * triggers them: a task due tomorrow and still open, the trip three days out
 * with half the packing undone, a poll closing tonight you haven't voted in.
 *
 * There is no actor to attribute such an event to, and the `notifications`
 * insert policy forbids an actor-less row — so these are **derived on the
 * client from data already cached by TanStack Query**, surfaced as an
 * ephemeral "reminders" section in the bell, and **never written to the DB**.
 *
 * This module is the single, pure place that turns cached rows into reminders,
 * so the bell, the badge, and the unit tests all agree. Pure and
 * dependency-free (only erased `import type`), so the Node test runner imports
 * it directly after stripping the types — matching `mentions.ts` / `spans.ts`.
 */

/** What kind of deadline a reminder is about — drives its icon and copy. */
export type ReminderKind = 'task_due' | 'trip_countdown' | 'poll_closing'

/** `urgent` = today/overdue/within-a-day; `upcoming` = further out. Drives the
 *  accent so the eye lands on what's actually running out first. */
export type ReminderTone = 'urgent' | 'upcoming'

export interface Reminder {
  /** Stable across renders so a session dismissal sticks: `<kind>:<entityId>`. */
  id: string
  kind: ReminderKind
  /** The trip tab this deep-links to (same tab slugs the inbox uses). */
  tab: string
  /** The row to scroll-to-and-flash on arrival; null for the trip-wide
   *  countdown, which has no single row. */
  entityId: string | null
  /** The subject line — the task / poll title, or the countdown headline. */
  title: string
  /** The deadline phrase — "Due tomorrow", "Closes in 5h", "3 items to pack". */
  detail: string
  tone: ReminderTone
  /** Milliseconds until the deadline (negative = past). Ascending sort puts the
   *  most-urgent reminder first, across all three kinds. */
  sortMs: number
}

/** A checklist item, narrowed to the fields a reminder reads. */
export interface ReminderTask {
  id: string
  title: string
  assignee_id: string | null
  due_date: string | null
  done: boolean
}

/** A poll, narrowed to the fields a reminder reads (votes for "have I voted"). */
export interface ReminderPoll {
  id: string
  question: string
  closed: boolean
  closes_at: string | null
  votes: { member_id: string }[]
}

/** A packing item, narrowed to just its packed flag. */
export interface ReminderPackingItem {
  packed: boolean
}

export interface ReminderInput {
  /** The signed-in member's id — reminders are always about *you*. */
  meId: string
  /** "Now" as an epoch-ms, passed in so the derivation is pure and testable. */
  now: number
  /** Used only to namespace the countdown reminder's dismissal id per trip. */
  tripId: string
  /** The trip's start date (`YYYY-MM-DD`) or null if undated. */
  tripStartDate: string | null
  checklist: ReminderTask[]
  polls: ReminderPoll[]
  packing: ReminderPackingItem[]
}

const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000

/** A task due within this many days (or overdue) surfaces as a reminder. */
export const TASK_DUE_WINDOW_DAYS = 2
/** A poll closing within this many hours (and unvoted) surfaces. */
export const POLL_CLOSING_WINDOW_HOURS = 48
/** The trip-countdown nudge appears once the start is within this many days. */
export const COUNTDOWN_WINDOW_DAYS = 7

/** UTC calendar day for an epoch-ms, as `YYYY-MM-DD` — matches how the rest of
 *  the app derives "today" (`new Date().toISOString().slice(0, 10)`). */
function ymdOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Parse a `YYYY-MM-DD` to a UTC epoch-ms, or null if it isn't a plain date. */
function parseYmd(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(ms) ? null : ms
}

/** Whole-day difference `to - from`, both `YYYY-MM-DD`; null on bad input. */
function dayDiff(fromYmd: string, toYmd: string): number | null {
  const from = parseYmd(fromYmd)
  const to = parseYmd(toYmd)
  if (from === null || to === null) return null
  return Math.round((to - from) / MS_PER_DAY)
}

/** "Due today" / "Due tomorrow" / "Due in N days" / "Overdue by N days". */
function dueDetail(days: number): string {
  if (days < 0) return days === -1 ? 'Overdue by 1 day' : `Overdue by ${-days} days`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}

/** "Trip starts today" / "…tomorrow" / "…in N days". */
function startsDetail(days: number): string {
  if (days <= 0) return 'Trip starts today'
  if (days === 1) return 'Trip starts tomorrow'
  return `Trip starts in ${days} days`
}

/** "Closing now" / "Closes in Nh" / "Closes in N days" from ms remaining. */
function closesDetail(ms: number): string {
  if (ms <= MS_PER_HOUR) return 'Closing within the hour'
  if (ms < MS_PER_DAY) return `Closes in ${Math.round(ms / MS_PER_HOUR)}h`
  const days = Math.round(ms / MS_PER_DAY)
  return days === 1 ? 'Closes in 1 day' : `Closes in ${days} days`
}

/**
 * Derive the full set of active reminders from already-cached data, most
 * urgent first. Pure: same inputs → same output, no clock read, no I/O. Session
 * dismissal is applied by the caller, not here.
 */
export function deriveReminders(input: ReminderInput): Reminder[] {
  const { meId, now, tripId, tripStartDate, checklist, polls, packing } = input
  const today = ymdOf(now)
  const reminders: Reminder[] = []

  // 1. My tasks: assigned to me, not done, due within the window or overdue.
  for (const task of checklist) {
    if (task.assignee_id !== meId || task.done || !task.due_date) continue
    const days = dayDiff(today, task.due_date)
    if (days === null || days > TASK_DUE_WINDOW_DAYS) continue
    reminders.push({
      id: `task_due:${task.id}`,
      kind: 'task_due',
      tab: 'checklist',
      entityId: task.id,
      title: task.title,
      detail: dueDetail(days),
      tone: days <= 0 ? 'urgent' : 'upcoming',
      sortMs: days * MS_PER_DAY,
    })
  }

  // 2. Trip countdown: start within the window and packing still unfinished.
  if (tripStartDate) {
    const days = dayDiff(today, tripStartDate)
    if (days !== null && days >= 0 && days <= COUNTDOWN_WINDOW_DAYS) {
      const unpacked = packing.filter((p) => !p.packed).length
      if (unpacked > 0) {
        reminders.push({
          id: `trip_countdown:${tripId}`,
          kind: 'trip_countdown',
          tab: 'packing',
          entityId: null,
          title: startsDetail(days),
          detail: `${unpacked} ${unpacked === 1 ? 'item' : 'items'} still to pack`,
          tone: days <= 2 ? 'urgent' : 'upcoming',
          sortMs: days * MS_PER_DAY,
        })
      }
    }
  }

  // 3. Polls closing soon that I still haven't voted in.
  for (const poll of polls) {
    if (poll.closed || !poll.closes_at) continue
    const closeMs = Date.parse(poll.closes_at)
    if (Number.isNaN(closeMs)) continue
    const remaining = closeMs - now
    if (remaining <= 0 || remaining > POLL_CLOSING_WINDOW_HOURS * MS_PER_HOUR) continue
    if (poll.votes.some((v) => v.member_id === meId)) continue
    reminders.push({
      id: `poll_closing:${poll.id}`,
      kind: 'poll_closing',
      tab: 'polls',
      entityId: poll.id,
      title: poll.question,
      detail: closesDetail(remaining),
      tone: remaining < MS_PER_DAY ? 'urgent' : 'upcoming',
      sortMs: remaining,
    })
  }

  return reminders.sort((a, b) => a.sortMs - b.sortMs)
}
