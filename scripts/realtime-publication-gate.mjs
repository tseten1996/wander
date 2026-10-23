/**
 * Realtime subscription gate — composed into scripts/check-invariants.mjs.
 *
 * A content table added to the `supabase_realtime` publication but missing
 * from the client's subscription list (`TABLES` in src/hooks/useRealtime.ts)
 * is a silent realtime dead-spot: its changes never invalidate any TanStack
 * Query cache, so members see stale data until a manual refresh. `transport`
 * shipped exactly this way — published to realtime in its migration, omitted
 * from `TABLES` — and sat live on `main` for ~3 weeks before a hands-on audit
 * caught it (#398). CI stayed green the whole time because no gate tied the
 * publication to the subscription list. This closes that hole (#410).
 *
 * The parsing functions here are pure (string in, data out) and the gate
 * takes its paths as arguments, so the whole thing is unit-tested with
 * fixtures in tests/invariants-realtime.test.mjs without touching the repo.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const stripSchema = (name) => name.trim().replace(/^public\./, '').replace(/"/g, '').trim()

// `trips` is deliberately absent from `TABLES`: it is subscribed separately in
// useRealtime.ts, filtered on `id` rather than `trip_id`. Any table legitimately
// subscribed outside the `TABLES` loop belongs here, with a reason.
export const REALTIME_SUBSCRIPTION_EXCEPTIONS = new Set(['trips'])

/**
 * Table names added to the supabase_realtime publication by one migration's
 * SQL. Handles both the single-table form (`… add table public.foo;`) and the
 * comma-separated, often multi-line, list form (`… add table public.a,
 * public.b;`). Line comments are stripped first so the many migrations that
 * merely mention the publication in prose never register as a published table.
 */
export function parsePublishedTables(sql) {
  const cleaned = sql.replace(/--[^\n]*/g, '').toLowerCase()
  const tables = []
  for (const m of cleaned.matchAll(
    /alter\s+publication\s+supabase_realtime\s+add\s+table\s+([^;]+);/g,
  )) {
    for (const ref of m[1].split(',')) {
      const table = stripSchema(ref)
      if (table) tables.push(table)
    }
  }
  return tables
}

/**
 * The table names the client subscribes to — the string entries of the
 * `const TABLES = [ … ]` array in src/hooks/useRealtime.ts. Returns null when
 * that array cannot be found, which the gate itself reports as a failure.
 */
export function parseSubscribedTables(source) {
  const match = source.match(/const\s+TABLES\s*=\s*\[([\s\S]*?)\]/)
  if (!match) return null
  return new Set(
    [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => (m[1] ?? m[2]).toLowerCase()),
  )
}

/**
 * Run the gate against real files. Returns an array of human-readable failure
 * strings (empty = pass). Kept separate from the pure parsers above so the
 * parsing can be exercised with fixtures and no filesystem.
 *
 * @param {{ migrationsDir: string, realtimeSourcePath: string }} paths
 */
export function realtimeGateFailures({ migrationsDir, realtimeSourcePath }) {
  const failures = []

  // table -> first migration file that published it (for a precise report)
  const published = new Map()
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    for (const table of parsePublishedTables(sql)) {
      if (!published.has(table)) published.set(table, file)
    }
  }

  const subscribed = parseSubscribedTables(readFileSync(realtimeSourcePath, 'utf8'))
  if (subscribed === null) {
    failures.push(
      `Realtime gate: could not find the TABLES array in ${realtimeSourcePath} — the gate cannot verify realtime subscriptions`,
    )
    return failures
  }

  for (const [table, file] of published) {
    if (REALTIME_SUBSCRIPTION_EXCEPTIONS.has(table)) continue
    if (!subscribed.has(table)) {
      failures.push(
        `Realtime gate: ${file} adds "${table}" to the supabase_realtime publication, ` +
          `but it is missing from the TABLES subscription list in src/hooks/useRealtime.ts — ` +
          `its changes will never invalidate a query (add it to TABLES, or subscribe it ` +
          `separately and list it in REALTIME_SUBSCRIPTION_EXCEPTIONS)`,
      )
    }
  }
  return failures
}
