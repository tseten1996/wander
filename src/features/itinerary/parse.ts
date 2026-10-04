import type { ItineraryCategory, TransportMode } from '@/types'

/**
 * Heuristic client-side parser for a pasted booking confirmation (issue #77,
 * first slice of the reservation-import epic #76). Given the raw text a user
 * copied out of a flight/hotel/restaurant email, it best-effort extracts the
 * fields the itinerary create form already has — a title, a category, a day,
 * start/end times, and a location — so the form can open pre-filled for the
 * user to review before anything is saved.
 *
 * Deliberately dependency-free: only regex + arithmetic, no date library, no
 * network, no `import`s that touch Supabase. Nothing here writes data; the
 * caller decides what to do with the result. `matched` reports whether any
 * *structured* field (a day, a time, or a location) was recognized — a title
 * alone is just the first line and doesn't count, so an unrecognizable paste
 * degrades to `matched: false` and the raw text preserved in `notes`.
 *
 * Pure and deterministic given `referenceYear`: year-less dates ("Jul 24")
 * adopt it, so tests can pin a year rather than depend on the wall clock.
 */
export interface ParsedBooking {
  title: string | null
  category: ItineraryCategory | null
  /** ISO `YYYY-MM-DD`, or null. */
  day: string | null
  /** Closing day of a multi-day span (#166), e.g. a lodging check-out date;
   *  null for a single-day draft. */
  end_day: string | null
  /** 24-hour `HH:MM`, or null. */
  start_time: string | null
  end_time: string | null
  location: string | null
  notes: string | null
  /** Bare booking/confirmation code (no "Confirmation:" prefix), or null. This
   *  is the dedicated field the Stay/Transport logistics cards (#348/#350) hold
   *  and the itinerary item lacks; the itinerary path still keeps the code inside
   *  `notes` (see `detectReference`), so routing a paste into a structured card
   *  rescues it rather than stranding it. */
  confirmation_code: string | null
  /** A booking link, already normalized to an `http(s)` URL (or null). Validated
   *  with the same guard the Stay/Transport forms apply on save (#354), so an
   *  unsafe scheme never rides a paste into a rendered `href`. */
  booking_url: string | null
  /** True when a day, a time, or a location was recognized. */
  matched: boolean
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const MONTH_NAME = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** True only for a real calendar date — rejects e.g. Feb 30 or month 13. */
function isValidYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** First recognizable date anywhere in the text, normalized to `YYYY-MM-DD`. */
function parseDate(text: string, referenceYear: number): string | null {
  // ISO 8601 — least ambiguous, so try it first.
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (m && isValidYMD(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}-${m[3]}`

  // Month name then day, optional year: "July 24, 2026", "Jul 24", "Jul. 24th".
  // The `(?!\d)` after the day stops it swallowing the first digits of a
  // trailing year ("Aug 2026" must not read as Aug 20).
  m = text.match(
    new RegExp(`\\b(${MONTH_NAME})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4}))?`, 'i')
  )
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]
    const d = +m[2]
    const y = m[3] ? +m[3] : referenceYear
    if (isValidYMD(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`
  }

  // Day then month name, optional year: "24 July 2026", "24 Jul".
  m = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})[a-z]*\\.?(?:,?\\s*(\\d{4}))?`, 'i')
  )
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]
    const d = +m[1]
    const y = m[3] ? +m[3] : referenceYear
    if (isValidYMD(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`
  }

  // Numeric US-style M/D or M/D/YY(YY). Ambiguous by nature — last resort.
  m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (m) {
    const mo = +m[1]
    const d = +m[2]
    let y = m[3] ? +m[3] : referenceYear
    if (y < 100) y += 2000
    if (isValidYMD(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`
  }

  return null
}

// A time is only a time with a colon (24h "15:00") or a meridiem ("3 PM",
// "3:00 p.m."). A bare "8" is too ambiguous to guess. The meridiem branch is
// listed first so "3:00 PM" is read as 3 PM, not a colon-only 24h "3:00".
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])|\b(\d{1,2}):(\d{2})\b/gi

/** All valid clock times in the order they appear, as 24-hour `HH:MM`. */
function parseTimes(text: string): string[] {
  const times: string[] = []
  for (const m of text.matchAll(TIME_RE)) {
    let hours: number
    let mins: number
    if (m[3]) {
      // Meridiem branch: 12h → 24h. 12am → 00:00, 12pm → 12:00.
      hours = +m[1] % 12
      if (m[3].toLowerCase() === 'p') hours += 12
      mins = m[2] ? +m[2] : 0
    } else {
      hours = +m[4]
      mins = +m[5]
    }
    if (hours < 0 || hours > 23 || mins < 0 || mins > 59) continue
    times.push(`${pad(hours)}:${pad(mins)}`)
  }
  return times
}

/** A route between two 3-letter airport codes: `SFO → JFK`, `SFO - JFK`,
 *  `SFO to JFK`. Shared by `parseLocation` and the flight detector so the two
 *  can't silently drift apart. */
const AIRPORT_ROUTE_RE = /\b([A-Z]{3})\s*(?:→|–|-|to)\s*([A-Z]{3})\b/

/** A location from an explicit label line, or a flight route between codes. */
function parseLocation(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:location|address|venue|where|hotel|property)\s*[:\-]\s*(.+)$/i)
    if (m && m[1].trim()) return m[1].trim().slice(0, 160)
  }
  // "JFK → NRT", "JFK - NRT", or "from JFK to NRT" — airport codes only.
  const route = text.match(AIRPORT_ROUTE_RE)
  if (route) return `${route[1]} → ${route[2]}`
  return null
}

/** Keyword-based category guess; defaults to a generic activity. */
function detectCategory(text: string): ItineraryCategory {
  const t = text.toLowerCase()
  if (/\b(flight|airlines?|airways|boarding|departure|departs|arrival|arrives|gate|pnr|e-?ticket|terminal)\b/.test(t))
    return 'flight'
  if (/\b(hotel|check-?in|check-?out|nights?|room|suite|inn|resort|lodge|airbnb|property)\b/.test(t))
    return 'hotel'
  if (/\b(train|rail|amtrak|bus|coach|ferry|car rental|rental car|pick-?up|platform)\b/.test(t))
    return 'transport'
  if (/\b(restaurant|table for|party of|dinner reservation|lunch reservation|bistro|brasserie|dining)\b/.test(t))
    return 'restaurant'
  return 'activity'
}

const LABEL_LINE = /^\s*(date|time|starts?|ends?|location|address|where|when|confirmation|booking|reservation|guest|name|check-?in|check-?out|total|price|cost|amount|ref(?:erence)?)\s*[:\-]/i

// Words that mark a boilerplate header/status line ("Booking confirmation",
// "Your reservation is confirmed"). Deliberately excludes flight/hotel/etc. so
// a genuine title like "Hotel Okura Tokyo" is never mistaken for a header.
const HEADER_WORD = /\b(booking|reservation|confirmation|confirmed|itinerary|e-?ticket|receipt|your)\b/i

/** A short, digit-free line built from header/status words — not a real title. */
function isGenericHeader(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean)
  return words.length <= 5 && !/\d/.test(line) && HEADER_WORD.test(line)
}

/** A line that is only a date and/or time once those tokens are stripped. */
function isDateOrTimeOnly(line: string): boolean {
  const rest = line
    .replace(TIME_RE, '')
    .replace(new RegExp(`\\b(${MONTH_NAME})[a-z]*\\.?`, 'ig'), '')
    .replace(/[\d/:.,\-–—]/g, '')
    .trim()
  return rest.length === 0
}

/** Best-guess title: the first substantive line, skipping labels and headers. */
function detectTitle(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (LABEL_LINE.test(line)) continue
    if (isDateOrTimeOnly(line)) continue
    if (isGenericHeader(line) && lines.length > 1) continue
    return line.slice(0, 120)
  }
  return lines[0]?.slice(0, 120) ?? null
}

/** The bare confirmation / booking code, or null. */
function detectCode(text: string): string | null {
  // Same-line only (horizontal whitespace, no newline) and the code must
  // contain a digit — so the keyword doesn't reach across a line break and
  // grab an ordinary word like "United" from the following line.
  const m = text.match(
    /\b(?:confirmation|booking|reservation|record locator|conf|pnr|ref(?:erence)?)[^\S\n]*(?:number|no\.?|code|#|id)?[^\S\n]*[:#]?[^\S\n]*(?=[A-Za-z0-9]*\d)([A-Z0-9]{5,12})\b/i
  )
  return m ? m[1] : null
}

/** A confirmation / booking reference, formatted for the notes field. */
function detectReference(text: string): string | null {
  const code = detectCode(text)
  return code ? `Confirmation: ${code}` : null
}

/**
 * The first safe booking link in the text, normalized to its `http(s)` href, or
 * null. Mirrors the `safeHttpUrl` guard the Stay/Transport forms use on save
 * (#354): an `href` is a capability, and a member-pasted link must never carry a
 * `javascript:`/`data:` scheme into a rendered link. Inlined rather than imported
 * because this module is deliberately free of runtime imports (only a `type`
 * import) so the Node test runner exercises it exactly as it ships — the same
 * discipline schemas.ts follows by re-deriving its own calendar/date checks.
 */
function detectBookingUrl(text: string): string | null {
  const m = text.match(/\bhttps?:\/\/[^\s<>"')\]]+/i)
  if (!m) return null
  try {
    const u = new URL(m[0])
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * Parse a pasted booking confirmation into itinerary-form fields. Never throws
 * and never partially applies — the caller gets a full `ParsedBooking` and
 * pre-fills the form from it, letting the user confirm before saving.
 */
export function parseBooking(
  text: string,
  referenceYear: number = new Date().getFullYear()
): ParsedBooking {
  const raw = text.trim()
  const day = parseDate(text, referenceYear)
  const times = parseTimes(text)
  const location = parseLocation(text)
  const start_time = times[0] ?? null
  const end_time = times.find((t) => t !== start_time) ?? null

  const matched = Boolean(day || start_time || location)
  if (!matched) {
    // Nothing structured found — degrade to the empty form with the raw text
    // preserved in notes so a paste is never a dead end or silent loss.
    return {
      title: null,
      category: null,
      day: null,
      end_day: null,
      start_time: null,
      end_time: null,
      location: null,
      notes: raw ? raw.slice(0, 2000) : null,
      confirmation_code: null,
      booking_url: null,
      matched: false,
    }
  }

  return {
    title: detectTitle(text),
    category: detectCategory(text),
    day,
    end_day: null,
    start_time,
    end_time,
    location,
    // Prefer a detected confirmation code; otherwise fall back to the raw
    // pasted text so a matched parse never silently drops the parts we didn't
    // structure (seat, terminal, fare rules), consistent with the "never a
    // silent loss" guarantee the unmatched path already gives.
    notes: detectReference(text) ?? (raw ? raw.slice(0, 2000) : null),
    confirmation_code: detectCode(text),
    booking_url: detectBookingUrl(text),
    matched: true,
  }
}

// ── Format-aware reservation parsers (issue 103, slice 2 of epic 76) ────────
//
// Two detectors run *before* the generic `parseBooking` fallback and recognize
// the two highest-value reservation *formats* rather than just their text: a
// flight (airline + flight number, a route between airport codes, and a
// departure/arrival time pair that can roll past midnight) and a lodging stay
// (a check-in and a check-out date that become two anchored itinerary points).
// Each detector is high-confidence-or-nothing: if it isn't sure, it returns
// null and the caller falls through to the #77 generic path, then to the empty
// form — the same "never a dead end, never a silent loss" contract as #77.
// Still dependency-free: regex + arithmetic only, nothing writes data.

/** IATA airline designator (`AA`, `B6`, `9W`) directly followed by a 1–4 digit
 *  flight number, with or without a space: `AA 148`, `BA2490`, `UA837`. */
const FLIGHT_CODE_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/g

const DEPART_RE = /\b(?:depart|departs|departure|departing|outbound|leaves?)\b/i
const ARRIVE_RE = /\b(?:arrive|arrives|arrival|arriving|lands?)\b/i
const CHECKIN_RE = /check[\s-]?in/i
const CHECKOUT_RE = /check[\s-]?out/i

/** Shift an ISO `YYYY-MM-DD` by whole days, staying in UTC so no DST/TZ drift. */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** First flight designator in the text as a normalized `AA148`, or null. The
 *  `AM`/`PM` guard stops a meridiem ("10:30 AM 2") reading as an airline code. */
function parseFlightCode(text: string): string | null {
  for (const m of text.matchAll(FLIGHT_CODE_RE)) {
    const code = m[1].toUpperCase()
    if (code === 'AM' || code === 'PM') continue
    return `${code}${m[2]}`
  }
  return null
}

function parseRoute(text: string): { from: string; to: string } | null {
  const m = text.match(AIRPORT_ROUTE_RE)
  return m ? { from: m[1], to: m[2] } : null
}

/** The date and first time on the first line matching `labelRe` (e.g. the
 *  `Check-in:` or `Arrives` line), or null when no such line carries a date. */
function labeledDateTime(
  text: string,
  labelRe: RegExp,
  referenceYear: number
): { day: string; time: string | null } | null {
  for (const line of text.split(/\r?\n/)) {
    if (labelRe.test(line)) {
      const day = parseDate(line, referenceYear)
      if (day) return { day, time: parseTimes(line)[0] ?? null }
    }
  }
  return null
}

/** The confirmation code if present, else the raw text (capped), so a matched
 *  reservation never silently drops the parts we didn't structure. */
function reservationNotes(text: string): string | null {
  const raw = text.trim()
  return detectReference(text) ?? (raw ? raw.slice(0, 2000) : null)
}

/**
 * Recognize a flight confirmation. Requires an airline+flight code, a route
 * between airport codes, and at least a departure time — anything less falls
 * through to the generic parser. Produces one itinerary item for a same-day
 * flight; a flight that lands past midnight becomes two anchored items so the
 * arrival sits on its true calendar day (a single itinerary item has only one
 * `day`, so a red-eye can't be one row). Returns null when not confident.
 */
function detectFlight(text: string, referenceYear: number): ParsedBooking[] | null {
  const code = parseFlightCode(text)
  const route = parseRoute(text)
  const times = parseTimes(text)
  if (!code || !route || times.length === 0) return null

  // Bind each time to its own labeled line when the confirmation has one, so a
  // paste that lists the arrival line before the departure line doesn't swap
  // the two; fall back to positional order only for unlabeled lines.
  const depLabeled = labeledDateTime(text, DEPART_RE, referenceYear)
  const arrLabeled = labeledDateTime(text, ARRIVE_RE, referenceYear)
  const depTime = depLabeled?.time ?? times[0]
  const arrTime = arrLabeled?.time ?? times[1] ?? null
  const depDay = depLabeled?.day ?? parseDate(text, referenceYear)
  const arrLabeledDay = arrLabeled?.day ?? null

  const routeStr = `${route.from} → ${route.to}`
  const title = `${code} ${route.from}→${route.to}`
  const notes = reservationNotes(text)
  const confirmation_code = detectCode(text)
  const booking_url = detectBookingUrl(text)

  // The arrival crosses midnight when the confirmation names a distinct arrival
  // date, or (the red-eye case) when only one date is given and the arrival
  // clock time is earlier than the departure's.
  let arrDay = depDay
  let crosses = false
  if (depDay && arrLabeledDay && arrLabeledDay !== depDay) {
    arrDay = arrLabeledDay
    crosses = true
  } else if (depDay && arrTime && arrTime < depTime) {
    arrDay = addDays(depDay, 1)
    crosses = true
  }

  // A known distinct arrival day splits into two anchors even when no arrival
  // clock time was found (arrTime stays null on the arrival draft) — a single
  // itinerary row has one `day`, so a multi-day flight can't be one row.
  if (crosses) {
    return [
      {
        title, category: 'flight', day: depDay, end_day: null, start_time: depTime,
        end_time: null, location: routeStr, notes, confirmation_code, booking_url,
        matched: true,
      },
      {
        title: `${code} arrives ${route.to}`, category: 'flight', day: arrDay,
        end_day: null, start_time: arrTime, end_time: null, location: routeStr,
        // The raw fallback already rode along on the departure item above; the
        // arrival anchor only needs the confirmation code (or nothing).
        notes: detectReference(text), confirmation_code, booking_url, matched: true,
      },
    ]
  }

  return [
    {
      title, category: 'flight', day: depDay, end_day: null, start_time: depTime,
      end_time: arrTime, location: routeStr, notes, confirmation_code, booking_url,
      matched: true,
    },
  ]
}

/**
 * Recognize a lodging confirmation. Requires both a check-in and a check-out
 * date; produces ONE multi-day span (#166) anchored on the check-in day and
 * running through the check-out day, with the property as title/location, the
 * check-in time as `start_time`, the check-out time as `end_time`, and the
 * confirmation number in notes. Returns null when either date is missing, so a
 * one-sided paste falls through to the generic parser (which already handles a
 * lone check-in). A same-day booking simply yields `end_day === day`, which the
 * span layer treats as a single-day item.
 */
function detectLodging(text: string, referenceYear: number): ParsedBooking[] | null {
  const checkIn = labeledDateTime(text, CHECKIN_RE, referenceYear)
  const checkOut = labeledDateTime(text, CHECKOUT_RE, referenceYear)
  if (!checkIn || !checkOut) return null
  // A check-out before check-in is a mis-parse, not a real span — drop back to
  // the generic parser rather than emit an end-before-start item the DB rejects.
  if (checkOut.day < checkIn.day) return null

  const name = detectTitle(text)
  const location = parseLocation(text) ?? name

  return [
    {
      title: (name ?? 'Stay').slice(0, 120),
      category: 'hotel',
      day: checkIn.day,
      end_day: checkOut.day,
      start_time: checkIn.time,
      // `end_time` carries the check-out time on the closing day of the span.
      end_time: checkOut.time,
      location,
      notes: reservationNotes(text),
      confirmation_code: detectCode(text),
      booking_url: detectBookingUrl(text),
      matched: true,
    },
  ]
}

export type ReservationKind = 'flight' | 'lodging' | 'generic' | 'none'

export interface ReservationParse {
  /** Which detector claimed the paste. `generic` = the #77 heuristic matched;
   *  `none` = nothing structured was found (raw text preserved in the draft). */
  kind: ReservationKind
  /** One or more create-form drafts, in the order the user should confirm them.
   *  Always at least one; a flight/lodging paste can yield two. */
  drafts: ParsedBooking[]
  matched: boolean
}

/**
 * Parse a pasted confirmation into one or more itinerary drafts. Tries the
 * format-aware flight and lodging detectors first, then falls back to the #77
 * generic `parseBooking`. Never throws; the caller confirms each draft in the
 * create form before anything is written.
 */
export function parseReservation(
  text: string,
  referenceYear: number = new Date().getFullYear()
): ReservationParse {
  const flight = detectFlight(text, referenceYear)
  if (flight) return { kind: 'flight', drafts: flight, matched: true }

  const lodging = detectLodging(text, referenceYear)
  if (lodging) return { kind: 'lodging', drafts: lodging, matched: true }

  const generic = parseBooking(text, referenceYear)
  return {
    kind: generic.matched ? 'generic' : 'none',
    drafts: [generic],
    matched: generic.matched,
  }
}

// ── Routing a parsed confirmation to the card it belongs in (#380) ───────────
//
// The reservation-import epic (#76) predates the structured logistics tables
// (#348 stays, #350 transport), so a parsed draft is itinerary-item-shaped. The
// helpers below map that draft onto the destination its category implies — a
// hotel into a Stay, a flight/train/bus into a Transport hop — without a new
// parse pass. They are pure (no React, no form types) so the paste flow and the
// Node test runner share one source of truth for the routing, and so the UI can
// re-target a draft (stay ↔ transport ↔ itinerary item) by re-mapping the same
// `ParsedBooking`s rather than re-parsing. Nothing here writes: each mapper
// produces a draft the matching editor opens pre-filled for review before save.

/** Where a parsed confirmation should open for review. */
export type ImportTarget = 'item' | 'stay' | 'transport'

/**
 * The editor a parsed category routes to. `hotel` → Stay, `flight`/`transport`
 * → Transport, everything else (activity/restaurant/free, or an unknown) → the
 * itinerary item, exactly as before #380. The member can still re-target.
 */
export function targetForCategory(category: ItineraryCategory | null): ImportTarget {
  if (category === 'hotel') return 'stay'
  if (category === 'flight' || category === 'transport') return 'transport'
  return 'item'
}

/**
 * Best-guess transport mode from the confirmation text. The regex parser folds
 * train/bus/ferry/car into the single `transport` category, so the mode is
 * re-derived here when routing into the Transport card, which needs one of the
 * five concrete modes. Defaults to `flight` (the Transport form's own default)
 * when nothing matches.
 */
export function inferTransportMode(text: string): TransportMode {
  const t = text.toLowerCase()
  if (/\b(flight|airlines?|airways|boarding|gate|pnr|e-?ticket|terminal)\b/.test(t)) return 'flight'
  if (/\b(train|rail|amtrak|eurostar|railways?|platform)\b/.test(t)) return 'train'
  if (/\b(bus|coach)\b/.test(t)) return 'bus'
  if (/\b(ferry|boat|sailing)\b/.test(t)) return 'ferry'
  if (/\b(car rental|rental car|pick-?up|drop-?off)\b/.test(t)) return 'car'
  return 'flight'
}

/** A Stay draft, field-named to match the Stay create form so the dialog can
 *  open pre-filled from it. Coordinates are deliberately absent — the Stay form
 *  geocodes the address on save, the same path a typed address takes. */
export interface StayDraft {
  name: string | null
  address: string | null
  check_in: string | null
  check_out: string | null
  confirmation_code: string | null
  booking_url: string | null
}

/** A Transport draft, field-named to match the Transport create form. */
export interface TransportDraft {
  mode: TransportMode
  depart_place: string | null
  arrive_place: string | null
  /** Wall-clock `YYYY-MM-DDTHH:mm`, or null when the day or time is unknown
   *  (the `datetime-local` control cannot hold a date without a time). */
  depart_at: string | null
  arrive_at: string | null
  confirmation_code: string | null
  booking_url: string | null
}

/** Split a parsed "A → B" route (or a plain place) into endpoints. */
function splitRoute(location: string | null): { from: string | null; to: string | null } {
  if (!location) return { from: null, to: null }
  const parts = location.split(/\s*(?:→|->)\s*/)
  if (parts.length >= 2) return { from: parts[0].trim() || null, to: parts[1].trim() || null }
  return { from: location.trim() || null, to: null }
}

/** A `YYYY-MM-DDTHH:mm` datetime, or null unless BOTH the day and time are known. */
function combineDateTime(day: string | null, time: string | null): string | null {
  return day && time ? `${day}T${time}` : null
}

/**
 * Map the parsed drafts onto a Stay. Uses the first (and, for lodging, only)
 * draft: title → name, location → address, day/end_day → check-in/check-out,
 * plus the rescued confirmation code and booking link.
 */
export function toStayDraft(drafts: ParsedBooking[]): StayDraft {
  const b = drafts[0]
  return {
    name: b?.title ?? null,
    address: b?.location ?? null,
    check_in: b?.day ?? null,
    check_out: b?.end_day ?? null,
    confirmation_code: b?.confirmation_code ?? null,
    booking_url: b?.booking_url ?? null,
  }
}

/**
 * Map the parsed drafts onto a single Transport hop. A red-eye flight parses
 * into two anchored drafts (one per calendar day — an itinerary item has only
 * one `day`); a hop carries both a `depart_at` and an `arrive_at`, so the two
 * collapse back into one: departure from the first draft, arrival from the
 * second's day+time when present, else the first draft's `end_time`. `text` is
 * the raw paste, read only to infer the mode the category flattened.
 */
export function toTransportDraft(drafts: ParsedBooking[], text: string): TransportDraft {
  const dep = drafts[0]
  const arr = drafts.length > 1 ? drafts[1] : null
  const { from, to } = splitRoute(dep?.location ?? null)
  const arrive_at = arr
    ? combineDateTime(arr.day, arr.start_time)
    : combineDateTime(dep?.day ?? null, dep?.end_time ?? null)
  return {
    mode: inferTransportMode(text),
    depart_place: from,
    arrive_place: to,
    depart_at: combineDateTime(dep?.day ?? null, dep?.start_time ?? null),
    arrive_at,
    confirmation_code: dep?.confirmation_code ?? null,
    booking_url: dep?.booking_url ?? null,
  }
}
