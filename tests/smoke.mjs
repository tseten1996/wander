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
// The trip id duplicate_trip() hands back — distinct from TRIP_ID so the test
// can prove the UI navigates to the freshly-created copy, not back to the source.
const NEW_TRIP_ID = '55555555-5555-4555-8555-555555555555'
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

// A second member, so the budget/settle-up scenario has someone to split with
// and owe (settle-up is trivially "everyone's even" with a single member). The
// roster only returns this member while `twoMembers` is set (below), so every
// other scenario keeps its single-member roster untouched.
const SECOND_MEMBER = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  trip_id: TRIP_ID,
  user_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  display_name: 'Sam',
  color: '#b45309',
  role: 'member',
  joined_at: '2026-02-01T00:10:00Z',
}

// One unread item in the owner's inbox (#182), so the header bell shows a badge
// and the dropdown has something to render + deep-link.
const NOTIFICATION_ROW = {
  id: '66666666-6666-4666-8666-666666666666',
  trip_id: TRIP_ID,
  recipient_id: OWNER_MEMBER.id,
  actor_id: OWNER_MEMBER.id,
  type: 'checklist_assigned',
  entity_id: null,
  title: 'Book flights',
  created_at: '2026-02-02T00:00:00Z',
  read_at: null,
}

// One open availability poll (#176) with two candidate ranges. The owner has
// marked the first range "yes", so it is the group's best overlap — the page
// must highlight it and offer the owner-only "Apply to trip" action.
const AVAIL_CAND_A = {
  id: '77777777-7777-4777-8777-777777777777',
  trip_id: TRIP_ID,
  poll_id: '88888888-8888-4888-8888-888888888888',
  start_date: '2026-05-01',
  end_date: '2026-05-03',
  position: 0,
  created_at: '2026-02-03T00:00:00Z',
}
const AVAIL_CAND_B = {
  id: '99999999-9999-4999-8999-999999999999',
  trip_id: TRIP_ID,
  poll_id: '88888888-8888-4888-8888-888888888888',
  start_date: '2026-06-05',
  end_date: '2026-06-07',
  position: 1,
  created_at: '2026-02-03T00:00:00Z',
}
const AVAILABILITY_POLL = {
  id: '88888888-8888-4888-8888-888888888888',
  trip_id: TRIP_ID,
  created_by: OWNER_MEMBER.id,
  title: 'When can everyone go?',
  closed: false,
  applied_candidate_id: null,
  created_at: '2026-02-03T00:00:00Z',
  availability_candidates: [AVAIL_CAND_A, AVAIL_CAND_B],
  availability_responses: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      trip_id: TRIP_ID,
      poll_id: '88888888-8888-4888-8888-888888888888',
      candidate_id: AVAIL_CAND_A.id,
      member_id: OWNER_MEMBER.id,
      status: 'yes',
      created_at: '2026-02-03T00:00:00Z',
    },
  ],
}

const INVITE_PREVIEW = {
  trip_name: 'Lisbon in Spring',
  destination: 'Lisbon, Portugal',
  cover_url: null,
  member_count: 3,
  start_date: null,
  end_date: null,
}

// Public read-only itinerary share (#127). A valid token dereferences to this
// whitelisted projection through get_public_itinerary; an invalid/revoked token
// returns SQL null. The token is 64 hex chars, like the real minted one.
const SHARE_TOKEN = 'a'.repeat(64)
const PUBLIC_ITINERARY = {
  trip: {
    name: 'Lisbon in Spring',
    destination: 'Lisbon, Portugal',
    start_date: '2026-05-01',
    end_date: '2026-05-05',
  },
  items: [
    {
      id: 'it-1',
      title: 'Flight to Lisbon',
      category: 'flight',
      day: '2026-05-01',
      end_day: null,
      start_time: '09:00:00',
      end_time: '11:30:00',
      location: 'LIS',
      notes: 'Window seat booked',
    },
    {
      id: 'it-2',
      title: 'Check in at the hostel',
      category: 'hotel',
      day: '2026-05-01',
      end_day: '2026-05-05',
      start_time: '14:00:00',
      end_time: null,
      location: 'Alfama',
      notes: null,
    },
  ],
}

