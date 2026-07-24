/**
 * Reusable mock-Supabase screenshot harness.
 *
 * The sandboxed sessions that run these routines cannot reach the live
 * Supabase project, so `scripts/screenshot.mjs` (which signs into the real
 * project and joins the demo trip) is useless there. Until now every session
 * that needed a screenshot of a data-bearing page hand-rolled its own
 * throwaway Playwright script that intercepts the Supabase host and fabricates
 * trip/member/content rows — the same hermetic-stub idea as `tests/smoke.mjs`,
 * re-derived from scratch each time.
 *
 * This script commits that work once. It stubs the entire Supabase host (auth
 * + REST + RPC) from a declarative fixture and screenshots any set of hash
 * routes at any breakpoints, with no network and no live project. Point it at
 * a fixture describing the tables/rows you want and the pages/sizes to grab.
 *
 * ── As a CLI ──────────────────────────────────────────────────────────────
 *   npm run build
 *   npm run preview -- --port 4173 --strictPort &   # serve on :4173
 *   node scripts/screenshot-mock.mjs                # built-in demo fixture
 *   FIXTURE=scripts/fixtures/demo-trip.json \
 *     ROUTES="/trip/{trip},/trip/{trip}/itinerary" \
 *     BREAKPOINTS=mobile,desktop COLOR_SCHEME=dark \
 *     node scripts/screenshot-mock.mjs
 *
 * Env (all optional — every one has a working default):
 *   BASE_URL                  app under test            (default http://localhost:4173)
 *   FIXTURE                   path to a fixture JSON    (default: the built-in demo)
 *   OUT_DIR                   screenshot output dir     (default docs/screenshots)
 *   ROUTES                    comma hash routes; overrides the fixture's.
 *                             "{trip}" expands to the fixture's trip id.
 *   BREAKPOINTS               comma list; overrides the fixture's. Each entry
 *                             is a name ("mobile"/"desktop"/"tablet") or a raw
 *                             pixel width ("414") or "name:width" ("wide:1440").
 *   COLOR_SCHEME              light | dark; overrides the fixture's.
 *   PLAYWRIGHT_CHROMIUM_PATH  Chromium executable for sandboxes that ship one
 *                             at a fixed path (CI leaves it unset).
 *
 * ── As a module ───────────────────────────────────────────────────────────
 * The stub and session builders are exported so a future test or script can
 * reuse them without re-deriving the mock:
 *
 *   import { createSupabaseStub, buildSession, SUPABASE_HOST } from './screenshot-mock.mjs'
 *   await context.route((url) => url.hostname === SUPABASE_HOST,
 *                       createSupabaseStub(myFixture))
 *
 * ── Fixture schema ────────────────────────────────────────────────────────
 *   {
 *     "auth":  { "as": "owner" | "anon", "userId"?, "email"?, "tripId"? },
 *              // or a full GoTrue session object under "session"
 *     "tables": { "<table>": [ { ...row }, ... ], ... },
 *     "rpcs":   { "join_trip": "<trip-id>", "get_invite_preview": [ {...} ] },
 *     "routes": ["/", "/trip/{trip}"],
 *     "breakpoints": [ { "name": "mobile", "width": 375 }, ... ],
 *     "colorScheme": "light"
 *   }
 *
 * The REST responder speaks enough PostgREST to render pages: column filters
 * (eq/neq/gt/gte/lt/lte/like/ilike/in/is, and a `not.` prefix), `order`,
 * `limit`/`offset`, and single-object requests (supabase `.single()` /
 * `.maybeSingle()`, detected from the Accept header). Tables absent from the
 * fixture return empty — pages just render their empty state. Fidelity is
 * "enough to paint a screenshot", not a full Postgres; the fixture author owns
 * which rows exist, so unmodelled bits (realtime, `or=(…)`) degrade quietly
 * rather than failing.
 */
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

export const SUPABASE_HOST = 'qqmfxbcroxunvtgxxray.supabase.co'

// Far-future expiry (seconds) so getSession() never triggers a token refresh.
const FAR_FUTURE = 4102444800 // 2100-01-01

// ── Session builders (the shape supabase-js persists under `wander_auth`) ───

