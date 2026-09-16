/**
 * Unit tests for member payment links (src/features/budget/paymentLink.ts,
 * issue #347 — settle-up "Pay" affordance).
 *
 * Pure module with no runtime imports, so the built-in Node test runner
 * exercises it directly (Node strips the TypeScript types and never resolves the
 * `@/` alias), matching tests/stays.test.mjs and tests/settlement.test.mjs.
 *
 *   node --test tests/payment-link.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePaymentLink, buildPaymentUrl } from '../src/features/budget/paymentLink.ts'

test('normalizePaymentLink upgrades a scheme-less handle to https', () => {
  assert.equal(normalizePaymentLink('paypal.me/alex'), 'https://paypal.me/alex')
  assert.equal(normalizePaymentLink('venmo.com/u/alex'), 'https://venmo.com/u/alex')
  assert.equal(normalizePaymentLink('revolut.me/alex'), 'https://revolut.me/alex')
})

test('normalizePaymentLink keeps an explicit https link', () => {
  assert.equal(normalizePaymentLink('https://paypal.me/alex'), 'https://paypal.me/alex')
})

test('normalizePaymentLink trims and rejects blank', () => {
  assert.equal(normalizePaymentLink('  https://paypal.me/alex  '), 'https://paypal.me/alex')
  assert.equal(normalizePaymentLink(''), null)
  assert.equal(normalizePaymentLink('   '), null)
  assert.equal(normalizePaymentLink(null), null)
  assert.equal(normalizePaymentLink(undefined), null)
})

test('normalizePaymentLink rejects non-https schemes — no script/redirect sink', () => {
  // The security core: a declared scheme is never laundered into https.
  assert.equal(normalizePaymentLink('javascript:alert(1)'), null)
  assert.equal(normalizePaymentLink('JavaScript:alert(1)'), null)
  assert.equal(normalizePaymentLink('data:text/html,<script>x</script>'), null)
  assert.equal(normalizePaymentLink('http://paypal.me/alex'), null) // plain http rejected
  assert.equal(normalizePaymentLink('vbscript:msgbox(1)'), null)
  assert.equal(normalizePaymentLink('  javascript:alert(1)'), null) // leading space, still rejected
})

test('buildPaymentUrl (PayPal.me) appends amount + currency to a bare handle', () => {
  assert.equal(
    buildPaymentUrl({ link: 'paypal.me/alex', amount: 40, currency: 'EUR', note: 'Rome settle-up' }),
    'https://paypal.me/alex/40.00EUR'
  )
  // Rounds to 2 decimals.
  assert.equal(
    buildPaymentUrl({ link: 'https://paypal.me/alex', amount: 12.5, currency: 'usd', note: 'x' }),
    'https://paypal.me/alex/12.50USD'
  )
})

test('buildPaymentUrl (PayPal.me) leaves a link that already has an amount path alone', () => {
  // Member pasted their own amount — don't stack a second segment on it.
  assert.equal(
    buildPaymentUrl({ link: 'paypal.me/alex/5', amount: 40, currency: 'EUR', note: 'x' }),
    'https://paypal.me/alex/5'
  )
})

test('buildPaymentUrl (Venmo) adds txn/amount/note query params', () => {
  const url = new URL(
    buildPaymentUrl({ link: 'venmo.com/u/alex', amount: 40, currency: 'EUR', note: 'Rome settle-up' })
  )
  assert.equal(url.origin + url.pathname, 'https://venmo.com/u/alex')
  assert.equal(url.searchParams.get('txn'), 'pay')
  assert.equal(url.searchParams.get('amount'), '40.00')
  assert.equal(url.searchParams.get('note'), 'Rome settle-up')
})

test('buildPaymentUrl opens an unknown target unchanged (Revolut, plain https)', () => {
  // We don't invent a deep-link shape we can't be sure of.
  assert.equal(
    buildPaymentUrl({ link: 'revolut.me/alex', amount: 40, currency: 'EUR', note: 'x' }),
    'https://revolut.me/alex'
  )
  assert.equal(
    buildPaymentUrl({ link: 'https://pay.me/alex', amount: 40, currency: 'EUR', note: 'x' }),
    'https://pay.me/alex'
  )
  // www. is stripped only for matching; the returned href keeps the host as given.
  assert.equal(
    buildPaymentUrl({ link: 'https://www.paypal.me/alex', amount: 40, currency: 'EUR', note: 'x' }),
    'https://www.paypal.me/alex/40.00EUR'
  )
})

test('buildPaymentUrl returns null for no/invalid link or non-positive amount', () => {
  assert.equal(buildPaymentUrl({ link: null, amount: 40, currency: 'EUR', note: 'x' }), null)
  assert.equal(buildPaymentUrl({ link: '', amount: 40, currency: 'EUR', note: 'x' }), null)
  assert.equal(buildPaymentUrl({ link: 'javascript:alert(1)', amount: 40, currency: 'EUR', note: 'x' }), null)
  assert.equal(buildPaymentUrl({ link: 'paypal.me/alex', amount: 0, currency: 'EUR', note: 'x' }), null)
  assert.equal(buildPaymentUrl({ link: 'paypal.me/alex', amount: -5, currency: 'EUR', note: 'x' }), null)
})