// The `flaky` invite drops every join_trip call (a real network failure) until
// the retry test flips this to true right before clicking "Try again" — proving
// the retryable state recovers in place. The test controls the flip so the
// assertion is deterministic no matter how many times the effect re-runs.
let flakyRecovered = false

// Budget/settle-up scenario state, scoped to `runBudget` (set/reset there):
//   twoMembers    — the roster returns planner + Sam only during that scenario
//   budgetEntries — a stateful expense store so an entry the UI just POSTed
//                   survives the mutation's invalidate → refetch and shows up in
//                   the totals and settle-up the scenario asserts on
let twoMembers = false
let budgetEntries = []

// ── The Supabase stub: one handler for every request to the project host ──
async function routeSupabase(route) {
  const req = route.request()
  const { pathname, search } = new URL(req.url())
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
    // A revoked/regenerated invite: join_trip raises INVALID_INVITE. The client
    // must dead-end this one ("ask for a fresh link").
    if (body.p_invite_code === 'deadlink') {
      return json({ code: 'P0001', message: 'INVALID_INVITE', details: null, hint: null }, 400)
    }
    // A flaky connection: the join_trip request never reaches the server. The
    // client must NOT read a network drop as a dead link. Once the retry test
    // flips `flakyRecovered`, the call falls through to the normal
    // NAME_REQUIRED → form path, proving recovery in place.
    if (body.p_invite_code === 'flaky' && !flakyRecovered) {
      return route.abort('failed')
    }
    // Mirrors join_trip: a blank display name means "show the name form".
    if (!body.p_display_name) {
      return json({ code: 'P0001', message: 'NAME_REQUIRED', details: null, hint: null }, 400)
    }
    return json(JSON.stringify(TRIP_ID)) // scalar text → a bare JSON string
  }
  if (pathname.endsWith('/rest/v1/rpc/get_invite_preview')) return json([INVITE_PREVIEW])
  // get_public_itinerary (#127) returns a jsonb object for a valid token, or SQL
  // null (→ body "null") for an invalid/revoked one — the not-found signal.
  if (pathname.endsWith('/rest/v1/rpc/get_public_itinerary')) {
    return json(body.p_token === SHARE_TOKEN ? PUBLIC_ITINERARY : null)
  }
  // set_trip_share (#127) mints/clears the token owner-side and returns it as a
  // scalar text (a bare JSON string), or null when disabling.
  if (pathname.endsWith('/rest/v1/rpc/set_trip_share')) {
    return json(body.p_enabled ? JSON.stringify(SHARE_TOKEN) : null)
  }
  // duplicate_trip (#80) copies a trip server-side and returns the new trip id
  // as a scalar text → a bare JSON string, exactly like join_trip.
  if (pathname.endsWith('/rest/v1/rpc/duplicate_trip')) return json(JSON.stringify(NEW_TRIP_ID))
  // apply_availability_dates (#176) writes the trip's dates owner-side and
  // returns void → an empty 204, exactly like a no-return RPC.
  if (pathname.endsWith('/rest/v1/rpc/apply_availability_dates'))
    return route.fulfill({ status: 204, body: '' })

  // ── REST tables ──
  // Discriminate by the query shape so one stub serves several call sites:
  //   trips   — the trip page reads a single row (`.eq('id', …).maybeSingle()`);
  //             the home list reads all rows (no id filter).
  //   members — the trip page reads the ordered roster (`.order('joined_at')`);
  //             create-trip reads just the owner row (`.single()`, no order).
  if (pathname.endsWith('/rest/v1/trips')) {
    if (method === 'POST') return json(TRIP_ROW, 201) // insert().select().single()
    if (search.includes('id=eq.')) return json(TRIP_ROW) // trip page: one trip
    return json([]) // home trip list — start with none
  }
  if (pathname.endsWith('/rest/v1/members')) {
    if (method !== 'GET') return json([])
    // Trip page roster: two members only while the budget scenario runs, so
    // settle-up has someone to split with; one member everywhere else.
    if (search.includes('order='))
      return json(twoMembers ? [OWNER_MEMBER, SECOND_MEMBER] : [OWNER_MEMBER])
    return json(OWNER_MEMBER) // .single() after create
  }

  // Budget expenses (#187): a stateful store so the settle-up scenario can add
  // entries through the real UI and have them survive the mutation's
  // invalidate → refetch. insert().select('id').single() wants one row back with
  // its id; the GET returns newest-first like the real `.order('created_at')`.
  if (pathname.endsWith('/rest/v1/budget_entries')) {
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = budgetEntries.length + 1
      const row = { id: `be-${n}`, created_at: `2026-03-01T00:00:0${n}Z`, ...payload }
      budgetEntries.push(row)
      return json({ id: row.id }, 201)
    }
    if (method === 'GET') return json([...budgetEntries].reverse())
    return json([]) // PATCH/DELETE unused by this scenario
  }

  // Notification inbox (#182): the shell header bell reads the recipient's own
  // rows and marks them read (PATCH). The stub hands back one unread item.
  if (pathname.endsWith('/rest/v1/notifications')) {
    if (method === 'GET') return json([NOTIFICATION_ROW])
    return json([]) // PATCH mark-read / anything else
  }

  // Availability poll (#176): the Dates page reads the poll with its candidates
  // and responses embedded; marking availability upserts a response row.
  if (pathname.endsWith('/rest/v1/availability_polls')) {
    if (method === 'GET') return json([AVAILABILITY_POLL])
    return json([]) // insert/update/delete
  }
  if (pathname.endsWith('/rest/v1/availability_responses')) {
    if (method === 'GET') return json([])
    return route.fulfill({ status: 201, body: '' }) // upsert (return=minimal)
  }
  if (pathname.endsWith('/rest/v1/availability_candidates')) return json([])

  // Client error telemetry (#57): the global handlers fire-and-forget an insert
  // here. The insert asks for no representation back, so a bare 201 is correct.
  if (pathname.endsWith('/rest/v1/error_reports')) {
    if (method === 'POST') return route.fulfill({ status: 201, body: '' })
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

    // Post-join install nudge (#99). Headless Chromium won't fire a real
    // `beforeinstallprompt`, so synthesize one (with the deferred-prompt shape
    // the hook consumes) to exercise the Chromium install path deterministically.
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt')
      // The hook calls preventDefault(), then later prompt() + userChoice.
      e.prompt = async () => {}
      e.userChoice = Promise.resolve({ outcome: 'dismissed' })
      window.dispatchEvent(e)
    })
    const nudge = page.getByRole('dialog', { name: 'Add Wander to your home screen' })
    await nudge.waitFor({ state: 'visible', timeout: 10_000 })
    ok('a captured install prompt after join surfaces the "keep your spot" nudge')

    // Dismissing it persists per-device and never blocks the trip.
    await nudge.getByRole('button', { name: 'Not now' }).click()
    await nudge.waitFor({ state: 'hidden', timeout: 10_000 })
    const dismissed = await page.evaluate(() =>
      localStorage.getItem('wander_install_nudge_dismissed')
    )
    if (dismissed !== '1') throw new Error('dismissing the nudge did not persist per device')
    ok('dismissing the nudge persists so it will not nag again')

    // A second captured prompt must not resurrect a dismissed nudge.
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt')
      e.prompt = async () => {}
      e.userChoice = Promise.resolve({ outcome: 'dismissed' })
      window.dispatchEvent(e)
    })
    if (await nudge.isVisible()) throw new Error('a dismissed nudge reappeared on a later prompt')
    ok('a dismissed nudge stays dismissed on a later install prompt')
  } finally {
    await context.close()
  }
}