function gotrueUser(userId, { anonymous = false, email = '' } = {}) {
  return {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: email ?? '',
    phone: '',
    is_anonymous: !!anonymous,
    app_metadata: { provider: anonymous ? 'anonymous' : 'email', providers: [] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

/** Build a full GoTrue session for a fabricated user. */
export function buildSession(userId, { anonymous = false, email = '' } = {}) {
  return {
    access_token: `stub.${userId}.token`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: FAR_FUTURE,
    refresh_token: `stub-refresh-${userId}`,
    user: gotrueUser(userId, { anonymous, email }),
  }
}

/** Resolve a fixture's `auth` block into a concrete session object. */
export function resolveAuth(auth = {}) {
  if (auth.session) return auth.session // caller supplied a full session
  const anonymous = auth.as === 'anon'
  const userId =
    auth.userId ?? (anonymous ? '33333333-3333-4333-8333-333333333333'
                              : '22222222-2222-4222-8222-222222222222')
  return buildSession(userId, { anonymous, email: auth.email ?? (anonymous ? '' : 'planner@example.com') })
}

// ── PostgREST-ish query evaluation over fabricated rows ─────────────────────

const decode = (v) => {
  const s = decodeURIComponent(v)
  // PostgREST wraps values containing reserved chars in double quotes.
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

// Loose equality so a fixture's numbers/booleans match string-encoded filters.
const looseEq = (a, b) => String(a) === String(b)

function passesOp(cell, op, rawValue) {
  // `not.` inverts the remaining operator (supabase `.not(col, 'eq', v)`).
  if (op === 'not') {
    const [innerOp, ...rest] = rawValue.split('.')
    return !passesOp(cell, innerOp, rest.join('.'))
  }
  if (op === 'is') {
    const v = rawValue.toLowerCase()
    if (v === 'null') return cell === null || cell === undefined
    if (v === 'true') return cell === true
    if (v === 'false') return cell === false
    return looseEq(cell, rawValue)
  }
  if (op === 'in') {
    const list = rawValue.replace(/^\(|\)$/g, '').split(',').map(decode)
    return list.some((v) => looseEq(cell, v))
  }
  const value = decode(rawValue)
  switch (op) {
    case 'eq': return looseEq(cell, value)
    case 'neq': return !looseEq(cell, value)
    case 'gt': return cell > value
    case 'gte': return cell >= value
    case 'lt': return cell < value
    case 'lte': return cell <= value
    case 'like': return new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*').replaceAll('_', '.') + '$').test(String(cell))
    case 'ilike': return new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*').replaceAll('_', '.') + '$', 'i').test(String(cell))
    default: return true // unmodelled operator → don't filter it out
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or', 'and'])

/**
 * Resolve PostgREST embedded resources in a `select` (e.g. the home page's
 * `select=*,members(*)`) so `row.members` is an array, not undefined — an
 * undefined embed is the classic ".map of undefined" blank-screen crash.
 *
 * One-to-many only, matched by the `<parentSingular>_id` foreign key
 * (trips → members via `members.trip_id`). Anything it can't resolve becomes
 * an empty array rather than a crash. Nested embeds aren't expanded.
 */
function applyEmbeds(rows, select, tables, parentTable) {
  if (!select || !select.includes('(')) return rows
  const embeds = [...select.matchAll(/(?:([a-z_]+):)?([a-z_]+)\(([^()]*)\)/g)]
  if (!embeds.length) return rows
  const fk = `${parentTable.replace(/s$/, '')}_id`
  return rows.map((row) => {
    const copy = { ...row }
    for (const [, alias, name] of embeds) {
      const childRows = tables[name] ?? []
      copy[alias || name] = childRows.filter((c) => c && looseEq(c[fk], row.id))
    }
    return copy
  })
}

function queryRows(rows, search) {
  const params = new URLSearchParams(search)
  let out = rows.slice()

  // Column filters: `col=op.value` (each non-reserved param).
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue
    const dot = raw.indexOf('.')
    if (dot === -1) continue
    const op = raw.slice(0, dot)
    const value = raw.slice(dot + 1)
    out = out.filter((row) => passesOp(row?.[key], op, value))
  }

  // order=col.dir[,col2.dir] (nullsfirst/nullslast suffixes ignored).
  const order = params.get('order')
  if (order) {
    const keys = order.split(',').map((seg) => {
      const [col, dir] = seg.split('.')
      return { col, desc: dir === 'desc' }
    })
    out.sort((a, b) => {
      for (const { col, desc } of keys) {
        const av = a?.[col], bv = b?.[col]
        if (av === bv) continue
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        const cmp = av < bv ? -1 : 1
        return desc ? -cmp : cmp
      }
      return 0
    })
  }

  if (params.has('offset')) {
    const offset = Number(params.get('offset'))
    if (Number.isFinite(offset) && offset > 0) out = out.slice(offset)
  }
  if (params.has('limit')) {
    const limit = Number(params.get('limit'))
    if (Number.isFinite(limit) && limit >= 0) out = out.slice(0, limit)
  }

  return out
}

// ── The stub: one handler for every request to the Supabase host ────────────

/**
 * Build a Playwright route handler that serves a fixture. Returns a function
 * suitable for `context.route((url) => url.hostname === SUPABASE_HOST, handler)`.
 */
export function createSupabaseStub(fixture = {}) {
  const tables = fixture.tables ?? {}
  const rpcs = fixture.rpcs ?? {}
  const session = resolveAuth(fixture.auth)
  const anonSession = buildSession('33333333-3333-4333-8333-333333333333', { anonymous: true })

  return async function routeSupabase(route) {
    const req = route.request()
    const { pathname, search } = new URL(req.url())
    const method = req.method()
    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object')

    let body = {}
    try { body = req.postDataJSON() ?? {} } catch { body = {} }

    const json = (payload, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      })

    // CORS preflight the supabase-js client fires before real requests.
    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
        body: '',
      })
    }

    // ── Auth (GoTrue) ──
    if (pathname.endsWith('/auth/v1/otp')) return json({ messageId: null })
    if (pathname.endsWith('/auth/v1/signup')) return json(anonSession)
    if (pathname.includes('/auth/v1/token')) return json(session)
    if (pathname.endsWith('/auth/v1/user')) return json(session.user)
    if (pathname.endsWith('/auth/v1/logout')) return route.fulfill({ status: 204, body: '' })

    // ── RPCs ── (fixture value wins; join_trip mirrors the NAME_REQUIRED gate)
    const rpcMatch = pathname.match(/\/rest\/v1\/rpc\/([a-z_]+)$/)
    if (rpcMatch) {
      const name = rpcMatch[1]
      if (name === 'join_trip' && !body.p_display_name) {
        return json({ code: 'P0001', message: 'NAME_REQUIRED', details: null, hint: null }, 400)
      }
      if (name in rpcs) {
        const val = rpcs[name]
        // A scalar text RPC (e.g. join_trip → trip id) is a bare JSON string.
        return json(typeof val === 'string' ? JSON.stringify(val) : val)
      }
      return json(null)
    }

    // ── REST tables ──
    const tableMatch = pathname.match(/\/rest\/v1\/([a-z_]+)$/)
    if (tableMatch) {
      const name = tableMatch[1]
      const rows = tables[name] ?? []

      if (method === 'GET') {
        const select = new URLSearchParams(search).get('select')
        const result = applyEmbeds(queryRows(rows, search), select, tables, name)
        if (wantsObject) return json(result[0] ?? null)
        return json(result)
      }
      // Writes: echo the payload as the representation so optimistic mutations
      // and insert().select() resolve. Screenshot pages are read-mostly.
      if (method === 'POST') {
        const rowsIn = Array.isArray(body) ? body : [body]
        return json(wantsObject ? (rowsIn[0] ?? null) : rowsIn, 201)
      }
      if (method === 'PATCH') {
        return json(wantsObject ? (body ?? null) : [body].flat())
      }
      if (method === 'DELETE') {
        return json(wantsObject ? null : [])
      }
    }

    // Anything else (stray queries, realtime handshake fallbacks): harmless.
    return json([])
  }
}

// ── Breakpoint parsing ──────────────────────────────────────────────────────

const NAMED_WIDTHS = { mobile: 375, tablet: 768, desktop: 1280, wide: 1440 }

function parseBreakpoints(spec) {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    if (entry.includes(':')) {
      const [name, w] = entry.split(':')
      return { name: name.trim(), width: Number(w) }
    }
    if (/^\d+$/.test(entry)) return { name: `w${entry}`, width: Number(entry) }
    const width = NAMED_WIDTHS[entry.toLowerCase()]
    if (!width) throw new Error(`Unknown breakpoint "${entry}" (use a pixel width or one of: ${Object.keys(NAMED_WIDTHS).join(', ')})`)
    return { name: entry.toLowerCase(), width }
  })
}

