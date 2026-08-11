/**
 * Unit tests for the #79 multi-currency budget logic:
 *   • src/features/budget/amounts.ts — trip-currency amount selection, the
 *     value every roll-up (totals, category bars, settle-up) computes on
 *   • src/lib/rates.ts               — pure conversion helpers
 *
 * Same convention as tests/overlap.test.mjs: Node (>= 22.18) strips the
 * TypeScript types on import, and every `@/types` import in these modules is
 * type-only (erased), so the path alias never needs resolving. Only leaf
 * modules are imported — the Node loader doesn't append extensions to
 * relative imports, so settlement.ts (which imports `./amounts`) is exercised
 * via its `tripActual` input rather than imported directly. No browser, no
 * network — `fetchRates` is not exercised here (it hits the ECB API).
 *
 *   node --test tests/budget-currency.test.mjs   # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { tripActual, tripEstimated, isForeignEntry } from '../src/features/budget/amounts.ts'
import {
  conversionRate, toCents, isSupportedCurrency, seededExpenseRate,
} from '../src/lib/rates.ts'

// settlement.ts is not a leaf module — it value-imports './amounts' without an
// extension (the repo-wide convention that the Vite/tsc bundler resolver
// handles). Node's raw type-stripping loader won't append '.ts' to a bare
// relative specifier, so importing settlement.ts directly would fail. Register
// a resolve hook that supplies the missing '.ts' for extensionless relative
// imports, purely so the test can exercise the real computeBalances rather than
// re-implementing its aggregation. App source stays untouched.
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
const { computeBalances } = await import('../src/features/budget/settlement.ts')

// Minimal budget row with the currency columns; unlisted fields are irrelevant
// to the functions under test.
function entry(o = {}) {
  return {
    estimated: null,
    actual: null,
    currency: null,
    estimated_converted: null,
    actual_converted: null,
    exchange_rate: null,
    paid_by: null,
    category: 'other',
    ...o,
  }
}

test('trip-currency entry: converted is null, raw amount is used', () => {
  const e = entry({ estimated: 100, actual: 80 })
  assert.equal(tripEstimated(e), 100)
  assert.equal(tripActual(e), 80)
  assert.equal(isForeignEntry(e, 'USD'), false)
})

test('foreign entry: converted amount wins over the raw foreign amount', () => {
  const e = entry({
    estimated: 40, actual: 40, currency: 'EUR',
    estimated_converted: 43, actual_converted: 43, exchange_rate: 1.075,
  })
  assert.equal(tripEstimated(e), 43)
  assert.equal(tripActual(e), 43)
  assert.equal(isForeignEntry(e, 'USD'), true)
  assert.equal(isForeignEntry(e, 'eur'), false) // case-insensitive, same currency
})

test('null actual stays null (unpaid entry), estimate still resolves', () => {
  const e = entry({ estimated: 40, actual: null, currency: 'EUR', estimated_converted: 43 })
  assert.equal(tripActual(e), null)
  assert.equal(tripEstimated(e), 43)
})

test('computeBalances: mixed-currency payments settle on converted amounts', () => {
  // Exercise the real settlement code: a €100 hotel (converted $110) paid by A
  // and a $10 taxi paid by B pool as $110 + $10 = $120, split evenly ($60 each).
  // Proves computeBalances reads tripActual (the converted amount), not the raw
  // foreign figures — a €100+$10 = 110 mis-sum would surface here.
  const members = [
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Ben' },
  ]
  const hotel = entry({ actual: 100, currency: 'EUR', actual_converted: 110, paid_by: 'a' })
  const taxi = entry({ actual: 10, paid_by: 'b' })
  const balances = computeBalances([hotel, taxi], members)
  const byId = Object.fromEntries(balances.map((b) => [b.member.id, b]))
  assert.equal(byId.a.paid, 110) // converted, not the raw €100
  assert.equal(byId.b.paid, 10)
  assert.equal(byId.a.net, 50) // fronted 110, share 60 → owed 50
  assert.equal(byId.b.net, -50) // fronted 10, share 60 → owes 50
})

test('computeBalances: payments by a non-member are excluded from the pool', () => {
  // Payer filtering: an entry attributed to someone no longer on the trip must
  // not create a debt or inflate the shared pool.
  const members = [
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Ben' },
  ]
  const mine = entry({ actual: 60, paid_by: 'a' })
  const ghost = entry({ actual: 999, currency: 'EUR', actual_converted: 999, paid_by: 'gone' })
  const balances = computeBalances([mine, ghost], members)
  const byId = Object.fromEntries(balances.map((b) => [b.member.id, b]))
  assert.equal(byId.a.paid, 60)
  assert.equal(byId.a.net, 30) // pool 60, share 30
  assert.equal(byId.b.net, -30)
})

test('computeBalances: an entry splits across only its participants (#104)', () => {
  // A $150 dinner shared by 3 of the 5 members, paid by A. Only A, B, C owe a
  // $50 share; D and E — who didn't go — owe nothing.
  const members = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id }))
  const dinner = entry({ actual: 150, paid_by: 'a', participants: ['a', 'b', 'c'] })
  const byId = Object.fromEntries(
    computeBalances([dinner], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 100) // fronted 150, own share 50
  assert.equal(byId.b.net, -50)
  assert.equal(byId.c.net, -50)
  assert.equal(byId.d.net, 0) // didn't share it
  assert.equal(byId.e.net, 0)
})

test('computeBalances: duplicate participant ids are deduped (no double share)', () => {
  // `participants` is client-written and any trip member can craft a raw array
  // via PostgREST, so a repeated id must not slip through as a weighted split
  // (out of scope for this slice). ['a','a','b'] must settle exactly like
  // ['a','b'] — A and B each bear half of the $100, not A two-thirds.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const e = entry({ actual: 100, paid_by: 'a', participants: ['a', 'a', 'b'] })
  const byId = Object.fromEntries(
    computeBalances([e], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 50) // fronted 100, own share 50 (not 100 * 2/3)
  assert.equal(byId.b.net, -50) // owes half, not a third
})

test('computeBalances: null / empty participants keep the shared-by-all default', () => {
  // Both encodings of "everyone" must settle identically to the pre-#104 pool
  // split — this is what guarantees existing rows need no backfill.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  for (const participants of [null, []]) {
    const e = entry({ actual: 80, paid_by: 'a', participants })
    const byId = Object.fromEntries(
      computeBalances([e], members).map((b) => [b.member.id, b]),
    )
    assert.equal(byId.a.net, 40) // pool 80, split evenly across both
    assert.equal(byId.b.net, -40)
  }
})

test('computeBalances: a participant who left redistributes among the rest', () => {
  // Dinner split three ways, but C has since left the trip. The cost now
  // divides across the two remaining participants (A, B), not the original 3.
  const members = ['a', 'b', 'd'].map((id) => ({ id, name: id }))
  const dinner = entry({ actual: 150, paid_by: 'a', participants: ['a', 'b', 'c'] })
  const byId = Object.fromEntries(
    computeBalances([dinner], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 75) // fronted 150, share now 75
  assert.equal(byId.b.net, -75)
  assert.equal(byId.d.net, 0) // never a participant
})

test('computeBalances: if every participant left, the cost falls back to everyone', () => {
  // A degenerate subset whose members all departed must not silently drop the
  // amount — it reverts to a shared-by-all split so the payer is still made whole.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const e = entry({ actual: 100, paid_by: 'a', participants: ['x', 'y'] })
  const byId = Object.fromEntries(
    computeBalances([e], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 50) // shared across all current members
  assert.equal(byId.b.net, -50)
})

/* ── Weighted / unequal splits (#203) ─────────────────────────────────────── */

