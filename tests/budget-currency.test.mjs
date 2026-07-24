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
import { tripActual, tripEstimated, isForeignEntry } from '../src/features/budget/amounts.ts'
import { conversionRate, toCents, isSupportedCurrency } from '../src/lib/rates.ts'

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

test('settle-up input: mixed-currency payments reduce to converted amounts', () => {
  // computeBalances sums `tripActual(e)` over paid entries; this proves the
  // per-entry value it receives is the converted (trip-currency) amount, so a
  // €100 hotel and a $10 taxi pool as $110 + $10, never as raw 100 + 10.
  const hotel = entry({ actual: 100, currency: 'EUR', actual_converted: 110, paid_by: 'a' })
  const taxi = entry({ actual: 10, paid_by: 'b' })
  assert.equal(tripActual(hotel), 110)
  assert.equal(tripActual(taxi), 10)
  const pool = [hotel, taxi].reduce((s, e) => s + (tripActual(e) ?? 0), 0)
  assert.equal(pool, 120)
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
})

test('isSupportedCurrency knows the ECB set, case-insensitively', () => {
  assert.equal(isSupportedCurrency('eur'), true)
  assert.equal(isSupportedCurrency('USD'), true)
  assert.equal(isSupportedCurrency('XYZ'), false)
  assert.equal(isSupportedCurrency(null), false)
})
