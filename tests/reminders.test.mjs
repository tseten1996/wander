/**
 * Unit tests for the derived time-based reminders
 * (src/features/notifications/reminders.ts, issue #195 — epic #181 slice 3).
 *
 * Pure module, exercised directly with the built-in Node test runner
 * (`node:test` + `node:assert`), matching tests/mentions.test.mjs. Node strips
 * the TypeScript types on import, so the module is tested exactly as it ships.
 *
 *   node --test tests/reminders.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveReminders,
  TASK_DUE_WINDOW_DAYS,
  POLL_CLOSING_WINDOW_HOURS,
  COUNTDOWN_WINDOW_DAYS,
} from '../src/features/notifications/reminders.ts'

const ME = 'me-0000'
const OTHER = 'other-000'
const TRIP = 'trip-0000'

// A fixed "now" so every test is deterministic: 2026-06-01T12:00:00Z.
const NOW = Date.parse('2026-06-01T12:00:00Z')
const DAY = 86_400_000
const HOUR = 3_600_000

/** YYYY-MM-DD, `days` from NOW's UTC date. */
function ymd(days) {
  return new Date(NOW + days * DAY).toISOString().slice(0, 10)
}

function base(overrides = {}) {
  return {
    meId: ME,
    now: NOW,
    tripId: TRIP,
    tripStartDate: null,
    checklist: [],
    polls: [],
    packing: [],
    ...overrides,
  }
}

function task(overrides = {}) {
  return {
    id: 't1',
    title: 'Book flights',
    assignee_id: ME,
    due_date: ymd(1),
    done: false,
    ...overrides,
  }
}

function poll(overrides = {}) {
  return {
    id: 'p1',
    question: 'Where to eat?',
    closed: false,
    closes_at: new Date(NOW + 5 * HOUR).toISOString(),
    votes: [],
    ...overrides,
  }
}

// ---- task_due ----------------------------------------------------------------

test('a task due tomorrow, assigned to me and not done, is a reminder', () => {
  const [r, ...rest] = deriveReminders(base({ checklist: [task({ due_date: ymd(1) })] }))
  assert.equal(rest.length, 0)
  assert.equal(r.kind, 'task_due')
  assert.equal(r.id, 'task_due:t1')
  assert.equal(r.tab, 'checklist')
  assert.equal(r.entityId, 't1')
  assert.equal(r.detail, 'Due tomorrow')
  assert.equal(r.tone, 'upcoming')
})

test('an overdue task is urgent with an "Overdue by" detail', () => {
  const [r] = deriveReminders(base({ checklist: [task({ due_date: ymd(-3) })] }))
  assert.equal(r.tone, 'urgent')
  assert.equal(r.detail, 'Overdue by 3 days')
})

test('a task due today reads "Due today" and is urgent', () => {
  const [r] = deriveReminders(base({ checklist: [task({ due_date: ymd(0) })] }))
  assert.equal(r.detail, 'Due today')
  assert.equal(r.tone, 'urgent')
})

test('a task beyond the due window is not a reminder', () => {
  const out = deriveReminders(
    base({ checklist: [task({ due_date: ymd(TASK_DUE_WINDOW_DAYS + 1) })] })
  )
  assert.equal(out.length, 0)
})

test('done, unassigned, someone-else’s, or date-less tasks never remind', () => {
  const out = deriveReminders(
    base({
      checklist: [
        task({ id: 'a', done: true }),
        task({ id: 'b', assignee_id: null }),
        task({ id: 'c', assignee_id: OTHER }),
        task({ id: 'd', due_date: null }),
      ],
    })
  )
  assert.equal(out.length, 0)
})

// ---- trip_countdown ----------------------------------------------------------

test('trip starting soon with unpacked items yields a countdown reminder', () => {
  const [r] = deriveReminders(
    base({ tripStartDate: ymd(3), packing: [{ packed: false }, { packed: true }] })
  )
  assert.equal(r.kind, 'trip_countdown')
  assert.equal(r.id, `trip_countdown:${TRIP}`)
  assert.equal(r.tab, 'packing')
  assert.equal(r.entityId, null)
  assert.equal(r.title, 'Trip starts in 3 days')
  assert.equal(r.detail, '1 item still to pack')
})

test('countdown is suppressed when everything is packed', () => {
  const out = deriveReminders(
    base({ tripStartDate: ymd(2), packing: [{ packed: true }, { packed: true }] })
  )
  assert.equal(out.length, 0)
})

test('countdown does not fire once the trip has already started', () => {
  const out = deriveReminders(base({ tripStartDate: ymd(-1), packing: [{ packed: false }] }))
  assert.equal(out.length, 0)
})

test('countdown does not fire outside the countdown window', () => {
  const out = deriveReminders(
    base({ tripStartDate: ymd(COUNTDOWN_WINDOW_DAYS + 1), packing: [{ packed: false }] })
  )
  assert.equal(out.length, 0)
})

// ---- poll_closing ------------------------------------------------------------

test('a poll closing soon that I have not voted in is a reminder', () => {
  const [r] = deriveReminders(base({ polls: [poll({ closes_at: new Date(NOW + 5 * HOUR).toISOString() })] }))
  assert.equal(r.kind, 'poll_closing')
  assert.equal(r.id, 'poll_closing:p1')
  assert.equal(r.tab, 'polls')
  assert.equal(r.entityId, 'p1')
  assert.equal(r.detail, 'Closes in 5h')
  assert.equal(r.tone, 'urgent')
})

test('a poll I have already voted in does not remind', () => {
  const out = deriveReminders(base({ polls: [poll({ votes: [{ member_id: ME }] })] }))
  assert.equal(out.length, 0)
})

test('a closed poll, an already-past close time, and no close date never remind', () => {
  const out = deriveReminders(
    base({
      polls: [
        poll({ id: 'a', closed: true }),
        poll({ id: 'b', closes_at: new Date(NOW - HOUR).toISOString() }),
        poll({ id: 'c', closes_at: null }),
      ],
    })
  )
  assert.equal(out.length, 0)
})

test('a poll closing beyond the window does not remind', () => {
  const out = deriveReminders(
    base({
      polls: [poll({ closes_at: new Date(NOW + (POLL_CLOSING_WINDOW_HOURS + 1) * HOUR).toISOString() })],
    })
  )
  assert.equal(out.length, 0)
})

test('a poll more than a day out is "upcoming", not urgent', () => {
  const [r] = deriveReminders(
    base({ polls: [poll({ closes_at: new Date(NOW + 30 * HOUR).toISOString() })] })
  )
  assert.equal(r.tone, 'upcoming')
  assert.equal(r.detail, 'Closes in 1 day')
})

// ---- ordering ----------------------------------------------------------------

test('reminders are returned most-urgent (soonest deadline) first', () => {
  const out = deriveReminders(
    base({
      checklist: [task({ id: 'far', due_date: ymd(2) })], // +2 days
      tripStartDate: ymd(1), // +1 day
      packing: [{ packed: false }],
      polls: [poll({ id: 'soon', closes_at: new Date(NOW + 2 * HOUR).toISOString() })], // +2h
    })
  )
  assert.deepEqual(
    out.map((r) => r.kind),
    ['poll_closing', 'trip_countdown', 'task_due']
  )
})
