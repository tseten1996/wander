/**
 * Deterministic invariant gates, run in CI (see .github/workflows/ci.yml).
 * These promote rules from docs/ARCHITECTURE.md and routines/README.md out
 * of review-prose into hard checks:
 *
 *   1. RLS gate      — every CREATE TABLE in a migration must ENABLE ROW
 *                      LEVEL SECURITY and declare at least one policy for
 *                      that table in the SAME migration file. RLS is the
 *                      app's only security boundary; a table without it is
 *                      world-writable through the public anon key.
 *   2. Token lint    — no raw hex colours in src/ outside the declared
 *                      palette files. Design tokens live in src/index.css;
 *                      runtime palette data lives in the allowlist below.
 *   3. Bundle budget — (--bundle, needs dist/) gzipped JS must stay under
 *                      budget so the free-tier PWA stays fast on phones.
 *
 * Exits non-zero with a file-by-file report on any violation.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const ROOT = join(import.meta.dirname, '..')
const failures = []

// ── 1. RLS gate ───────────────────────────────────────────────────────────
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations')
const stripSchema = (name) => name.replace(/^public\./, '').replace(/"/g, '')

for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    // strip line comments so a commented-out statement can't satisfy the gate
    .replace(/--[^\n]*/g, '')
    .toLowerCase()

  const created = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/g)]
    .map((m) => stripSchema(m[1]))
  const rlsEnabled = new Set(
    [...sql.matchAll(/alter\s+table\s+([a-z0-9_."]+)\s+enable\s+row\s+level\s+security/g)]
      .map((m) => stripSchema(m[1])),
  )
  const hasPolicy = new Set(
    [...sql.matchAll(/create\s+policy\s+[a-z0-9_"]+\s+on\s+([a-z0-9_."]+)/g)]
      .map((m) => stripSchema(m[1])),
  )

  for (const table of created) {
    if (!rlsEnabled.has(table))
      failures.push(`RLS gate: ${file} creates table "${table}" without ENABLE ROW LEVEL SECURITY in the same file`)
    if (!hasPolicy.has(table))
      failures.push(`RLS gate: ${file} creates table "${table}" without any CREATE POLICY for it in the same file`)
  }
}

// ── 2. Token lint ─────────────────────────────────────────────────────────
// Files allowed to define raw colour values. Everything else must consume
// tokens (Tailwind theme classes / CSS vars) or import from these files.
const PALETTE_FILES = new Set([
  'src/index.css', // Tailwind v4 @theme tokens
  'src/lib/colors.ts', // avatar palette + named fallbacks
  'src/features/trips/covers.ts', // cover-gradient preset data
])
const HEX = /#[0-9a-fA-F]{3,8}\b/

/*
  Where a hex colour can legitimately appear as a *value*, per language:

  • ts/tsx — always inside a string literal or a Tailwind arbitrary value
    (`bg-[#0d9488]`); a bare `#0d9488` would not even parse. So only those
    spans are scanned. This is what keeps prose out of the lint: every decimal
    digit is also a hex digit, so a bare-line match made **every issue
    reference of 3+ digits** (`// …under reduced motion (#137)`) a build
    failure — which it did, once issue numbers passed 100.
  • css — values are unquoted (`color: #fff`), so the whole line is scanned
    with comments stripped.
*/
const TS_VALUE_SPANS = /'[^']*'|"[^"]*"|`[^`]*`|\[[^\]\s]*\]/g

/** Blank out /* … *\/ comment text, preserving newlines so line numbers hold. */
const stripCssComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

for (const path of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, path)
  if (PALETTE_FILES.has(rel) || !/\.(ts|tsx|css)$/.test(rel)) continue
  const isCss = rel.endsWith('.css')
  const source = isCss ? stripCssComments(readFileSync(path, 'utf8')) : readFileSync(path, 'utf8')
  source.split('\n').forEach((line, i) => {
    const offends = isCss
      ? HEX.test(line)
      : (line.match(TS_VALUE_SPANS) ?? []).some((span) => HEX.test(span))
    if (offends)
      failures.push(`Token lint: ${rel}:${i + 1} contains a raw hex colour — use a design token or import from src/lib/colors.ts`)
  })
}

// ── 3. Bundle budget (opt-in: needs a fresh dist/) ────────────────────────
const TOTAL_GZIP_BUDGET = 500 * 1024 // baseline ~398 kB (2026-07)
const CHUNK_GZIP_BUDGET = 220 * 1024 // baseline ~183 kB (main chunk)

if (process.argv.includes('--bundle')) {
  const assets = join(ROOT, 'dist/assets')
  if (!existsSync(assets)) {
    failures.push('Bundle budget: dist/assets not found — run `npm run build` first')
  } else {
    let total = 0
    for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
      const size = gzipSync(readFileSync(join(assets, file))).length
      total += size
      if (size > CHUNK_GZIP_BUDGET)
        failures.push(`Bundle budget: ${file} is ${(size / 1024).toFixed(0)} kB gzipped (chunk budget ${CHUNK_GZIP_BUDGET / 1024} kB) — split it or lazy-load the dependency`)
    }
    if (total > TOTAL_GZIP_BUDGET)
      failures.push(`Bundle budget: total JS is ${(total / 1024).toFixed(0)} kB gzipped (budget ${TOTAL_GZIP_BUDGET / 1024} kB)`)
    console.log(`bundle: ${(total / 1024).toFixed(0)} kB gzipped total (budget ${TOTAL_GZIP_BUDGET / 1024} kB)`)
  }
}

if (failures.length) {
  console.error(`\n${failures.length} invariant violation(s):\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('invariants: RLS gate + token lint' + (process.argv.includes('--bundle') ? ' + bundle budget' : '') + ' passed')
