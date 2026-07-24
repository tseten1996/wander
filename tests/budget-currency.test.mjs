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
import { conversionRate, toCents, isSupportedCurrency } from '../src/lib/rates.ts'

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

test('isSupportedCurrency knows the ECB set, case-insensitively', () => {
  assert.equal(isSupportedCurrency('eur'), true)
  assert.equal(isSupportedCurrency('USD'), true)
  assert.equal(isSupportedCurrency('XYZ'), false)
  assert.equal(isSupportedCurrency(null), false)
})
