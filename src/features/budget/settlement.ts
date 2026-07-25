import type { BudgetEntry, Member } from '@/types'
import { tripActual } from './amounts'

/**
 * "Who owes who" settlement math for the Budget page.
 *
 * Only money that was *actually paid* (`actual != null`) *by a specific member*
 * (`paid_by` is a current member) counts as real spending on the group's behalf.
 * Each entry's amount is shared across *its participants* only (issue 104): the
 * members who actually split that cost. An entry with no participant set
 * (`participants` null or empty) is shared by all current members — the historic
 * default — so existing rows settle exactly as before. A member's net is what
 * they fronted minus the sum of their per-entry shares. Positive = they're owed
 * money, negative = they owe. Shared / not-yet-paid entries never create a debt.
 *
 * If every named participant of an entry has since left the trip, the entry
 * falls back to being shared by all current members so the money paid is still
 * accounted for rather than silently dropped; a participant who left while
 * others remain simply drops out and their share redistributes across the rest.
 *
 * Amounts are always taken in the *trip currency* (via `tripActual`), so a
 * multi-currency trip settles correctly — an EUR hotel and a USD flight are
 * compared on the same converted footing, never as raw mixed numbers.
 */

export interface Balance {
  member: Member
  /** Total this member actually paid on the group's behalf. */
  paid: number
  /** Paid minus fair share. Positive: owed to them. Negative: they owe. */
  net: number
}

export interface Transfer {
  from: Member
  to: Member
  amount: number
}

/** Half a cent — smooths floating-point dust so near-zero balances read as settled. */
const EPSILON = 0.005

export function computeBalances(entries: BudgetEntry[], members: Member[]): Balance[] {
  if (members.length === 0) return []
  const memberIds = members.map((m) => m.id)
  const isMember = new Set(memberIds)

  const paid = new Map<string, number>(memberIds.map((id) => [id, 0]))
  const owed = new Map<string, number>(memberIds.map((id) => [id, 0]))
  for (const e of entries) {
    const amount = tripActual(e)
    if (amount == null || !e.paid_by) continue
    if (!isMember.has(e.paid_by)) continue // payer is no longer a member — skip

    // Who shares this cost: the entry's participants restricted to current
    // members, or everyone when unset/empty (the historic default). If every
    // named participant has since left, fall back to everyone so the amount is
    // still accounted for rather than dropped.
    const named = (e.participants ?? []).filter((id) => isMember.has(id))
    const sharers = named.length > 0 ? named : memberIds

    paid.set(e.paid_by, (paid.get(e.paid_by) ?? 0) + amount)
    const share = amount / sharers.length
    for (const id of sharers) owed.set(id, (owed.get(id) ?? 0) + share)
  }

  return members.map((member) => {
    const p = paid.get(member.id) ?? 0
    const o = owed.get(member.id) ?? 0
    return { member, paid: p, net: p - o }
  })
}

/**
 * Greedy minimal-transfer settle-up: repeatedly match the largest debtor to the
 * largest creditor. Produces at most (members - 1) transfers.
 */
export function minimalTransfers(balances: Balance[]): Transfer[] {
  const debtors = balances
    .filter((b) => b.net < -EPSILON)
    .map((b) => ({ member: b.member, amount: -b.net }))
    .sort((a, b) => b.amount - a.amount)
  const creditors = balances
    .filter((b) => b.net > EPSILON)
    .map((b) => ({ member: b.member, amount: b.net }))
    .sort((a, b) => b.amount - a.amount)

  const transfers: Transfer[] = []
  let i = 0
  let j = 0
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]
    const c = creditors[j]
    const amount = Math.min(d.amount, c.amount)
    if (amount > EPSILON) {
      transfers.push({
        from: d.member,
        to: c.member,
        amount: Math.round(amount * 100) / 100,
      })
    }
    d.amount -= amount
    c.amount -= amount
    if (d.amount <= EPSILON) i++
    if (c.amount <= EPSILON) j++
  }
  return transfers
}

/** True when at least one entry attributes a real payment to a member. */
export function hasSettlementData(entries: BudgetEntry[]): boolean {
  return entries.some((e) => e.actual != null && !!e.paid_by)
}

/** True when every member's net balance is effectively zero. */
export function isAllSettled(balances: Balance[]): boolean {
  return balances.every((b) => Math.abs(b.net) <= EPSILON)
}
