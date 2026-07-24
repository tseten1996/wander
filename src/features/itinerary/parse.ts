import type { ItineraryCategory } from '@/types'

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
  /** 24-hour `HH:MM`, or null. */
  start_time: string | null
  end_time: string | null
  location: string | null
  notes: string | null
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

/** A location from an explicit label line, or a flight route between codes. */
function parseLocation(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:location|address|venue|where|hotel|property)\s*[:\-]\s*(.+)$/i)
    if (m && m[1].trim()) return m[1].trim().slice(0, 160)
  }
  // "JFK → NRT", "JFK - NRT", or "from JFK to NRT" — airport codes only.
  const route = text.match(/\b([A-Z]{3})\s*(?:→|–|-|to)\s*([A-Z]{3})\b/)
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

/** A confirmation / booking reference, formatted for the notes field. */
function detectReference(text: string): string | null {
  // Same-line only (horizontal whitespace, no newline) and the code must
  // contain a digit — so the keyword doesn't reach across a line break and
  // grab an ordinary word like "United" from the following line.
  const m = text.match(
    /\b(?:confirmation|booking|reservation|record locator|conf|pnr|ref(?:erence)?)[^\S\n]*(?:number|no\.?|code|#|id)?[^\S\n]*[:#]?[^\S\n]*(?=[A-Za-z0-9]*\d)([A-Z0-9]{5,12})\b/i
  )
  return m ? `Confirmation: ${m[1]}` : null
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
      start_time: null,
      end_time: null,
      location: null,
      notes: raw ? raw.slice(0, 2000) : null,
      matched: false,
    }
  }

  return {
    title: detectTitle(text),
    category: detectCategory(text),
    day,
    start_time,
    end_time,
    location,
    // Prefer a detected confirmation code; otherwise fall back to the raw
    // pasted text so a matched parse never silently drops the parts we didn't
    // structure (seat, terminal, fare rules), consistent with the "never a
    // silent loss" guarantee the unmatched path already gives.
    notes: detectReference(text) ?? (raw ? raw.slice(0, 2000) : null),
    matched: true,
  }
}
