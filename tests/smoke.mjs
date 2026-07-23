/**
 * Playwright smoke test for Wander's three core flows, run against the real
 * built app with a fully-stubbed Supabase (auth + REST). No live project and
 * no network: the entire Supabase host is intercepted per-request, so the
 * test stays hermetic and deterministic in CI.
 *
 * Flows covered (see docs/ARCHITECTURE.md §2 for the identity model):
 *   1. Sign-in     — magic-link request lands on the "check your inbox" state
 *   2. Join        — invite link → anonymous session → name form → joined trip
 *   3. Create trip — signed-in owner creates a trip → welcome (name) step
 *
 * This uses the `playwright` library directly (like scripts/screenshot.mjs)
 * with plain assertions, so it needs no extra test-runner dependency.
 *
 * It expects the built app to already be served (the CI job and the local
 * recipe below background `vite preview` first — the same pattern the
 * screenshot harness uses):
 *
 *   npm run build
 *   npm run preview -- --port 4173 --strictPort &
 *   # wait for http://localhost:4173 to answer, then:
 *   npm test
 *
 * Env:
 *   BASE_URL                  app under test (default http://localhost:4173)
 *   PLAYWRIGHT_CHROMIUM_PATH  optional Chromium executable (sandboxes that
 *                             ship a browser at a fixed path); CI installs it
 *                             at the default location and leaves this unset.
 */
import { chromium } from 'playwright'

const SUPABASE_HOST = 'qqmfxbcroxunvtgxxray.supabase.co'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173'

// ── Canned identities & rows the stub hands back ──────────────────────────
const TRIP_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const ANON_ID = '33333333-3333-4333-8333-333333333333'
const OWNER_EMAIL = 'planner@example.com'
// Far-future expiry (seconds) so getSession() never triggers a token refresh.
const FAR_FUTURE = 4102444800 // 2100-01-01

function gotrueUser(userId, { anonymous, email }) {
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

function session(userId, opts) {
  return {
    access_token: `stub.${userId}.token`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: FAR_FUTURE,
    refresh_token: `stub-refresh-${userId}`,
    user: gotrueUser(userId, opts),
  }
}

const OWNER_SESSION = session(OWNER_ID, { anonymous: false, email: OWNER_EMAIL })

const TRIP_ROW = {
  id: TRIP_ID,
  owner_id: OWNER_ID,
  name: 'Lisbon in Spring',
  destination: 'Lisbon, Portugal',
  description: null,
  cover_url: null,
  start_date: null,
  end_date: null,
  estimated_budget: null,
  currency: 'USD',
  invite_code: 'lisbon2026',
  invite_enabled: true,
  archived: false,
  checklist_starter_dismissed: false,
  created_at: '2026-02-01T00:00:00Z',
}

const OWNER_MEMBER = {
  id: '44444444-4444-4444-8444-444444444444',
  trip_id: TRIP_ID,
  user_id: OWNER_ID,
  display_name: 'planner',
  color: '#0e7490',
  role: 'owner',
  joined_at: '2026-02-01T00:00:00Z',
}

const INVITE_PREVIEW = {
  trip_name: 'Lisbon in Spring',
  destination: 'Lisbon, Portugal',
  cover_url: null,
  member_count: 3,
  start_date: null,
  end_date: null,
}

// ── The Supabase stub: one handler for every request to the project host ──
async function routeSupabase(route) {
  const req = route.request()
  const { pathname } = new URL(req.url())
  const method = req.method()

  let body = {}
  try {
    body = req.postDataJSON() ?? {}
  } catch {
    body = {}
  }

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
  if (pathname.endsWith('/auth/v1/otp')) return json({ messageId: null }) // magic link "sent"
  if (pathname.endsWith('/auth/v1/signup')) return json(session(ANON_ID, { anonymous: true }))
  if (pathname.includes('/auth/v1/token')) return json(OWNER_SESSION) // refresh grant
  if (pathname.endsWith('/auth/v1/user'))
    return json(gotrueUser(OWNER_ID, { anonymous: false, email: OWNER_EMAIL }))
  if (pathname.endsWith('/auth/v1/logout')) return route.fulfill({ status: 204, body: '' })

  // ── RPCs ──
  if (pathname.endsWith('/rest/v1/rpc/join_trip')) {
    // Mirrors join_trip: a blank display name means "show the name form".
    if (!body.p_display_name) {
      return json({ code: 'P0001', message: 'NAME_REQUIRED', details: null, hint: null }, 400)
    }
    return json(JSON.stringify(TRIP_ID)) // scalar text → a bare JSON string
  }
  if (pathname.endsWith('/rest/v1/rpc/get_invite_preview')) return json([INVITE_PREVIEW])

  // ── REST tables ──
  if (pathname.endsWith('/rest/v1/trips')) {
    if (method === 'POST') return json(TRIP_ROW, 201) // insert().select().single()
    return json([]) // trip list — start with none
  }
  if (pathname.endsWith('/rest/v1/members')) {
    if (method === 'GET') return json(OWNER_MEMBER) // .single() after create
    return json([])
  }

  // Anything else (stray queries from lazily-mounted pages): empty + harmless.
  return json([])
}

// ── Tiny assertion helpers ────────────────────────────────────────────────
let passed = 0
function ok(label) {
  passed += 1
  console.log(`  PASS ${label}`)
}

async function newContext(browser, initSession) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.route((url) => url.hostname === SUPABASE_HOST, routeSupabase)
  if (initSession) {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value)
        localStorage.setItem('wander_theme', 'light')
      },
      ['wander_auth', JSON.stringify(initSession)]
    )
  }
  return context
}