async function runJoinDeadLink(browser) {
  console.log('\n▶ join: a genuinely invalid invite still dead-ends')
  const context = await newContext(browser)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/join/deadlink`, { waitUntil: 'domcontentloaded' })
    // INVALID_INVITE from the server → the honest "ask for a fresh link" screen.
    await page
      .getByText('This invite link doesn’t work')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a real INVALID_INVITE still shows the "ask for a fresh link" screen')
  } finally {
    await context.close()
  }
}

async function runJoinTransientError(browser) {
  console.log('\n▶ join: a transient failure is retryable, not a dead link')
  const context = await newContext(browser)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/join/flaky`, { waitUntil: 'domcontentloaded' })
    // A non-INVALID_INVITE failure must land on the retryable "couldn’t connect"
    // state — never the dead-end that tells a friend to give up on a good link.
    await page.getByText('Couldn’t connect').waitFor({ state: 'visible', timeout: 10_000 })
    ok('a network/auth failure shows the retryable "couldn’t connect" state')
    if (await page.getByText('This invite link doesn’t work').isVisible()) {
      throw new Error('a transient failure was misdiagnosed as a dead invite link')
    }
    ok('a transient failure is not blamed on the invite link')
    // Let the next join_trip through, then retry: it must recover in place (no
    // full reload) → the name form appears.
    flakyRecovered = true
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.getByText('Lisbon in Spring').waitFor({ state: 'visible', timeout: 10_000 })
    ok('Try again recovers into the join form without a full reload')
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

    // Currency picker (#110): present and defaulting to USD, so the
    // single-currency case is correct with no extra input and existing behaviour
    // is unchanged.
    const currency = page.getByRole('combobox', { name: 'Currency' })
    await currency.waitFor({ state: 'visible', timeout: 10_000 })
    if (!((await currency.textContent()) ?? '').includes('USD')) {
      throw new Error('create-trip currency picker did not default to USD')
    }
    ok('create-trip offers a currency picker defaulting to USD')

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

