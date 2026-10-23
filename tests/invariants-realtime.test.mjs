import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePublishedTables,
  parseSubscribedTables,
  realtimeGateFailures,
  REALTIME_SUBSCRIPTION_EXCEPTIONS,
} from '../scripts/realtime-publication-gate.mjs'

// ── Pure parsers ───────────────────────────────────────────────────────────

test('parses the single-table publication form', () => {
  assert.deepEqual(
    parsePublishedTables('alter publication supabase_realtime add table public.transport;'),
    ['transport'],
  )
})

test('parses the multi-line, comma-separated publication form', () => {
  const sql = `alter publication supabase_realtime add table
    public.trips, public.members, public.polls, public.activity;`
  assert.deepEqual(parsePublishedTables(sql), ['trips', 'members', 'polls', 'activity'])
})

test('does not register a publication named only in a prose comment', () => {
  const sql = `-- transport is already in the supabase_realtime publication, so edits propagate
alter table public.transport enable row level security;`
  assert.deepEqual(parsePublishedTables(sql), [])
})

test('extracts the entries of the TABLES subscription array', () => {
  const source = `const TABLES = [\n  'members', 'polls',\n  'transport',\n]`
  const subscribed = parseSubscribedTables(source)
  assert.ok(subscribed.has('members'))
  assert.ok(subscribed.has('polls'))
  assert.ok(subscribed.has('transport'))
  assert.equal(subscribed.size, 3)
})

test('returns null when the TABLES array cannot be found', () => {
  assert.equal(parseSubscribedTables('const OTHER = ["members"]'), null)
})

// ── End-to-end gate against fixture files ────────────────────────────────────

/** Build a throwaway tree of migration SQL + a useRealtime source, run the gate. */
function runGate({ migrations, tables }) {
  const dir = mkdtempSync(join(tmpdir(), 'wander-realtime-gate-'))
  try {
    const migrationsDir = join(dir, 'migrations')
    mkdirSync(migrationsDir)
    for (const [name, sql] of Object.entries(migrations)) {
      writeFileSync(join(migrationsDir, name), sql)
    }
    const realtimeSourcePath = join(dir, 'useRealtime.ts')
    writeFileSync(realtimeSourcePath, `const TABLES = [${tables.map((t) => `'${t}'`).join(', ')}]`)
    return realtimeGateFailures({ migrationsDir, realtimeSourcePath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('flags a published table deliberately omitted from TABLES (the transport regression)', () => {
  const failures = runGate({
    migrations: {
      '001_init.sql': 'alter publication supabase_realtime add table\n  public.trips, public.members;',
      '002_transport.sql': 'alter publication supabase_realtime add table public.transport;',
    },
    tables: ['members'], // transport published but never subscribed
  })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /002_transport\.sql/)
  assert.match(failures[0], /"transport"/)
  // `trips` is an allowed exception and `members` is subscribed — neither flagged.
  assert.ok(!failures.some((f) => f.includes('"trips"') || f.includes('"members"')))
})

test('passes when every published table is subscribed (trips excepted)', () => {
  const failures = runGate({
    migrations: {
      '001.sql': 'alter publication supabase_realtime add table public.trips, public.members, public.transport;',
    },
    tables: ['members', 'transport'],
  })
  assert.deepEqual(failures, [])
})

test('trips is the one deliberate subscription exception', () => {
  assert.ok(REALTIME_SUBSCRIPTION_EXCEPTIONS.has('trips'))
})
