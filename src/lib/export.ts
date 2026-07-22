import { supabase } from './supabase'

const CONTENT_TABLES = [
  'polls', 'poll_options', 'votes', 'messages', 'message_reactions',
  'questions', 'checklist_items', 'itinerary_items', 'budget_entries',
  'packing_items', 'notes', 'inspiration_items',
] as const

export interface TripExport {
  format: 'wander-trip-v1'
  exported_at: string
  trip: Record<string, unknown>
  members: Record<string, unknown>[]
  tables: Record<string, Record<string, unknown>[]>
}

/** Download the whole trip as a JSON file (backup / portability). */
export async function exportTripJson(tripId: string, tripName: string): Promise<void> {
  const { data: trip, error } = await supabase.from('trips').select('*').eq('id', tripId).single()
  if (error) throw error
  const { data: members } = await supabase.from('members').select('*').eq('trip_id', tripId)

  const tables: TripExport['tables'] = {}
  await Promise.all(
    CONTENT_TABLES.map(async (table) => {
      const { data } = await supabase.from(table).select('*').eq('trip_id', tripId)
      tables[table] = data ?? []
    })
  )

  const payload: TripExport = {
    format: 'wander-trip-v1',
    exported_at: new Date().toISOString(),
    trip,
    members: members ?? [],
    tables,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${tripName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-export.json`
  a.click()
  URL.revokeObjectURL(url)
}

/* ── Calendar (.ics) export ─────────────────────────────────────────────── */

interface IcsItineraryRow {
  id: string
  title: string
  category: string | null
  day: string | null
  start_time: string | null
  end_time: string | null
  location: string | null
  url: string | null
  notes: string | null
}

/** RFC 5545 §3.3.11 text escaping: backslash, semicolon, comma, newline. */
function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Fold a content line to ≤75 chars with CRLF + space continuation (RFC 5545 §3.1). */
function icsFold(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = [line.slice(0, 75)]
  let rest = line.slice(75)
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74))
    rest = rest.slice(74)
  }
  if (rest.length) parts.push(' ' + rest)
  return parts.join('\r\n')
}

/** 'HH:MM' or 'HH:MM:SS' → 'HHMMSS'. */
function icsTime(t: string): string {
  const [h = '0', m = '0', s = '0'] = t.split(':')
  return `${h.padStart(2, '0')}${m.padStart(2, '0')}${s.padStart(2, '0')}`
}

/** now → 'YYYYMMDDTHHMMSSZ' (UTC). */
function icsStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Build one VEVENT. Times are written as floating local times (no TZID/Z) —
 * Wander doesn't store a timezone, so the event shows at the same wall-clock
 * time in whatever calendar imports it. Items with no `day` are skipped
 * (a calendar event needs a date), so this returns null for them.
 */
function buildIcsEvent(row: IcsItineraryRow, stamp: string): string | null {
  if (!row.day) return null
  const date = row.day.replace(/-/g, '')
  const lines = ['BEGIN:VEVENT', `UID:${row.id}@wander`, `DTSTAMP:${stamp}`]

  if (row.start_time) {
    lines.push(`DTSTART:${date}T${icsTime(row.start_time)}`)
    if (row.end_time && row.end_time > row.start_time) {
      lines.push(`DTEND:${date}T${icsTime(row.end_time)}`)
    } else {
      lines.push('DURATION:PT1H')
    }
  } else {
    // All-day event; per RFC 5545 the default duration is one day.
    lines.push(`DTSTART;VALUE=DATE:${date}`)
  }

  lines.push(`SUMMARY:${icsEscape(row.title)}`)
  if (row.location) lines.push(`LOCATION:${icsEscape(row.location)}`)
  const description = [row.notes, row.url].filter(Boolean).join('\n\n')
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`)
  if (row.url) lines.push(`URL:${icsEscape(row.url)}`)
  if (row.category) lines.push(`CATEGORIES:${icsEscape(row.category)}`)
  lines.push('END:VEVENT')
  return lines.join('\r\n')
}

/**
 * Download the itinerary as a `.ics` calendar file, generated entirely
 * client-side. Returns the number of events written (unscheduled items are
 * omitted) so callers can message an empty result. No network write.
 */
export async function exportItineraryIcs(tripId: string, tripName: string): Promise<number> {
  const { data, error } = await supabase
    .from('itinerary_items')
    .select('id, title, category, day, start_time, end_time, location, url, notes')
    .eq('trip_id', tripId)
    .order('day', { nullsFirst: false })
    .order('position')
  if (error) throw error

  const rows = (data ?? []) as IcsItineraryRow[]
  const stamp = icsStamp()
  const events = rows
    .map((row) => buildIcsEvent(row, stamp))
    .filter((event): event is string => event !== null)

  const calendar = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wander//Trip Itinerary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(tripName)}`,
    ...events,
    'END:VCALENDAR',
  ]
    .join('\r\n')
    .split('\r\n')
    .map(icsFold)
    .join('\r\n')

  const slug = tripName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trip'
  const blob = new Blob([calendar + '\r\n'], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}-itinerary.ics`
  a.click()
  URL.revokeObjectURL(url)
  return events.length
}

// Tables whose rows can be meaningfully re-imported into a fresh trip.
// People-bound rows (votes, messages, reactions) are skipped: their authors
// don't exist in the target trip.
const IMPORT_TABLES = [
  'questions', 'checklist_items', 'itinerary_items', 'budget_entries',
  'packing_items', 'notes', 'inspiration_items',
] as const

/**
 * Import content from a JSON export into the current trip. Authorship is
 * reassigned to the importer; ids are regenerated; polls come back with
 * their options but without votes.
 */
export async function importTripJson(
  tripId: string,
  memberId: string,
  file: File
): Promise<number> {
  const parsed = JSON.parse(await file.text()) as TripExport
  if (parsed.format !== 'wander-trip-v1') {
    throw new Error('Not a Wander trip export file')
  }

  let imported = 0

  for (const table of IMPORT_TABLES) {
    const rows = parsed.tables[table] ?? []
    if (rows.length === 0) continue
    const cleaned = rows.map((row) => {
      const {
        id: _id, trip_id: _t, created_at: _c, updated_at: _u,
        created_by: _cb, member_id: _m, added_by: _ab,
        assignee_id: _as, paid_by: _pb,
        ...rest
      } = row
      const authored: Record<string, unknown> = { ...rest, trip_id: tripId }
      if ('created_by' in row) authored.created_by = memberId
      if ('member_id' in row) authored.member_id = memberId
      if ('added_by' in row) authored.added_by = memberId
      return authored
    })
    const { error } = await supabase.from(table).insert(cleaned)
    if (error) throw error
    imported += cleaned.length
  }

  // Polls + options (rebuild the id links, drop votes/closed state authorship)
  const polls = parsed.tables.polls ?? []
  const options = parsed.tables.poll_options ?? []
  for (const poll of polls) {
    const { data: created, error } = await supabase
      .from('polls')
      .insert({
        trip_id: tripId,
        created_by: memberId,
        question: poll.question,
        category: poll.category,
        closed: poll.closed,
      })
      .select()
      .single()
    if (error) throw error
    const own = options.filter((o) => o.poll_id === poll.id)
    if (own.length > 0) {
      const { error: optError } = await supabase.from('poll_options').insert(
        own.map((o) => ({
          trip_id: tripId,
          poll_id: created.id,
          label: o.label,
          position: o.position,
        }))
      )
      if (optError) throw optError
    }
    imported += 1 + own.length
  }

  return imported
}