/*
  Place autocomplete (destination + itinerary location fields).

  The geocoder is the one external host the app talks to besides Supabase, so
  it gets stubbed here the same way — hermetic, and it lets the dropdown
  actually appear, which no earlier scenario could do. What's asserted is the
  behaviour that used to make the field fight the user: re-querying the label
  it had just written back (so the list reopened on the thing you picked),
  opening itself over a form nobody had touched, and taking the whole dialog
  down with Escape.
*/
const PHOTON_HOST = 'photon.komoot.io'

function photonFeature(name, city, country, lon, lat) {
  return { geometry: { coordinates: [lon, lat] }, properties: { name, city, country } }
}

async function runPlaceAutocomplete(browser) {
  console.log('\n▶ place autocomplete (suggestions stay out of the way)')
  const context = await newContext(browser, OWNER_SESSION)
  let photonRequests = 0
  await context.route(
    (url) => url.hostname === PHOTON_HOST,
    async (route) => {
      photonRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          features: [
            photonFeature('Lisbon', null, 'Portugal', -9.1393, 38.7223),
            photonFeature('Lisboa Santa Apolónia', 'Lisbon', 'Portugal', -9.1224, 38.7139),
          ],
        }),
      })
    }
  )
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New trip' }).first().click()
    await page.locator('#trip-name').waitFor({ state: 'visible', timeout: 10_000 })

    const dest = page.locator('#trip-dest')
    const listbox = page.locator('#trip-dest-listbox')

    await dest.fill('Lis')
    await listbox.waitFor({ state: 'visible', timeout: 10_000 })
    ok('typing a place opens the suggestion list')

    const firstOption = listbox.getByRole('option').first()
    const chosen = (await firstOption.textContent())?.trim()
    await firstOption.click()
    await listbox.waitFor({ state: 'hidden', timeout: 10_000 })
    if ((await dest.inputValue()) !== chosen) {
      throw new Error(`picking a suggestion did not fill the field with "${chosen}"`)
    }
    ok('picking a suggestion fills the field and closes the list')

    // The regression: select() writes the label into `value`, which used to
    // re-trigger the debounced query and reopen the list on the chosen item.
    const afterSelect = photonRequests
    await page.waitForTimeout(800) // debounce is 300ms — well clear of it
    if (photonRequests !== afterSelect) {
      throw new Error('selecting a suggestion re-queried the geocoder')
    }
    if (await listbox.isVisible()) {
      throw new Error('the suggestion list reopened after a selection')
    }
    ok('selecting a suggestion does not re-query or reopen the list')

    // Escape belongs to the innermost open thing: the list, then the dialog.
    await dest.fill('Lisb')
    await listbox.waitFor({ state: 'visible', timeout: 10_000 })
    await dest.press('Escape')
    await listbox.waitFor({ state: 'hidden', timeout: 10_000 })
    if (!(await page.locator('#trip-name').isVisible())) {
      throw new Error('Escape closed the whole dialog instead of just the suggestions')
    }
    ok('Escape dismisses the suggestions and keeps the dialog open')

    await dest.press('Escape')
    await page.locator('#trip-name').waitFor({ state: 'hidden', timeout: 10_000 })
    ok('a second Escape then closes the dialog as usual')

    // Mobile: the field sits above Cost/Link/Notes and the submit button in a
    // bottom sheet, so a tall panel buries the very control you're reaching
    // for — and a suggestion row is a tap target like any other (44px floor).
    await page.setViewportSize({ width: 375, height: 720 })
    await page.getByRole('button', { name: 'New trip' }).first().click()
    await page.locator('#trip-name').waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('#trip-dest').fill('Lis')
    await listbox.waitFor({ state: 'visible', timeout: 10_000 })

    const optionBox = await listbox.getByRole('option').first().boundingBox()
    if (!optionBox || optionBox.height < 44) {
      throw new Error(`suggestion row is ${optionBox?.height ?? 0}px tall, below the 44px floor`)
    }
    ok('suggestion rows meet the 44px mobile tap floor')

    const listBox = await listbox.boundingBox()
    const submitBox = await page.getByRole('button', { name: 'Create trip' }).boundingBox()
    if (listBox && submitBox) {
      const overlaps =
        listBox.y < submitBox.y + submitBox.height && submitBox.y < listBox.y + listBox.height
      if (overlaps) {
        throw new Error('the suggestion list covers the Create trip button at 375px')
      }
    }
    ok('the suggestion list does not bury the submit button at 375px')

    await page.locator('#trip-dest').press('Escape')
    await page.locator('#trip-name').press('Escape')
    await page.locator('#trip-name').waitFor({ state: 'hidden', timeout: 10_000 })
    await page.setViewportSize({ width: 1280, height: 800 })

    // A prefilled field (editing an existing trip) must not summon the list:
    // the value changes programmatically, which is not the user typing.
    const before = photonRequests
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/settings`, { waitUntil: 'domcontentloaded' })
    const settingsDest = page.locator('#s-dest')
    await settingsDest.waitFor({ state: 'visible', timeout: 10_000 })
    if (!((await settingsDest.inputValue()) ?? '').trim()) {
      throw new Error('settings destination was empty — the prefill case is not being exercised')
    }
    await page.waitForTimeout(800)
    if (await page.locator('#s-dest-listbox').isVisible()) {
      throw new Error('the suggestion list opened over an untouched form')
    }
    if (photonRequests !== before) {
      throw new Error('a prefilled destination queried the geocoder without user input')
    }
    ok('a prefilled destination neither queries nor opens the list')
  } finally {
    await context.close()
  }
}

async function runDuplicateTrip(browser) {
  console.log('\n▶ duplicate trip (owner reuses a trip as a starting point)')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/settings`, { waitUntil: 'domcontentloaded' })
    // Settings renders once trip + members resolve. The "Reuse this trip" card
    // is owner/non-anonymous only (duplicating creates a trip they'd own).
    const openBtn = page.getByRole('button', { name: 'Duplicate trip' })
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await openBtn.click()

    // Dialog: name prefilled "Copy of <trip>", section checkboxes default on.
    await page.getByText('Duplicate this trip').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the duplicate dialog opens with the trip to copy')

    // Submit → duplicate_trip RPC returns the new id → navigate into the copy.
    await page.getByRole('button', { name: 'Create duplicate' }).click()
    await page.waitForURL((url) => url.hash.includes(`/trip/${NEW_TRIP_ID}`), { timeout: 10_000 })
    ok('duplicating navigates into the newly-created trip')
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

