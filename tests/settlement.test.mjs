/**
 * Unit tests for `minimalTransfers()` in src/features/budget/settlement.ts —
 * the greedy "who pays who" settle-up the group actually acts on to square up
 * after a trip. `computeBalances` (net balance per member) is already covered by
 * tests/budget-currency.test.mjs; this file locks down the transfer set derived
 * from those balances, which had no direct coverage. A refactor that produced a
 * non-settling or non-minimal transfer set would previously pass CI silently —
 * these assertions make it fail.
 *
 * Every case checks the two properties the output must hold, whatever the
 * algorithm:
 *   • reconciliation — applying the transfers drives every member's net to zero
 *   • minimality     — the transfer count never exceeds (non-zero members − 1),
 *     the ceiling a correct minimal settle-up guarantees; exact counts are
 *     asserted where the case pins one down.
 *
 * Same module-loading convention as tests/budget-currency.test.mjs: Node's
 * type-stripping loader won't append '.ts' to settlement.ts's extensionless
 * value-import of './amounts', so a resolve hook supplies it. minimalTransfers
 * itself takes plain Balance objects, so the tests build them directly rather
 * than routing through computeBalances.
 *
 *   node --test tests/settlement.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context) } catch {}
  }
  return nextResolve(specifier, context)
}`),
)
const { minimalTransfers } = await import('../src/features/budget/settlement.ts')

// The same half-cent tolerance settlement.ts settles on (EPSILON), plus a hair
// for the per-transfer cent rounding that can accumulate across a few legs.
const CENT = 0.02

// A Balance is { member, paid, net }; minimalTransfers only reads member + net.
// `paid` is irrelevant to the transfer computation, so it's set to 0 here.
function bal(id, net) {
  return { member: { id, name: id }, paid: 0, net }
}

// Apply the suggested transfers to a copy of the nets: a payer (from) reduces
// their debt (net rises toward 0), a payee (to) is made whole (net falls toward
// 0). If the set truly settles the group, every residual net is ~0.
function residualNets(balances, transfers) {
  const net = new Map(balances.map((b) => [b.member.id, b.net]))
  for (const t of transfers) {
    net.set(t.from.id, net.get(t.from.id) + t.amount)
    net.set(t.to.id, net.get(t.to.id) - t.amount)
  }
  return net
}

function assertReconciles(balances, transfers) {
  for (const [id, residual] of residualNets(balances, transfers)) {
    assert.ok(
      Math.abs(residual) <= CENT,
      `member ${id} not settled: residual ${residual}`,
    )
  }
}

// Every transfer must be a real, positive payment between two distinct members —
// a self-transfer or a zero/negative leg is meaningless output.
function assertWellFormed(transfers) {
  for (const t of transfers) {
    assert.notEqual(t.from.id, t.to.id, 'transfer from a member to themselves')
    assert.ok(t.amount > 0, `non-positive transfer amount ${t.amount}`)
  }
}

// Minimality ceiling: a correct minimal settle-up never needs more than
// (members with a non-zero balance − 1) transfers.
function nonZeroCount(balances) {
  return balances.filter((b) => Math.abs(b.net) > 0.005).length
}

test('already-settled pool: no transfers', () => {
  const balances = [bal('a', 0), bal('b', 0), bal('c', 0)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 0)
  assertReconciles(balances, transfers)
})

test('sub-cent dust reads as settled: still no transfers', () => {
  // Floating-point residue below EPSILON must not manufacture a phantom
  // "A pays B $0.00" leg.
  const balances = [bal('a', 0.004), bal('b', -0.004)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 0)
  assertReconciles(balances, transfers)
})

test('two members: a single owe/owed pair settles in one transfer', () => {
  // B owes 50, A is owed 50 → exactly one transfer B → A of 50.
  const balances = [bal('a', 50), bal('b', -50)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 1)
  assertWellFormed(transfers)
  assert.equal(transfers[0].from.id, 'b')
  assert.equal(transfers[0].to.id, 'a')
  assert.equal(transfers[0].amount, 50)
  assertReconciles(balances, transfers)
})

test('three-member split: one creditor, two debtors → two transfers', () => {
  // A fronted a $100 group cost split three ways: A owed +66.67, B and C owe
  // ~33.33 each. Both debtors must pay the sole creditor, so two transfers is
  // minimal — one is impossible.
  const balances = [bal('a', 66.66), bal('b', -33.33), bal('c', -33.33)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 2)
  assert.ok(transfers.length <= nonZeroCount(balances) - 1)
  assertWellFormed(transfers)
  // Both legs flow to the single creditor A; neither debtor pays the other.
  for (const t of transfers) assert.equal(t.to.id, 'a')
  assertReconciles(balances, transfers)
})

test('chain collapses: an intermediary nets to zero and is bypassed', () => {
  // The classic chain A owes B, B owes C by the same amount: B's net is zero,
  // so the minimal set is the single direct transfer A → C — B is never
  // routed through. A greedy set that produced two legs (A→B, B→C) would be
  // non-minimal and this fails it.
  const balances = [bal('a', -30), bal('b', 0), bal('c', 30)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 1)
  assert.equal(transfers[0].from.id, 'a')
  assert.equal(transfers[0].to.id, 'c')
  assert.equal(transfers[0].amount, 30)
  assertReconciles(balances, transfers)
})

test('multi-member chain: five mixed balances settle minimally', () => {
  // Two creditors (A +90, B +30) and three debtors (C -50, D -40, E -30).
  // Pool is balanced (120 owed, 120 owing). A minimal set is at most
  // (5 − 1) = 4 transfers, and every member must come out square.
  const balances = [
    bal('a', 90),
    bal('b', 30),
    bal('c', -50),
    bal('d', -40),
    bal('e', -30),
  ]
  const transfers = minimalTransfers(balances)
  assert.ok(
    transfers.length <= nonZeroCount(balances) - 1,
    `expected ≤ 4 transfers, got ${transfers.length}`,
  )
  assertWellFormed(transfers)
  assertReconciles(balances, transfers)
})

test('rounding edge: uneven thirds reconcile within a cent', () => {
  // $100 split three ways leaves nets that do not sum cleanly in cents:
  // A +66.67, B -33.33, C -33.34 (the greedy match rounds each leg to the
  // cent). The set must still bring every member to within a cent of zero —
  // no member left holding rounding dust as a real debt.
  const balances = [bal('a', 66.67), bal('b', -33.33), bal('c', -33.34)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 2)
  assertWellFormed(transfers)
  for (const t of transfers) {
    // Cent-quantised output: no fractional-cent amounts leak to the UI. Compare
    // against the source's own rounding op so the check is float-safe — a
    // refactor that dropped the rounding (emitting a raw 33.333…) would fail.
    assert.equal(t.amount, Math.round(t.amount * 100) / 100)
  }
  assertReconciles(balances, transfers)
})

test('transfer amounts are rounded to the nearest cent', () => {
  // A one-leg case whose exact amount carries a third decimal proves the
  // cent-rounding applies to the emitted amount, not just to reconciliation:
  // 20.256 must surface as 20.26, never 20.256.
  const balances = [bal('a', 20.256), bal('b', -20.256)]
  const transfers = minimalTransfers(balances)
  assert.equal(transfers.length, 1)
  assert.equal(transfers[0].amount, 20.26)
  assertReconciles(balances, transfers)
})