// ── Default demo fixture (zero-arg runnability) ─────────────────────────────

const DEMO_TRIP_ID = 'de300000-0000-4000-8000-000000000001'
const DEMO_OWNER_ID = '22222222-2222-4222-8222-222222222222'

export const DEMO_FIXTURE = {
  auth: { as: 'owner', userId: DEMO_OWNER_ID, email: 'planner@example.com', tripId: DEMO_TRIP_ID },
  tables: {
    trips: [
      {
        id: DEMO_TRIP_ID,
        owner_id: DEMO_OWNER_ID,
        name: 'Kyoto in Autumn',
        destination: 'Kyoto, Japan',
        description: 'Temples, momiji and too much ramen.',
        cover_url: null,
        start_date: '2026-11-14',
        end_date: '2026-11-21',
        estimated_budget: 3200,
        currency: 'USD',
        invite_code: 'demoinvite2026',
        invite_enabled: true,
        archived: false,
        checklist_starter_dismissed: true,
        created_at: '2026-07-01T00:00:00Z',
      },
    ],
    members: [
      {
        id: '44444444-4444-4444-8444-444444444401',
        trip_id: DEMO_TRIP_ID,
        user_id: DEMO_OWNER_ID,
        display_name: 'Mika',
        color: '#0e7490',
        role: 'owner',
        joined_at: '2026-07-01T00:00:00Z',
      },
      {
        id: '44444444-4444-4444-8444-444444444402',
        trip_id: DEMO_TRIP_ID,
        user_id: '55555555-5555-4555-8555-555555555502',
        display_name: 'Sam',
        color: '#b45309',
        role: 'member',
        joined_at: '2026-07-02T00:00:00Z',
      },
    ],
  },
  rpcs: {
    join_trip: DEMO_TRIP_ID,
    get_invite_preview: [
      { trip_name: 'Kyoto in Autumn', destination: 'Kyoto, Japan', cover_url: null, member_count: 2, start_date: '2026-11-14', end_date: '2026-11-21' },
    ],
  },
  routes: ['/', '/trip/{trip}'],
  breakpoints: [{ name: 'mobile', width: 375 }, { name: 'desktop', width: 1280 }],
  colorScheme: 'light',
}