async function runTripPresence(browser) {
  console.log('\n▶ trip page mounts without a realtime presence crash')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}`, { waitUntil: 'domcontentloaded' })
    // TripLayout renders the trip name once trip + members resolve. The layout
    // mounts LivePresence twice (desktop sidebar + mobile top bar); both share
    // ONE presence channel via the trip context. If a change makes each widget
    // open its own subscription again, supabase-js reuses the channel by topic
    // and the second `.on('presence', …)` throws
    //   "cannot add `presence` callbacks for … after `subscribe()`."
    // during commit — which unmounts the whole tree, leaving a blank page and
    // never rendering the name below.
    await page
      .getByText('Lisbon in Spring')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('trip layout renders for the owner (no blank-screen crash)')

    const presenceErr = errors.find((m) => /presence|after `subscribe`/i.test(m))
    if (presenceErr) throw new Error(`realtime presence crash re-introduced: ${presenceErr}`)
    if (errors.length) throw new Error(`Uncaught page error on the trip page: ${errors[0]}`)
    ok('trip page raised no realtime presence / uncaught errors')

    // Personal notification inbox (#182): the header bell reflects the unread
    // count and opens the inbox listing the item with a deep link.
    const bell = page.getByRole('button', { name: /Notifications/ }).first()
    await bell.waitFor({ state: 'visible', timeout: 10_000 })
    if (!/unread/.test((await bell.getAttribute('aria-label')) ?? '')) {
      throw new Error('notification bell did not reflect the unread count')
    }
    ok('the header notification bell shows an unread badge')

    await bell.click()
    await page.getByText('Book flights').waitFor({ state: 'visible', timeout: 10_000 })
    ok('opening the inbox lists the notification')
  } finally {
    await context.close()
  }
}

async function runAvailabilityPoll(browser) {
  console.log('\n▶ availability poll (mark dates + owner applies the winner)')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/dates`, { waitUntil: 'domcontentloaded' })

    // The poll and its candidate ranges render, with the best overlap flagged.
    await page.getByText('When can everyone go?').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the availability poll and its title render')
    await page.getByText('Best overlap').first().waitFor({ state: 'visible', timeout: 10_000 })
    ok('the best-overlap candidate is highlighted')

    // The owner gets the "New date poll" creation control (owner-only).
    await page
      .getByRole('button', { name: 'New date poll' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('the owner sees the create-poll control')

    // Marking availability upserts the current member's own response row.
    const responseWrite = page.waitForRequest(
      (req) =>
        req.url().includes('/rest/v1/availability_responses') &&
        (req.method() === 'POST' || req.method() === 'PATCH'),
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'Yes' }).nth(1).click()
    await responseWrite
    ok('marking a candidate available writes an availability response')

    // The owner applies the winning range: the confirm dialog opens, and
    // confirming calls the owner-only apply RPC.
    await page.getByRole('button', { name: 'Apply to trip' }).first().click()
    await page.getByText('Set the trip dates?').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the apply-dates confirmation dialog opens')

    const applyRpc = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/rpc/apply_availability_dates'),
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'Apply dates' }).click()
    await applyRpc
    ok('confirming calls the apply_availability_dates RPC')
  } finally {
    await context.close()
  }
}