test('computeBalances: a shares map divides an entry by weight, not equally (#203)', () => {
  // A fronts a $120 room split 2:1 — A took the suite, B the bunk. A bears
  // 2/3 ($80), B 1/3 ($40), instead of $60 each. A net = 120 − 80 = +40.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const room = entry({ actual: 120, paid_by: 'a', shares: { a: 2, b: 1 } })
  const byId = Object.fromEntries(
    computeBalances([room], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 40)
  assert.equal(byId.b.net, -40)
})

test('computeBalances: exact-amount weights reproduce the entered amounts (#203)', () => {
  // "By exact amount" stores the per-member amounts as weights; a $100 bill
  // split $30/$70 must charge exactly that. Weight sum equals the total, so
  // amount * weight_i / Σ = weight_i.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const bill = entry({ actual: 100, paid_by: 'a', shares: { a: 30, b: 70 } })
  const byId = Object.fromEntries(
    computeBalances([bill], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 70) // fronted 100, own share 30
  assert.equal(byId.b.net, -70)
})

test('computeBalances: percentage weights split by proportion (#203)', () => {
  // "By percent" stores percentages as weights (they sum to 100), so a $200
  // cost at 25%/75% charges $50 / $150.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const e = entry({ actual: 200, paid_by: 'a', shares: { a: 25, b: 75 } })
  const byId = Object.fromEntries(
    computeBalances([e], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 150) // fronted 200, own share 50
  assert.equal(byId.b.net, -150)
})

test('computeBalances: weighted split settles on the converted amount (#203)', () => {
  // Trip USD. A €100 hotel frozen at $110, paid by A, weighted 1:3 between A
  // and B. Settle-up must weight the $110 converted figure, not the raw €100:
  // A bears 110/4 = 27.5, B bears 82.5.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const hotel = entry({
    actual: 100, currency: 'EUR', actual_converted: 110, paid_by: 'a',
    shares: { a: 1, b: 3 },
  })
  const byId = Object.fromEntries(
    computeBalances([hotel], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.paid, 110)
  assert.equal(byId.a.net, 82.5) // fronted 110, own share 27.5
  assert.equal(byId.b.net, -82.5)
})

test('computeBalances: a weighted sharer who left redistributes by remaining weight (#203)', () => {
  // Room split 1:1:2 among A, B, C, but C has since left. The cost now divides
  // by the two remaining weights (1:1) over the $100 → $50 each, not a third.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const room = entry({ actual: 100, paid_by: 'a', shares: { a: 1, b: 1, c: 2 } })
  const byId = Object.fromEntries(
    computeBalances([room], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 50) // fronted 100, own share 50
  assert.equal(byId.b.net, -50)
})

test('computeBalances: non-positive / non-numeric weights are dropped (#203)', () => {
  // Defensive: shares is client-written. A zero weight means "no share" and a
  // NaN is meaningless — both must be excluded so they never poison the
  // division. $90 with weights {a:2, b:1, c:0} splits 2:1 over A and B only.
  const members = ['a', 'b', 'c'].map((id) => ({ id, name: id }))
  const e = entry({ actual: 90, paid_by: 'a', shares: { a: 2, b: 1, c: 0 } })
  const byId = Object.fromEntries(
    computeBalances([e], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 30) // fronted 90, own share 60
  assert.equal(byId.b.net, -30)
  assert.equal(byId.c.net, 0) // zero weight → no share
})

test('computeBalances: a shares map whose members all left falls back to equal (#203)', () => {
  // Every weighted sharer has departed → no usable weight, so the cost reverts
  // to a shared-by-all equal split rather than being dropped, keeping the payer
  // whole (same safety net as the participants path).
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const e = entry({ actual: 100, paid_by: 'a', shares: { x: 1, y: 3 } })
  const byId = Object.fromEntries(
    computeBalances([e], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 50) // equal split across current members
  assert.equal(byId.b.net, -50)
})

test('computeBalances: an empty shares map behaves as an equal split (#203 additive)', () => {
  // null and {} both mean "no weighting" — existing rows (shares absent) and a
  // cleared map settle exactly as the equal participants split, so no backfill
  // is needed.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  for (const shares of [null, {}, undefined]) {
    const e = entry({ actual: 80, paid_by: 'a', shares })
    const byId = Object.fromEntries(
      computeBalances([e], members).map((b) => [b.member.id, b]),
    )
    assert.equal(byId.a.net, 40)
    assert.equal(byId.b.net, -40)
  }
})

test('computeBalances: shares override participants when both are present (#203)', () => {
  // A weighted map is authoritative for who shares. If a stale `participants`
  // set disagrees, the weights win — C, absent from the map, owes nothing even
  // though participants still lists them.
  const members = ['a', 'b', 'c'].map((id) => ({ id, name: id }))
  const e = entry({
    actual: 100, paid_by: 'a', participants: ['a', 'b', 'c'], shares: { a: 1, b: 1 },
  })
  const byId = Object.fromEntries(
    computeBalances([e], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 50) // 1:1 over A and B only
  assert.equal(byId.b.net, -50)
  assert.equal(byId.c.net, 0)
})

test('computeBalances: a recorded repayment nets the debtor and creditor toward zero (#125)', () => {
  // A fronted a $100 cost split two ways → A +50, B -50. B then Venmos A $50.
  // Recording that repayment must square both sides to zero, not leave B still
  // owing on the card. `amount_converted` null → the raw trip-currency amount.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const cost = entry({ actual: 100, paid_by: 'a' })
  const repayment = { from_member: 'b', to_member: 'a', amount: 50, amount_converted: null }
  const byId = Object.fromEntries(
    computeBalances([cost], members, [repayment]).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 0) // was owed 50, received it back
  assert.equal(byId.b.net, 0) // owed 50, paid it
  assert.equal(byId.a.paid, 100) // repayments never touch the expense pool
})

test('computeBalances: a partial repayment leaves the remaining balance (#125)', () => {
  // B owes A 50 but only pays back 20 → B still owes 30, A is still owed 30.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const cost = entry({ actual: 100, paid_by: 'a' })
  const repayment = { from_member: 'b', to_member: 'a', amount: 20, amount_converted: null }
  const byId = Object.fromEntries(
    computeBalances([cost], members, [repayment]).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 30)
  assert.equal(byId.b.net, -30)
})

test('computeBalances: a multi-currency repayment nets on its converted amount (#125)', () => {
  // Trip in USD. B owes A 50. B pays back €45, frozen at $50 (amount_converted).
  // Settle-up must net the $50, not the raw €45 — same converted footing as the
  // expenses it squares up.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const cost = entry({ actual: 100, paid_by: 'a' })
  const repayment = {
    from_member: 'b', to_member: 'a', amount: 45, currency: 'EUR',
    amount_converted: 50, exchange_rate: 1.111,
  }
  const byId = Object.fromEntries(
    computeBalances([cost], members, [repayment]).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 0)
  assert.equal(byId.b.net, 0)
})

test('computeBalances: a repayment involving a departed member is skipped (#125)', () => {
  // A repayment whose payer or payee is no longer on the trip is meaningless;
  // applying just one side would break the sum-to-zero invariant settle-up needs.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const cost = entry({ actual: 100, paid_by: 'a' })
  const ghostRepayment = { from_member: 'b', to_member: 'gone', amount: 50, amount_converted: null }
  const byId = Object.fromEntries(
    computeBalances([cost], members, [ghostRepayment]).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 50) // unchanged — the repayment did not net
  assert.equal(byId.b.net, -50)
})

test('computeBalances: no repayments settles exactly as before (#125 additive)', () => {
  // The new third argument defaults to [] — existing two-arg call sites and rows
  // with no repayments must be untouched.
  const members = ['a', 'b'].map((id) => ({ id, name: id }))
  const cost = entry({ actual: 80, paid_by: 'a' })
  const byId = Object.fromEntries(
    computeBalances([cost], members).map((b) => [b.member.id, b]),
  )
  assert.equal(byId.a.net, 40)
  assert.equal(byId.b.net, -40)
})

test('dashboard roll-up sums the converted amount, not the raw foreign figure (#118)', () => {
  // Regression for #118: the Overview budget card summed raw `actual`, so a
  // ¥100,000 hotel (~$650 converted) on a USD trip rendered "$100,000". The
  // dashboard now rolls up with tripActual/tripEstimated — identical to the
  // Budget page — so both screens agree.
  const rows = [
    entry({ estimated: 100000, actual: 100000, currency: 'JPY',
            estimated_converted: 650, actual_converted: 650 }),
    entry({ estimated: 200, actual: 180 }), // trip-currency entry, no conversion
  ]
  const spent = rows.reduce((s, b) => s + (tripActual(b) ?? 0), 0)
  const planned = rows.reduce((s, b) => s + (tripActual(b) ?? tripEstimated(b) ?? 0), 0)
  assert.equal(spent, 830) // 650 + 180, not 100180
  assert.equal(planned, 830)
})

test('dashboard roll-up: entry with no converted amount falls back to raw, no NaN (#118)', () => {
  // A trip-currency entry (converted null) contributes its raw amount; a wholly
  // empty entry contributes 0 — never NaN.
  const rows = [entry({ actual: 50 }), entry({ estimated: 20 }), entry({})]
  const spent = rows.reduce((s, b) => s + (tripActual(b) ?? 0), 0)
  const planned = rows.reduce((s, b) => s + (tripActual(b) ?? tripEstimated(b) ?? 0), 0)
  assert.equal(spent, 50)
  assert.equal(planned, 70) // 50 + 20 + 0
  assert.ok(!Number.isNaN(planned))
})

test('conversionRate inverts the trip-based table; missing currency → null', () => {
  // Table is keyed by the trip currency (USD): 1 USD = 0.9 EUR, 150 JPY.
  const rates = { USD: 1, EUR: 0.9, JPY: 150 }
  // 1 EUR → 1/0.9 USD
  assert.ok(Math.abs(conversionRate('EUR', rates) - 1 / 0.9) < 1e-9)
  assert.equal(conversionRate('USD', rates), 1)
  assert.equal(conversionRate('gbp', rates), null) // not in table
})

test('toCents rounds to two decimals', () => {
  assert.equal(toCents(43.005), 43.01)
  assert.equal(toCents(100 * 1.0759), 107.59)
  // Half-cent boundary: 1.005 * 100 is 100.4999… in IEEE-754, so a naive
  // Math.round would floor it to 1.00 and freeze a converted amount a cent low.
  assert.equal(toCents(1.005), 1.01)
})

test('seededExpenseRate: changing a saved entry to a new currency re-seeds from the live table (#145)', () => {
  // Trip USD; a saved EUR entry frozen at 1.10. The member switches the dropdown
  // to GBP. The seeded rate must come from *today's* table for GBP, not linger on
  // the old EUR rate — the bug wrote a wrong converted amount into settle-up.
  const rates = { USD: 1, EUR: 0.9, GBP: 0.8 }
  const seeded = seededExpenseRate('GBP', 'EUR', 1.1, rates)
  assert.ok(Math.abs(seeded - toCents((1 / 0.8) * 10000) / 10000) < 1e-9)
  assert.notEqual(seeded, 1.1) // did not keep the stale EUR rate
})

test('seededExpenseRate: re-selecting the entry\'s own currency restores its frozen rate (#145)', () => {
  // Back on the entry's original EUR: restore the historical 1.10 it was saved
  // at, NOT today's 1/0.9 — history is never silently re-rated.
  const rates = { USD: 1, EUR: 0.9 }
  assert.equal(seededExpenseRate('EUR', 'EUR', 1.1, rates), 1.1)
  assert.equal(seededExpenseRate('eur', 'EUR', 1.1, rates), 1.1) // case-insensitive
})

test('seededExpenseRate: a new entry (no saved currency) always takes the live rate (#145)', () => {
  const rates = { USD: 1, JPY: 150 }
  assert.equal(seededExpenseRate('JPY', undefined, undefined, rates), toCents((1 / 150) * 10000) / 10000)
})

test('seededExpenseRate: frozen rate restores even when the live table is unavailable (#145)', () => {
  // Rates down: the only foreign option is the entry's own saved currency, and
  // its frozen rate must still restore so the field is never left blank/stale.
  assert.equal(seededExpenseRate('EUR', 'EUR', 1.1, undefined), 1.1)
  // A different currency with no table has nothing to seed → null (leave as-is).
  assert.equal(seededExpenseRate('GBP', 'EUR', 1.1, undefined), null)
})

test('seededExpenseRate: a currency the table cannot price yields null (#145)', () => {
  const rates = { USD: 1, EUR: 0.9 }
  assert.equal(seededExpenseRate('GBP', null, null, rates), null)
})

test('isSupportedCurrency knows the ECB set, case-insensitively', () => {
  assert.equal(isSupportedCurrency('eur'), true)
  assert.equal(isSupportedCurrency('USD'), true)
  assert.equal(isSupportedCurrency('XYZ'), false)
  assert.equal(isSupportedCurrency(null), false)
})