async function runSignIn(browser) {
  console.log('\n▶ sign-in (magic link)')
  const context = await newContext(browser)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e))
  try {
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    await page.getByPlaceholder('you@example.com').fill('traveller@example.com')
    await page.getByRole('button', { name: 'Email me a magic link' }).click()
    await page.getByText('Check your inbox').waitFor({ state: 'visible', timeout: 10_000 })
    ok('magic-link request reaches the "check your inbox" state')
    if (errors.length) throw new Error(`Uncaught page error: ${errors[0].message}`)
    ok('sign-in flow raised no uncaught errors')
  } finally {
    await context.close()
  }
}

async function runJoin(browser) {
  console.log('\n▶ join (invite link)')
  const context = await newContext(browser)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/join/lisbon2026`, { waitUntil: 'domcontentloaded' })
    // Anonymous session + NAME_REQUIRED + preview all resolved → the form shows.
    await page.getByText('Lisbon in Spring').waitFor({ state: 'visible', timeout: 10_000 })
    ok('invite preview renders after the anonymous session is created')
    await page.getByPlaceholder('Your name').fill('Alex')
    await page.getByRole('button', { name: 'Join the trip' }).click()
    await page.waitForURL((url) => url.hash.includes(`/trip/${TRIP_ID}`), { timeout: 10_000 })
    ok('joining navigates into the trip')
  } finally {
    await context.close()
  }
}

async function runCreateTrip(browser) {
  console.log('\n▶ create trip (signed-in owner)')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New trip' }).first().click()
    await page.locator('#trip-name').waitFor({ state: 'visible', timeout: 10_000 })
    ok('create-trip dialog opens for a signed-in owner')
    await page.locator('#trip-name').fill('Lisbon in Spring')
    await page.getByRole('button', { name: 'Create trip' }).click()
    // The insert + owner-member fetch succeeded if we reach the welcome step.
    await page
      .getByText('How should we introduce you?')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('creating a trip reaches the welcome step')
  } finally {
    await context.close()
  }
}

async function runOffline(browser) {
  console.log('\n▶ offline read-only banner')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    // Wait for the signed-in home to render before dropping the connection.
    await page.getByRole('button', { name: 'New trip' }).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    const banner = page.getByText('Offline — showing saved data')
    await banner.waitFor({ state: 'hidden', timeout: 2_000 })

    // setOffline flips navigator.onLine and fires the 'offline' event.
    await context.setOffline(true)
    await banner.waitFor({ state: 'visible', timeout: 10_000 })
    ok('offline banner appears when the device goes offline')

    await context.setOffline(false)
    await banner.waitFor({ state: 'hidden', timeout: 10_000 })
    ok('offline banner clears when the device comes back online')
  } finally {
    await context.close()
  }
}

async function runSignOut(browser) {
  console.log('\n▶ sign-out purges the persisted query cache')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const CACHE_KEY = 'wander_query_cache'
  const readCache = () => page.evaluate((k) => localStorage.getItem(k), CACHE_KEY)
  try {
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    // The signed-in home fires the trips query; once it settles the persister
    // writes the snapshot (throttled ~1s), so the cache key appears.
    const signOutBtn = page.getByRole('button', { name: 'Sign out' })
    await signOutBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForFunction(
      (k) => localStorage.getItem(k) !== null,
      CACHE_KEY,
      { timeout: 10_000 }
    )
    ok('persisted query cache is written while signed in')

    // Signing out must clear the in-memory cache AND purge the snapshot, so no
    // account's private data survives on disk or re-hydrates for the next user.
    await signOutBtn.click()
    // Back on the signed-out (magic-link) screen.
    await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible', timeout: 10_000 })
    // The persister's throttled subscription may re-persist one last (empty)
    // snapshot up to ~1s after clear(); the sign-out purge removes that trailing
    // write too. Wait past that window, then assert the key is stably absent.
    await page.waitForTimeout(2_000)
    if ((await readCache()) !== null) {
      throw new Error('wander_query_cache present 2s after sign-out')
    }
    await page.waitForTimeout(1_000)
    if ((await readCache()) !== null) {
      throw new Error('wander_query_cache reappeared after sign-out')
    }
    ok('sign-out purges wander_query_cache from localStorage')
  } finally {
    await context.close()
  }
}

async function main() {
  console.log(`Smoke test against ${BASE_URL}`)
  // Honour a pre-installed browser when one is provided (e.g. sandboxes that
  // ship Chromium at a fixed path); CI installs it at the default location.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
  const browser = await chromium.launch({ executablePath })
  try {
    await runSignIn(browser)
    await runJoin(browser)
    await runCreateTrip(browser)
    await runOffline(browser)
    await runSignOut(browser)
    console.log(`\n✓ smoke: ${passed} assertions passed`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('\n✗ smoke test failed:', err)
  process.exit(1)
})
