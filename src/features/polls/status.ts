import type { Poll } from '@/types'

/** Whether a poll would still accept votes: not manually closed, and not past
 *  its close time. The single source of truth the polls list, the dashboard
 *  tallies (`dashboard/api.ts`) and the "my open polls" view (`me/api.ts`)
 *  share — kept in this dependency-free module so it can be unit-tested
 *  directly, and re-exported from `polls/api.ts` for its existing importers. */
export function isPollOpen(poll: Pick<Poll, 'closed' | 'closes_at'>): boolean {
  if (poll.closed) return false
  if (poll.closes_at && new Date(poll.closes_at) < new Date()) return false
  return true
}

/** The `polls` update that genuinely reopens a poll (#411).
 *
 *  Flipping `closed` back to `false` on its own is a silent no-op once the close
 *  time has passed: `isPollOpen` stays false because `closes_at` is still in the
 *  past, so the poll remains dead and the "Reopen" button looks broken.
 *  Reopening therefore also clears a past `closes_at` — the poll becomes open
 *  until someone closes it by hand. A still-future close time is preserved, so
 *  reopening a manually-closed poll simply lifts the manual close and its
 *  scheduled expiry stands. `now` is injectable so the rule can be tested
 *  without depending on the wall clock. */
export function reopenPatch(
  poll: Pick<Poll, 'closes_at'>,
  now: Date = new Date(),
): { closed: false; closes_at?: null } {
  const expired = !!poll.closes_at && new Date(poll.closes_at) < now
  return expired ? { closed: false, closes_at: null } : { closed: false }
}