// ── CLI runner ──────────────────────────────────────────────────────────────

async function loadFixture() {
  const path = process.env.FIXTURE
  if (!path) return DEMO_FIXTURE
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw)
}

async function main() {
  const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173'
  const OUT_DIR = process.env.OUT_DIR ?? 'docs/screenshots'

  const fixture = await loadFixture()
  const session = resolveAuth(fixture.auth)
  const tripId = fixture.auth?.tripId ?? fixture.tables?.trips?.[0]?.id ?? ''

  const colorScheme =
    (process.env.COLOR_SCHEME ?? fixture.colorScheme ?? 'light') === 'dark' ? 'dark' : 'light'

  const routes = (process.env.ROUTES
    ? process.env.ROUTES.split(',').map((r) => r.trim()).filter(Boolean)
    : fixture.routes ?? ['/'])

  const breakpoints = process.env.BREAKPOINTS
    ? parseBreakpoints(process.env.BREAKPOINTS)
    : (fixture.breakpoints ?? DEMO_FIXTURE.breakpoints)

  mkdirSync(OUT_DIR, { recursive: true })
  const stub = createSupabaseStub(fixture)

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
  const browser = await chromium.launch({ executablePath })
  const written = []
  try {
    for (const bp of breakpoints) {
      const context = await browser.newContext({
        viewport: { width: bp.width, height: 900 },
        deviceScaleFactor: 2,
        colorScheme,
        // The app honours prefers-reduced-motion (a design invariant), so this
        // lands entrance animations on their final frame instantly — otherwise
        // the shot can catch a Framer Motion fade still at opacity 0.
        reducedMotion: 'reduce',
      })
      await context.route((url) => url.hostname === SUPABASE_HOST, stub)
      // Hand the app its session + theme before it boots.
      await context.addInitScript(
        ([value, theme]) => {
          localStorage.setItem('wander_auth', value)
          localStorage.setItem('wander_theme', theme)
        },
        [JSON.stringify(session), colorScheme]
      )
      for (const route of routes) {
        const path = route.replaceAll('{trip}', tripId)
        // A fresh page per route: the app is a HashRouter, so navigating an
        // existing page to a URL that differs only in its hash does NOT reload
        // it — the second route would render into a stale (or torn-down) tree.
        const page = await context.newPage()
        await page.goto(`${BASE_URL}/#${path}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(1500) // data fetch + entrance animations
        const slug = path.replaceAll('/', '_').replace(/[^a-zA-Z0-9_-]/g, '') || 'home'
        const file = `${OUT_DIR}/${bp.name}${slug}_${colorScheme}.png`
        await page.screenshot({ path: file, fullPage: bp.width >= 1024 })
        written.push(file)
        console.log('captured', file)
        await page.close()
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
  console.log(`\n${written.length} screenshots -> ${OUT_DIR}`)
}

// Run only when invoked directly, so the stub/session builders stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\n✗ screenshot-mock failed:', err)
    process.exit(1)
  })
}
