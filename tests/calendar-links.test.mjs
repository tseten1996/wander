/**
 * Unit tests for the single-item "Add to calendar" link builders
 * (src/lib/calendarLinks.ts, #288) — the prefilled Google Calendar and Outlook
 * create-event URLs.
 *
 * Like tests/geo.test.mjs these run against the TypeScript source directly:
 * Node (>= 22.18) strips the types on import, and calendarLinks.ts imports
 * nothing from `@/types`, so no path alias ever needs resolving.
 *
 *   node --test tests/calendar-links.test.mjs      # or: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleCalendarUrl, outlookCalendarUrl } from '../src/lib/calendarLinks.ts'

/** Pull one query param out of a built URL, decoded. */
function param(url, key) {
  return new URL(url).searchParams.get(key)
}

const dinner = {
  title: 'Friday dinner',
  day: '2026-07-24',
  start_time: '19:00',
  end_time: '21:00',
  location: 'Narisawa, Tokyo',
  url: 'https://narisawa-yoshihiro.com',
  notes: 'Table for 6',
}

test('an item with no day yields no link for either provider', () => {
  const noDay = { ...dinner, day: null }
  assert.equal(googleCalendarUrl(noDay), null)
  assert.equal(outlookCalendarUrl(noDay), null)
})

test('Google: a timed item uses dates=YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS', () => {
  const url = googleCalendarUrl(dinner)
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?'))
  assert.equal(param(url, 'action'), 'TEMPLATE')
  assert.equal(param(url, 'dates'), '20260724T190000/20260724T210000')
})

test('Google: a start with no end gets the one-hour default the ICS export applies', () => {
  const url = googleCalendarUrl({ ...dinner, end_time: null })
  assert.equal(param(url, 'dates'), '20260724T190000/20260724T200000')
})

test('Google: the one-hour default rolls into the next day past 23:00', () => {
  const url = googleCalendarUrl({ title: 'Late set', day: '2026-07-24', start_time: '23:30', end_time: null })
  assert.equal(param(url, 'dates'), '20260724T233000/20260725T003000')
})

test('Google: an all-day item produces YYYYMMDD/YYYYMMDD with an EXCLUSIVE end', () => {
  const url = googleCalendarUrl({ title: 'Museum day', day: '2026-07-24' })
  // End is the next day, not the same day — the classic all-day off-by-one.
  assert.equal(param(url, 'dates'), '20260724/20260725')
})

test('Google: the all-day exclusive end rolls across a month boundary', () => {
  const url = googleCalendarUrl({ title: 'Last of July', day: '2026-07-31' })
  assert.equal(param(url, 'dates'), '20260731/20260801')
})

test('Google: title, location, notes and url are carried across and percent-encoded', () => {
  const url = googleCalendarUrl(dinner)
  assert.equal(param(url, 'text'), 'Friday dinner')
  assert.equal(param(url, 'location'), 'Narisawa, Tokyo')
  // notes and url are combined into the details body, exactly as the ICS export does.
  assert.equal(param(url, 'details'), 'Table for 6\n\nhttps://narisawa-yoshihiro.com')
  // The raw string must not leak an un-encoded comma or newline into the URL.
  assert.ok(!url.includes('Narisawa, Tokyo'))
})

test('Google: absent optional fields are simply omitted', () => {
  const url = googleCalendarUrl({ title: 'Bare', day: '2026-07-24', start_time: '09:00', end_time: '10:00' })
  assert.equal(param(url, 'location'), null)
  assert.equal(param(url, 'details'), null)
})

test('an end_time not later than the start falls back to one hour, mirroring the ICS builder', () => {
  // end 09:00 is not > start 10:00, so neither builder trusts it as a real end.
  const bad = { title: 'Backwards', day: '2026-07-24', start_time: '10:00', end_time: '09:00' }
  assert.equal(param(googleCalendarUrl(bad), 'dates'), '20260724T100000/20260724T110000')
  assert.equal(param(outlookCalendarUrl(bad), 'enddt'), '2026-07-24T11:00:00')
})

test('times given as HH:MM or HH:MM:SS both normalise to HHMMSS', () => {
  const withSeconds = googleCalendarUrl({ title: 'Precise', day: '2026-07-24', start_time: '19:05:30', end_time: '20:00:00' })
  assert.equal(param(withSeconds, 'dates'), '20260724T190530/20260724T200000')
})

test('Outlook: a timed item uses ISO startdt/enddt', () => {
  const url = outlookCalendarUrl(dinner)
  assert.ok(url.startsWith('https://outlook.live.com/calendar/0/deeplink/compose?'))
  assert.equal(param(url, 'rru'), 'addevent')
  assert.equal(param(url, 'subject'), 'Friday dinner')
  assert.equal(param(url, 'startdt'), '2026-07-24T19:00:00')
  assert.equal(param(url, 'enddt'), '2026-07-24T21:00:00')
  assert.equal(param(url, 'allday'), null)
  assert.equal(param(url, 'location'), 'Narisawa, Tokyo')
  assert.equal(param(url, 'body'), 'Table for 6\n\nhttps://narisawa-yoshihiro.com')
})

test('Outlook: an all-day item sets allday=true with an exclusive date-only end', () => {
  const url = outlookCalendarUrl({ title: 'Museum day', day: '2026-07-24' })
  assert.equal(param(url, 'allday'), 'true')
  assert.equal(param(url, 'startdt'), '2026-07-24')
  assert.equal(param(url, 'enddt'), '2026-07-25')
})

test('both builders are pure — the same input yields the same URL', () => {
  assert.equal(googleCalendarUrl(dinner), googleCalendarUrl({ ...dinner }))
  assert.equal(outlookCalendarUrl(dinner), outlookCalendarUrl({ ...dinner }))
})
