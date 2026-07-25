/**
 * Unit tests for the format-aware reservation parsers
 * (src/features/itinerary/parse.ts, issue #103 — slice 2 of epic #76).
 *
 * Exercises the pure `parseReservation` layer directly — no browser, no
 * Supabase, no preview server — with the built-in Node test runner
 * (`node:test` + `node:assert`), matching `tests/parse.test.mjs`. Node strips
 * the TypeScript types on import, so the module is tested exactly as it ships;
 * a fixed `referenceYear` keeps year-less dates off the wall clock.
 *
 *   node --test tests/reservation.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReservation } from '../src/features/itinerary/parse.ts'

const YEAR = 2026

test('a same-day flight yields one item with airline, route, and both times', () => {
  const text = [
    'Flight confirmation',
    'United Airlines UA 837',
    'Departure: July 24, 2026',
    'Departs 10:30 AM — Arrives 2:45 PM',
    'SFO to NRT',
    'Confirmation code: ABC123',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'flight')
  assert.equal(r.matched, true)
  assert.equal(r.drafts.length, 1)
  const [f] = r.drafts
  assert.equal(f.category, 'flight')
  assert.equal(f.title, 'UA837 SFO→NRT')
  assert.equal(f.day, '2026-07-24')
  assert.equal(f.start_time, '10:30')
  assert.equal(f.end_time, '14:45')
  assert.equal(f.location, 'SFO → NRT')
  // Confirmation / record locator preserved in notes.
  assert.equal(f.notes, 'Confirmation: ABC123')
})

test('a red-eye that lands past midnight splits into two anchored items', () => {
  const text = [
    'American AA 148',
    'JFK to LHR',
    'Departs 11:30 PM on 2026-07-24',
    'Arrives 6:15 AM',
    'Record locator: XYZ789',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'flight')
  assert.equal(r.drafts.length, 2)
  const [dep, arr] = r.drafts
  // Departure anchor sits on the departure day.
  assert.equal(dep.title, 'AA148 JFK→LHR')
  assert.equal(dep.day, '2026-07-24')
  assert.equal(dep.start_time, '23:30')
  assert.equal(dep.end_time, null)
  // Arrival anchor rolls to the next calendar day.
  assert.equal(arr.day, '2026-07-25')
  assert.equal(arr.start_time, '06:15')
  assert.equal(arr.location, 'JFK → LHR')
  // The confirmation rides on both anchors.
  assert.equal(dep.notes, 'Confirmation: XYZ789')
  assert.equal(arr.notes, 'Confirmation: XYZ789')
})

test('an explicit distinct arrival date rolls the arrival even without a red-eye clock', () => {
  const text = [
    'Qantas QF 12',
    'LAX to SYD',
    'Departure: 2026-07-24',
    'Departs 10:00 PM',
    'Arrival: 2026-07-26',
    'Arrives 6:30 AM',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  assert.equal(r.drafts.length, 2)
  const [dep, arr] = r.drafts
  assert.equal(dep.day, '2026-07-24')
  assert.equal(arr.day, '2026-07-26')
  assert.equal(arr.start_time, '06:30')
})

test('a hotel confirmation becomes check-in and check-out anchors', () => {
  const text = [
    'Your reservation is confirmed',
    'The Ritz-Carlton Kyoto',
    'Check-in: 15 Aug 2026 at 3:00 PM',
    'Check-out: 18 Aug 2026 at 11:00 AM',
    'Address: Kamogawa Nijo-Ohashi Hotori, Kyoto',
    'Confirmation number: HTL45678',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'lodging')
  assert.equal(r.drafts.length, 2)
  const [ci, co] = r.drafts
  assert.equal(ci.category, 'hotel')
  assert.equal(ci.title, 'Check-in: The Ritz-Carlton Kyoto')
  assert.equal(ci.day, '2026-08-15')
  assert.equal(ci.start_time, '15:00')
  assert.equal(ci.location, 'Kamogawa Nijo-Ohashi Hotori, Kyoto')
  assert.equal(ci.notes, 'Confirmation: HTL45678')
  assert.equal(co.title, 'Check-out: The Ritz-Carlton Kyoto')
  assert.equal(co.day, '2026-08-18')
  assert.equal(co.start_time, '11:00')
  assert.equal(co.notes, 'Confirmation: HTL45678')
})

test('a hotel with no explicit address falls back to the property as location', () => {
  const text = [
    'Hotel Okura Tokyo',
    'Check-in: Aug 15, 2026',
    'Check-out: Aug 17, 2026',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'lodging')
  assert.equal(r.drafts[0].location, 'Hotel Okura Tokyo')
  assert.equal(r.drafts[1].day, '2026-08-17')
})

test('a lone check-in (no check-out) falls through to the generic parser', () => {
  const text = [
    'Your reservation is confirmed',
    'The Ritz-Carlton Kyoto',
    'Check-in: 15 Aug 2026 at 3:00 PM',
    'Address: Kamogawa Nijo-Ohashi Hotori, Kyoto',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  // Not confident enough for the two-anchor lodging path; #77 generic handles it.
  assert.equal(r.kind, 'generic')
  assert.equal(r.drafts.length, 1)
  assert.equal(r.drafts[0].category, 'hotel')
  assert.equal(r.drafts[0].day, '2026-08-15')
})

test('a restaurant paste (no flight/hotel format) falls through to generic', () => {
  const text = [
    'Dinner at Narisawa',
    'Aug 15, 2026 at 7:30 PM',
    'Party of 4 — window table, tasting menu',
  ].join('\n')
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'generic')
  assert.equal(r.drafts.length, 1)
  assert.equal(r.drafts[0].category, 'restaurant')
  assert.equal(r.drafts[0].start_time, '19:30')
})

test('unparseable text degrades to none with the raw text preserved', () => {
  const text = 'just some random thoughts about the trip, nothing structured here'
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'none')
  assert.equal(r.matched, false)
  assert.equal(r.drafts.length, 1)
  assert.equal(r.drafts[0].notes, text)
})

test('a flight without a route is not force-detected, falls through to generic', () => {
  // Airline+number present, but no airport route → generic keyword category.
  const text = 'Flight UA 837 departs at 10:30 AM on 2026-07-24'
  const r = parseReservation(text, YEAR)
  assert.equal(r.kind, 'generic')
  assert.equal(r.drafts[0].category, 'flight')
})

test('drafts always carry a matched flag so the caller can prefill safely', () => {
  const r = parseReservation('AA 148 SFO to JFK departs 8:00 AM on 2026-07-24', YEAR)
  assert.equal(r.drafts.every((d) => d.matched === true), true)
})
