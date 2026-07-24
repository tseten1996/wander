/**
 * Unit tests for the booking-confirmation parser
 * (src/features/itinerary/parse.ts, issue #77).
 *
 * Exercises the pure `parseBooking` heuristic directly — no browser, no
 * Supabase, no preview server — with the built-in Node test runner
 * (`node:test` + `node:assert`), matching the convention of the existing
 * `tests/overlap.test.mjs` and `tests/smoke.mjs` harnesses.
 *
 * Node strips the TypeScript types from `parse.ts` on import, so the module is
 * tested exactly as it ships; its `import type { ItineraryCategory }` is erased
 * and its `@/types` alias never needs resolving. A fixed `referenceYear` is
 * passed everywhere a date has no year, so the assertions never depend on the
 * wall clock.
 *
 *   node --test tests/parse.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBooking } from '../src/features/itinerary/parse.ts'

const YEAR = 2026

test('a full flight confirmation extracts title, category, date, times, route', () => {
  const text = [
    'Flight confirmation',
    'United Airlines UA 837',
    'Departure: July 24, 2026',
    'Departs 10:30 AM — Arrives 2:45 PM',
    'SFO to NRT',
    'Confirmation code: ABC123',
  ].join('\n')
  const r = parseBooking(text, YEAR)
  assert.equal(r.matched, true)
  assert.equal(r.category, 'flight')
  assert.equal(r.day, '2026-07-24')
  assert.equal(r.start_time, '10:30')
  assert.equal(r.end_time, '14:45')
  assert.equal(r.location, 'SFO → NRT')
  assert.equal(r.title, 'United Airlines UA 837')
  assert.equal(r.notes, 'Confirmation: ABC123')
})

test('a hotel confirmation reads check-in date, time and address', () => {
  const text = [
    'Your reservation is confirmed',
    'The Ritz-Carlton Kyoto',
    'Check-in: 15 Aug 2026 at 3:00 PM',
    'Address: Kamogawa Nijo-Ohashi Hotori, Kyoto',
  ].join('\n')
  const r = parseBooking(text, YEAR)
  assert.equal(r.matched, true)
  assert.equal(r.category, 'hotel')
  assert.equal(r.day, '2026-08-15')
  assert.equal(r.start_time, '15:00')
  assert.equal(r.location, 'Kamogawa Nijo-Ohashi Hotori, Kyoto')
  // Skips the generic header line, picks the property name as the title.
  assert.equal(r.title, 'The Ritz-Carlton Kyoto')
  // No confirmation code here, so the raw text is preserved in notes rather
  // than being silently dropped on the matched path.
  assert.equal(r.notes, text)
})

test('a matched parse without a reference code keeps the raw text in notes', () => {
  const text = [
    'Dinner at Narisawa',
    'Aug 15, 2026 at 7:30 PM',
    'Party of 4 — window table, tasting menu',
  ].join('\n')
  const r = parseBooking(text, YEAR)
  assert.equal(r.matched, true)
  // Detected fields still populate…
  assert.equal(r.day, '2026-08-15')
  assert.equal(r.start_time, '19:30')
  // …and nothing pasted is lost: with no confirmation code, notes holds the raw text.
  assert.equal(r.notes, text)
})

test('ISO dates and 24-hour times parse without a meridiem', () => {
  const r = parseBooking('Tour on 2026-09-01 from 09:00 to 11:30', YEAR)
  assert.equal(r.day, '2026-09-01')
  assert.equal(r.start_time, '09:00')
  assert.equal(r.end_time, '11:30')
})

test('a year-less date adopts the reference year', () => {
  const r = parseBooking('Dinner reservation on Jul 24 at 7:30 PM', YEAR)
  assert.equal(r.day, '2026-07-24')
  assert.equal(r.start_time, '19:30')
  assert.equal(r.category, 'restaurant')
})

test('numeric US-style M/D/YYYY dates parse', () => {
  const r = parseBooking('Pickup 12/25/2026 at 8:00 AM', YEAR)
  assert.equal(r.day, '2026-12-25')
  assert.equal(r.start_time, '08:00')
})

test('12am and 12pm map to midnight and noon', () => {
  const midnight = parseBooking('Red-eye departs 12:00 AM on 2026-07-24', YEAR)
  assert.equal(midnight.start_time, '00:00')
  const noon = parseBooking('Lunch at 12:00 PM on 2026-07-24', YEAR)
  assert.equal(noon.start_time, '12:00')
})

test('an invalid calendar date (Feb 30) is rejected', () => {
  // No other date/time/location, so it degrades to unmatched.
  const r = parseBooking('Note: Feb 30, 2026 was a typo', YEAR)
  assert.equal(r.day, null)
})

test('a single time yields a start with no end', () => {
  const r = parseBooking('Museum entry 2026-07-24 at 14:00', YEAR)
  assert.equal(r.start_time, '14:00')
  assert.equal(r.end_time, null)
})

test('bare numbers without a colon or meridiem are not treated as times', () => {
  const r = parseBooking('Group of 8 people, table 5, on 2026-07-24', YEAR)
  assert.equal(r.start_time, null)
  assert.equal(r.end_time, null)
  assert.equal(r.day, '2026-07-24')
})

test('unparseable text degrades gracefully with the raw text in notes', () => {
  const text = 'just some random thoughts about the trip, nothing structured here'
  const r = parseBooking(text, YEAR)
  assert.equal(r.matched, false)
  assert.equal(r.title, null)
  assert.equal(r.day, null)
  assert.equal(r.start_time, null)
  assert.equal(r.location, null)
  assert.equal(r.notes, text)
})

test('empty input is unmatched with null notes, never throwing', () => {
  const r = parseBooking('   \n  \n', YEAR)
  assert.equal(r.matched, false)
  assert.equal(r.notes, null)
})

test('notes are capped so an enormous paste cannot exceed the form limit', () => {
  const r = parseBooking('x'.repeat(5000), YEAR)
  assert.equal(r.matched, false)
  assert.equal(r.notes.length, 2000)
})

test('long raw text is preserved but title/location caps hold on matched input', () => {
  const longTitle = 'A'.repeat(200)
  const r = parseBooking(`${longTitle}\nActivity on 2026-07-24 at 10:00`, YEAR)
  assert.equal(r.matched, true)
  assert.equal(r.title.length, 120)
})
