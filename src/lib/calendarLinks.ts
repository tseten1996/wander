/**
 * Pure "Add to calendar" deep-link builders for a single itinerary item (#288).
 *
 * Google Calendar and Outlook both accept a prefilled-event URL — no key, no
 * OAuth, no server, no new dependency (guardrail 5). Opened in a new tab the
 * link lands the member on their own calendar's create-event screen with the
 * event already filled in, so putting *one* booking on a phone no longer means
 * downloading the whole itinerary and importing thirty other events.
 *
 * The date/time semantics deliberately mirror the whole-itinerary `.ics` export
 * (`src/lib/export.ts`, `buildIcsEvent`): a timed item runs from its start to
 * its end, defaulting to one hour when it has only a start; an item with no
 * start time is an all-day event. Times are written as floating local times
 * (no timezone) — Wander stores no timezone, so the event shows at the same
 * wall-clock time in whichever calendar imports it. Multi-day `end_day` spans
 * are treated as single-day here for exactly the same reason the `.ics` export
 * does: they are surfaced as bands, and this convenience targets point bookings.
 *
 * Like `src/lib/geo.ts` this module imports nothing from `@/types`, so the Node
 * test runner can import it directly after stripping the types.
 */

/** The itinerary fields a calendar event is built from — a subset of ItineraryItem. */
export interface CalendarEventInput {
  title: string
  /** 'YYYY-MM-DD'; an item with no day can't become a calendar event (→ null). */
  day: string | null
  /** 'HH:MM' or 'HH:MM:SS'; absent means an all-day event. */
  start_time?: string | null
  end_time?: string | null
  location?: string | null
  url?: string | null
  notes?: string | null
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/** 'HH:MM' or 'HH:MM:SS' → 'HH:MM:SS' (zero-filled). */
function normalizeTime(t: string): string {
  const [h = '0', m = '0', s = '0'] = t.split(':')
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`
}

/** Add one hour to a 'YYYY-MM-DD' + 'HH:MM:SS', rolling into the next day when
 *  the start falls in the last hour. Pure UTC math so it never shifts across a
 *  DST boundary — the components are read back out as the same wall-clock time. */
function plusOneHour(day: string, time: string): { date: string; time: string } {
  const [y, mo, d] = day.split('-').map(Number)
  const [h, mi, s] = normalizeTime(time).split(':').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d, h + 1, mi, s))
  const date = `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
  const out = `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
  return { date, time: out }
}

/** Add `n` days to a 'YYYY-MM-DD' date, returning 'YYYY-MM-DD'. Pure UTC math. */
function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d + n))
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

interface Timing {
  allDay: boolean
  /** 'YYYY-MM-DD' */
  startDate: string
  /** 'HH:MM:SS' — ignored when allDay. */
  startTime: string
  /** 'YYYY-MM-DD' — the **exclusive** end date when allDay. */
  endDate: string
  /** 'HH:MM:SS' — ignored when allDay. */
  endTime: string
}

/**
 * Resolve the item's start/end into a normalized shape, or `null` when it has
 * no day. Mirrors `buildIcsEvent`: an explicit `end_time` later than the start
 * wins; otherwise a timed item gets a one-hour default, and an item with no
 * start is all-day with an exclusive end of the next day (the off-by-one that
 * otherwise silently lengthens or shortens every all-day event).
 */
function resolveTiming(input: CalendarEventInput): Timing | null {
  if (!input.day) return null
  const startDate = input.day

  if (input.start_time) {
    const startTime = normalizeTime(input.start_time)
    // String comparison of the raw values, exactly as the ICS export decides
    // between an explicit DTEND and a PT1H duration.
    if (input.end_time && input.end_time > input.start_time) {
      return { allDay: false, startDate, startTime, endDate: startDate, endTime: normalizeTime(input.end_time) }
    }
    const end = plusOneHour(startDate, startTime)
    return { allDay: false, startDate, startTime, endDate: end.date, endTime: end.time }
  }

  return { allDay: true, startDate, startTime: '', endDate: addDays(startDate, 1), endTime: '' }
}

/** Strip the separators from an ISO date/time for the compact form Google wants. */
const compact = (isoDateOrTime: string) => isoDateOrTime.replace(/[-:]/g, '')

/**
 * Set the two optional shared fields — the description body (notes + link,
 * combined exactly as the ICS export does) and the location — on `params`,
 * under whichever description key the target calendar uses (`details` for
 * Google, `body` for Outlook). Absent fields are left off entirely.
 */
function addOptionalFields(params: URLSearchParams, input: CalendarEventInput, descriptionKey: string): void {
  const body = [input.notes, input.url].filter(Boolean).join('\n\n')
  if (body) params.set(descriptionKey, body)
  if (input.location) params.set('location', input.location)
}

/**
 * A Google Calendar "create event" URL prefilled from the item, or `null` when
 * the item has no day. `dates` is `YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS` for a timed
 * event and `YYYYMMDD/YYYYMMDD` (exclusive end) for an all-day one. Every field
 * is percent-encoded by `URLSearchParams`.
 */
export function googleCalendarUrl(input: CalendarEventInput): string | null {
  const t = resolveTiming(input)
  if (!t) return null

  const dates = t.allDay
    ? `${compact(t.startDate)}/${compact(t.endDate)}`
    : `${compact(t.startDate)}T${compact(t.startTime)}/${compact(t.endDate)}T${compact(t.endTime)}`

  const params = new URLSearchParams({ action: 'TEMPLATE', text: input.title, dates })
  addOptionalFields(params, input, 'details')
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/**
 * An Outlook (outlook.live.com) "create event" URL prefilled from the item, or
 * `null` when the item has no day. Outlook takes ISO `startdt`/`enddt`; an
 * all-day event sets `allday=true` with date-only bounds (end exclusive). Every
 * field is percent-encoded by `URLSearchParams`.
 */
export function outlookCalendarUrl(input: CalendarEventInput): string | null {
  const t = resolveTiming(input)
  if (!t) return null

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: input.title,
  })
  if (t.allDay) {
    params.set('allday', 'true')
    params.set('startdt', t.startDate)
    params.set('enddt', t.endDate)
  } else {
    params.set('startdt', `${t.startDate}T${t.startTime}`)
    params.set('enddt', `${t.endDate}T${t.endTime}`)
  }
  addOptionalFields(params, input, 'body')
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`
}
