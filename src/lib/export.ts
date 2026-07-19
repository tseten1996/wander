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