/*
  Budget / settle-up money surface (#187).

  The most logic-dense, most-churned surface — multi-currency entry, converted
  totals and "who owes who" — had no integration coverage: unit tests exercise
  the pure math, but a wrong converted total on a summary card or a broken
  settle-up render would reach `main` with nothing catching it. This drives the
  real Budget page end-to-end against the stubbed Supabase (plus a stubbed ECB
  rates host, the one extra network dependency the page has), adding two
  mixed-currency expenses and asserting both the converted trip total and the
  settle-up output.

  The scenario:
    - trip currency USD, two members (planner = the signed-in owner, and Sam)
    - expense A: €200 paid by planner at 1 EUR = 1.25 USD → 250 USD, split evenly
    - expense B: $80 paid by Sam, split evenly
  So the trip totals 330 USD (250 converted + 80), and settle-up nets
  planner +85 / Sam −85 → Sam owes planner $85.
*/
const FRANKFURTER_HOST = 'api.frankfurter.dev'

async function runBudget(browser) {
  console.log('\n▶ budget / settle-up (mixed-currency total + who-owes-who)')
  budgetEntries = []
  twoMembers = true
  const context = await newContext(browser, OWNER_SESSION)
  // Stub the ECB rates host the same way the geocoder is stubbed elsewhere, so
  // the currency picker offers EUR (the page degrades to trip-currency-only when
  // rates are unreachable). The rate itself is typed in the form, so these
  // numbers only need to make EUR selectable.
  await context.route(
    (url) => url.hostname === FRANKFURTER_HOST,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          amount: 1,
          base: 'USD',
          date: '2026-03-01',
          rates: { EUR: 0.8, GBP: 0.75, CAD: 1.35, AUD: 1.5, JPY: 150, CHF: 0.9 },
        }),
      })
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Add one expense through the dialog. `currency`/`rate` are only touched for a
  // foreign entry; `payer` is the member name to attribute it to.
  async function addExpense({ title, amount, currency, rate, payer }) {
    await page.getByRole('button', { name: 'Add expense' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#b-title').waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.locator('#b-title').fill(title)
    if (currency && currency !== 'USD') {
      await page.getByRole('combobox', { name: 'Entry currency' }).click()
      await page.getByRole('option', { name: currency, exact: true }).click()
      await dialog.locator('#b-rate').waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.locator('#b-rate').fill(String(rate))
    }
    await dialog.locator('#b-act').fill(String(amount))
    // "Paid by" is the combobox defaulting to "Shared / not paid yet".
    await page.getByRole('combobox').filter({ hasText: 'Shared / not paid yet' }).click()
    await page.getByRole('option', { name: payer, exact: true }).click()
    // Submit is the dialog's own "Add expense" (distinct from the header one).
    await dialog.getByRole('button', { name: 'Add expense' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
  }

  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/budget`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Add expense' }).waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    ok('the budget page renders for the owner')

    // €200 at 1.25 → $250, paid by the owner.
    await addExpense({ title: 'Hotel', amount: 200, currency: 'EUR', rate: 1.25, payer: 'planner' })
    // The foreign entry shows both its converted trip-currency total and the
    // original amount — the conversion actually happened, and was frozen.
    const hotelRow = page.getByText('Hotel').locator('xpath=../..')
    await hotelRow.getByText('$250').waitFor({ state: 'visible', timeout: 10_000 })
    await hotelRow.getByText('€200').waitFor({ state: 'visible', timeout: 10_000 })
    ok('a €200 entry at 1.25 converts to $250 and keeps its original amount')

    // $80 in the trip currency, paid by Sam.
    await addExpense({ title: 'Dinner', amount: 80, payer: 'Sam' })
    await page.getByText('Dinner').waitFor({ state: 'visible', timeout: 10_000 })

    // Converted trip total: $250 (from EUR) + $80 = $330 on the Planned card. A
    // broken conversion (summing raw 200 + 80) would read $280 here.
    const planned = page.getByText('Planned').locator('xpath=..')
    await planned.getByText('$330').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the trip total sums the converted amounts to $330')

    // Settle-up "who owes who": planner fronted 250 + shares 165 → owed $85; Sam
    // fronted 80 + shares 165 → owes $85; minimal transfer is Sam → planner $85.
    await page.getByText('Settle up').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('gets back $85').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('owes $85').waitFor({ state: 'visible', timeout: 10_000 })
    ok('settle-up nets the mixed-currency expenses to Sam owes planner $85')

    if (errors.length) throw new Error(`Uncaught page error on the budget page: ${errors[0]}`)
    ok('the budget flow raised no uncaught errors')
  } finally {
    twoMembers = false
    await context.close()
  }
}

async function runErrorReporting(browser) {
  console.log('\n▶ error reporting (uncaught errors reach the error_reports table)')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    // Wait for the signed-in home so a session exists (the INSERT policy needs
    // one) before we synthesize errors.
    await page.getByRole('button', { name: 'New trip' }).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    })

    // An uncaught window error is captured and written to error_reports. We
    // dispatch a synthetic ErrorEvent (not a real throw) so the assertion is
    // deterministic and doesn't itself fail the harness.
    const errorInsert = page.waitForRequest(
      (req) =>
        req.url().includes('/rest/v1/error_reports') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.evaluate(() => {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'smoke-boom', error: new Error('smoke-boom') })
      )
    })
    const errPayload = (await errorInsert).postDataJSON()
    if (!errPayload || !String(errPayload.message).includes('smoke-boom')) {
      throw new Error(`error report missing the message: ${JSON.stringify(errPayload)}`)
    }
    ok('an uncaught window error is written to error_reports')

    // The unhandledrejection path is wired too. A synthetic PromiseRejectionEvent
    // carries a resolved promise (the constructor only needs a Promise object)
    // so no real rejection escapes into the page.
    const rejectInsert = page.waitForRequest(
      (req) =>
        req.url().includes('/rest/v1/error_reports') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.evaluate(() => {
      window.dispatchEvent(
        new PromiseRejectionEvent('unhandledrejection', {
          promise: Promise.resolve(),
          reason: new Error('smoke-reject'),
        })
      )
    })
    const rejPayload = (await rejectInsert).postDataJSON()
    if (!rejPayload || !String(rejPayload.message).includes('smoke-reject')) {
      throw new Error(`rejection report missing the reason: ${JSON.stringify(rejPayload)}`)
    }
    ok('an unhandled promise rejection is written to error_reports')
  } finally {
    await context.close()
  }
}

async function runPublicShare(browser) {
  console.log('\n▶ public share (read-only itinerary for someone with no account)')
  // No initSession: an outsider with no Wander session must reach the page
  // through the token alone — the whole point of the public-read surface.
  const context = await newContext(browser)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/p/${SHARE_TOKEN}`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('heading', { name: 'Lisbon in Spring' }).waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    ok('a valid share link renders the itinerary with no session')

    // Day-grouped, read-only content: the first day header and an item render.
    await page.getByText('Day 1').first().waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Flight to Lisbon').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the itinerary is day-grouped with its items')

    // Read-only: no join, no chat, no edit affordances leak onto the page.
    for (const forbidden of ['Join the trip', 'Add item', 'Chat', 'Edit']) {
      if ((await page.getByRole('button', { name: forbidden }).count()) > 0) {
        throw new Error(`public page exposed a "${forbidden}" control`)
      }
    }
    ok('no join / chat / edit affordances appear on the public page')

    if (errors.length) throw new Error(`Uncaught page error on the public page: ${errors[0]}`)
    ok('the public page raised no uncaught errors')
  } finally {
    await context.close()
  }
}

async function runPublicShareRevoked(browser) {
  console.log('\n▶ public share: a revoked / invalid token is a clean not-found')
  const context = await newContext(browser)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/p/${'b'.repeat(64)}`, { waitUntil: 'domcontentloaded' })
    // The RPC returned null → the honest "link isn’t available" state, never
    // partial data and never a crash.
    await page
      .getByText('This link isn’t available')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('an invalid token yields the "link isn’t available" state')
    if (await page.getByText('Flight to Lisbon').isVisible().catch(() => false)) {
      throw new Error('a revoked token still leaked itinerary content')
    }
    ok('no itinerary content leaks for an invalid token')
  } finally {
    await context.close()
  }
}

async function runPublicShareToggle(browser) {
  console.log('\n▶ public share: owner enables the link from Settings')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/settings`, { waitUntil: 'domcontentloaded' })
    // The owner-only "Public share link" card renders with its toggle.
    await page.getByText('Public share link').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the owner sees the Public share link card')

    const shareRpc = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/rpc/set_trip_share') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.getByRole('switch', { name: 'Read-only share link active' }).click()
    const req = await shareRpc
    if (req.postDataJSON()?.p_enabled !== true) {
      throw new Error('enabling the share did not call set_trip_share with p_enabled=true')
    }
    ok('toggling on calls set_trip_share to mint the token')
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
    await runJoinDeadLink(browser)
    await runJoinTransientError(browser)
    await runCreateTrip(browser)
    await runPlaceAutocomplete(browser)
    await runDuplicateTrip(browser)
    await runOffline(browser)
    await runSignOut(browser)
    await runTripPresence(browser)
    await runAvailabilityPoll(browser)
    await runBudget(browser)
    await runErrorReporting(browser)
    await runPublicShare(browser)
    await runPublicShareRevoked(browser)
    await runPublicShareToggle(browser)
    console.log(`\n✓ smoke: ${passed} assertions passed`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('\n✗ smoke test failed:', err)
  process.exit(1)
})
