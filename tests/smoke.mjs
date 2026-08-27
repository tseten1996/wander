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

// A just-joined friend (#291): an anonymous member session plus their own
// `members` row (role 'member'), so the trip context resolves `me` to a member
// — not the owner — and the first-visit orientation renders. Scoped to
// `runJoinWelcome` via `joinWelcomeScenario`, so the roster the other scenarios
// read stays untouched. FAR_FUTURE expiry keeps getSession() from refreshing
// (which the stub would answer with the owner session).
const MEMBER_USER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MEMBER_SESSION = session(MEMBER_USER_ID, { anonymous: true })
const JOINING_MEMBER = {
  id: 'ab111111-1111-4111-8111-111111111111',
  trip_id: TRIP_ID,
  user_id: MEMBER_USER_ID,
  display_name: 'Alex',
  color: '#7c3aed',
  role: 'member',
  joined_at: '2026-02-01T00:20:00Z',
}
let joinWelcomeScenario = false

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

// One checklist item assigned to the owner, not done, with a due date far in
// the past, so a *derived* time-based reminder (#195) always fires regardless
// of when the suite runs — proving the bell surfaces "due soon / overdue" with
// no persisted row behind it. Deliberately titled unlike NOTIFICATION_ROW so
// the two sections are unambiguous.
const OVERDUE_TASK_ROW = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  trip_id: TRIP_ID,
  title: 'Renew passport',
  notes: null,
  assignee_id: OWNER_MEMBER.id,
  due_date: '2020-01-01',
  done: false,
  position: 1,
  created_by: OWNER_MEMBER.id,
  created_at: '2026-02-02T00:00:00Z',
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
  // Three of the eight palette colours already in use (#234) — the join form
  // must default to one of the five that are free and dim these three.
  taken_colors: ['#0f766e', '#d97706', '#0e7490'],
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

// Public read-only post-trip recap share (#238, epic #205). The SAME share token
// dereferences to a whitelisted recap projection through get_public_recap once
// the trip has ended; a valid-but-not-ended link returns {status:'pending'}, and
// an invalid/revoked/not-shared token returns SQL null. The recap carries only
// aggregate counts + located stops — no costs, no member identity (mirrors #127).
const RECAP_PENDING_TOKEN = 'c'.repeat(64)
const PUBLIC_RECAP_READY = {
  status: 'ready',
  trip: {
    name: 'Lisbon in Spring',
    destination: 'Lisbon, Portugal',
    start_date: '2026-05-01',
    end_date: '2026-05-05',
  },
  stats: { stops: 4, travelers: 3 },
  // Two located stops (coords added in #248, slice 3) so the read-only recap map
  // renders its route; the whitelisted projection now carries latitude/longitude
  // for each already-named stop.
  places: [
    {
      id: 'it-1',
      title: 'Time out Market',
      category: 'restaurant',
      location: 'Cais do Sodré',
      latitude: 38.7067,
      longitude: -9.1459,
    },
    {
      id: 'it-2',
      title: 'Belém Tower',
      category: 'activity',
      location: 'Belém',
      latitude: 38.6916,
      longitude: -9.216,
    },
  ],
}
const PUBLIC_RECAP_PENDING = {
  status: 'pending',
  trip: {
    name: 'Lisbon in Spring',
    destination: 'Lisbon, Portugal',
    start_date: '2099-05-01',
    end_date: '2099-05-05',
  },
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

// Chat/messages scenario state (#214), scoped to `runChat` (set/reset there).
// A stateful message store, like `budgetEntries` above: a message the UI just
// POSTed survives the send mutation's invalidate → refetch and renders. The
// suite stubs the network entirely — no realtime socket — so this exercises the
// deterministic send/render path, exactly the coverage the suite gives every
// other surface. One seed message proves the surface reads from the route.
// A 1×1 transparent PNG the storage stub hands back for any object/signed-URL
// GET, so an image message's <img> resolves instead of erroring in the harness.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const CHAT_SEED_MESSAGE = {
  id: 'msg-seed-1',
  trip_id: TRIP_ID,
  member_id: OWNER_MEMBER.id,
  content: 'Kicking off the planning here 🎒',
  reply_to: null,
  pinned: false,
  edited_at: null,
  created_at: '2026-03-01T00:00:00Z',
  message_reactions: [],
}
let chatMessages = []

// Itinerary items (#225): a stateful store, like budgetEntries/chatMessages
// above, so an item the ItemDialog POSTs survives the create mutation's
// invalidate → refetch and renders in the day timeline. One seed item (dated +
// located) proves the surface reads from the /rest/v1/itinerary_items route;
// the scenario then adds a second through the real dialog. useItinerary reads
// `select('*').eq('trip_id',…).order('day').order('position')`; the create
// insert() takes no `.select()`, so the POST just stores the payload and 201s
// (return=minimal) — the store is what makes the refetch show the new row.
const ITINERARY_SEED_ITEM = {
  id: 'itin-seed-1',
  trip_id: TRIP_ID,
  title: 'Tram 28 through Alfama',
  category: 'activity',
  day: '2026-05-01',
  end_day: null,
  start_time: '10:00:00',
  end_time: '11:00:00',
  location: 'Alfama, Lisbon',
  latitude: 38.7139,
  longitude: -9.1224,
  url: null,
  notes: null,
  cost: null,
  budget_entry_id: null,
  position: 1,
  created_by: OWNER_MEMBER.id,
  created_at: '2026-03-01T00:00:00Z',
}
let itineraryItems = []

// Checklist items (#233): a stateful store, like budget_entries / messages /
// itinerary_items above, so a task the ItemDialog POSTs — and the assign/complete
// writes that follow — survive the mutation's invalidate → refetch and render.
// It is scoped to `runChecklist` via `checklistScenario`: only while that flag is
// set does the /rest/v1/checklist_items route become stateful. Every other
// scenario keeps the single read-only overdue row the reminders (#195) and
// dashboard read (OVERDUE_TASK_ROW) untouched. useChecklist reads
// `select('*').eq('trip_id',…).order('position').order('created_at')`; the create
// insert().select('id').single() wants one row with its id, and both updates
// (assign via useUpdateChecklistItem, complete via useToggleDone) are
// update(patch).eq('id',…) with no `.select()`.
const CHECKLIST_SEED_ITEM = {
  id: 'chk-seed-1',
  trip_id: TRIP_ID,
  title: 'Confirm the rental car',
  notes: null,
  assignee_id: null,
  due_date: null,
  done: false,
  position: 1,
  created_by: OWNER_MEMBER.id,
  created_at: '2026-03-01T00:00:00Z',
}
let checklistScenario = false
let checklistItems = []

// Regular polls (#239): a stateful vote store, like budget_entries / messages /
// itinerary_items / checklist_items above, so a vote PollsPage casts survives the
// mutation's invalidate → refetch and re-renders in the tally. Scoped to
// `runPolls` via `pollsScenario`: only while that flag is set does /rest/v1/polls
// return the seeded poll and /rest/v1/votes become a stateful store; every other
// scenario keeps the empty catch-all it reads today. Distinct from availability
// polls (#176), which runAvailabilityPoll covers via /rest/v1/availability_polls.
// usePolls reads `.from('polls').select('*, poll_options(*), votes(*)')
// .eq('trip_id',…).order('created_at',{ascending:false})`, so the poll embeds its
// options and votes; useVote upserts `{trip_id, poll_id, option_id, member_id}`
// to /rest/v1/votes (onConflict poll_id,member_id, no `.select()` → return=minimal)
// and deletes by id to unvote.
const POLL_OPTION_A = {
  id: 'popt-a',
  trip_id: TRIP_ID,
  poll_id: 'poll-seed-1',
  label: 'Alfama guesthouse',
  position: 0,
  image_url: null,
  link_url: null,
}
const POLL_OPTION_B = {
  id: 'popt-b',
  trip_id: TRIP_ID,
  poll_id: 'poll-seed-1',
  label: 'Baixa hotel',
  position: 1,
  image_url: null,
  link_url: null,
}
const POLL_SEED = {
  id: 'poll-seed-1',
  trip_id: TRIP_ID,
  created_by: OWNER_MEMBER.id,
  question: 'Where should we stay?',
  category: 'stay',
  closes_at: null,
  closed: false,
  created_at: '2026-03-01T00:00:00Z',
  poll_options: [POLL_OPTION_A, POLL_OPTION_B],
}
let pollsScenario = false
let pollVotes = []

// Packing items (#240): a stateful store, like budget_entries / messages /
// itinerary_items / checklist_items above, so an item the quick-add POSTs — and
// the packed-toggle PATCH that follows — survive the mutation's invalidate →
// refetch and render. Scoped to `runPacking` via `packingScenario`: only while
// that flag is set does /rest/v1/packing_items become a stateful store; every
// other scenario keeps the empty read the packing page's mount does today (the
// catch-all served [] before this route existed). usePacking reads
// `select('*').eq('trip_id',…).order('position').order('created_at')`; the create
// insert() takes no `.select()` (return=minimal → bare 201) and the packed toggle
// is `update({ packed }).eq('id',…)` with no `.select()` either.
const PACKING_SEED_ITEM = {
  id: 'pack-seed-1',
  trip_id: TRIP_ID,
  name: 'Passport',
  category: 'documents',
  packed: false,
  added_by: OWNER_MEMBER.id,
  position: 1,
  created_at: '2026-03-01T00:00:00Z',
}
let packingScenario = false
let packingItems = []

// Notes optimistic-concurrency (#272): a stateful store scoped to `runNotes`
// via `notesScenario`, so the guarded save can be exercised end to end. Only
// while that flag is set does /rest/v1/notes become stateful; every other
// scenario keeps the empty read the notes page's mount does today. useNotes
// reads `select('*').eq('trip_id',…).order('pinned').order('updated_at')`;
// useUpdateNote's guarded save is
// `update(patch).eq('id',…).eq('updated_at',opened).select()` — zero rows back
// means the note moved underneath, so it re-reads the row with
// `select('*').eq('id',…).single()` to offer a reload. The unguarded save
// (pin toggle / "keep mine") is `update(patch).eq('id',…)` with no `.select()`.
// The `notes_touch_updated_at` trigger bumps `updated_at` on every write; the
// stub mirrors that with a monotonic stamp so a second guarded save collides.
const NOTES_SEED_ITEM = {
  id: 'note-seed-1',
  trip_id: TRIP_ID,
  title: 'Restaurant shortlist',
  content: '- Ichiran ramen',
  pinned: false,
  created_by: OWNER_MEMBER.id,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
}
let notesScenario = false
let notesRows = []
let notesStampSeq = 0
// A monotonic UTC stamp standing in for the trigger's clock, so each write
// yields a strictly newer `updated_at` than the one the editor captured.
function nextNoteStamp() {
  notesStampSeq += 1
  const mm = String(notesStampSeq).padStart(2, '0')
  return `2026-03-01T01:${mm}:00Z`
}

// Questions (#273): a stateful store, like the other content stores above, so an
// asked question (POST) and the answer/reopen PATCHes survive the mutation's
// invalidate → refetch and render. Scoped to `runQuestions` via
// `questionsScenario`: only while that flag is set does /rest/v1/questions become
// stateful; every other scenario keeps the empty catch-all the questions page
// mounted against before this route existed. useQuestions reads
// `select('*').eq('trip_id',…).order('created_at',{ascending:false})`;
// useCreateQuestion's insert() has no `.select()` (return=minimal → bare 201), and
// useAnswerQuestion/useReopenQuestion are update(patch).eq('id',…) with none either.
const QUESTION_SEED_ITEM = {
  id: 'q-seed-1',
  trip_id: TRIP_ID,
  member_id: OWNER_MEMBER.id,
  title: 'Who is booking the Airbnb?',
  body: null,
  answered: false,
  answer: null,
  created_at: '2026-03-01T00:00:00Z',
}
let questionsScenario = false
let questionsRows = []

// Ideas / inspiration (#273): a stateful store, like the stores above, so a
// pinned idea (POST) survives the invalidate → refetch and renders on the board.
// Scoped to `runIdeas` via `inspirationScenario`: only while that flag is set does
// /rest/v1/inspiration_items become stateful; every other scenario keeps the empty
// catch-all the board mounted against before. useInspiration reads
// `select('*').eq('trip_id',…).order('created_at',{ascending:false})`;
// useCreateInspiration's insert() has no `.select()` (return=minimal → bare 201).
const INSPIRATION_SEED_ITEM = {
  id: 'idea-seed-1',
  trip_id: TRIP_ID,
  title: 'Rooftop bar in Bairro Alto',
  url: null,
  image_url: null,
  note: 'Great sunset views',
  category: 'food',
  created_by: OWNER_MEMBER.id,
  created_at: '2026-03-01T00:00:00Z',
}
let inspirationScenario = false
let inspirationRows = []

// Global search prefetch (#282): the ⌘K palette warms every section's cache
// when it opens, so a record is searchable on a page this session never
// visited. Scoped to `runSearch` via `searchScenario`: only while that flag is
// set do the itinerary_items and budget_entries reads return these two seeds,
// so every other scenario keeps its own itinerary/budget stores untouched. The
// itinerary seed is a plain single-day stop (so it renders with the
// `wander-item-<id>` anchor a deep-link scrolls to); the budget seed sits in the
// "food" category so a search for "Food" exercises the category-label match.
const ITINERARY_SEARCH_SEED = {
  id: 'itin-search-1',
  trip_id: TRIP_ID,
  title: 'Pastéis de Belém tasting',
  category: 'restaurant',
  day: '2026-05-02',
  end_day: null,
  start_time: '15:00:00',
  end_time: null,
  location: 'Belém, Lisbon',
  latitude: null,
  longitude: null,
  url: null,
  notes: null,
  cost: null,
  budget_entry_id: null,
  position: 1,
  created_by: OWNER_MEMBER.id,
  created_at: '2026-03-01T00:00:00Z',
}
const BUDGET_SEARCH_SEED = {
  id: 'be-search-1',
  trip_id: TRIP_ID,
  title: 'Dinner at Time Out Market',
  category: 'food',
  estimated: null,
  actual: 6000,
  currency: null,
  estimated_converted: null,
  actual_converted: null,
  exchange_rate: null,
  participants: null,
  shares: null,
  paid_by: null,
  entry_date: '2026-05-02',
  notes: null,
  created_by: OWNER_MEMBER.id,
  created_at: '2026-03-01T00:00:00Z',
}
let searchScenario = false

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
  // get_public_recap (#238) returns a ready recap for the ended-trip token, a
  // {status:'pending'} object for a valid-but-not-ended token, or SQL null for
  // an invalid/revoked/not-shared one — the three distinct page states.
  if (pathname.endsWith('/rest/v1/rpc/get_public_recap')) {
    if (body.p_token === SHARE_TOKEN) return json(PUBLIC_RECAP_READY)
    if (body.p_token === RECAP_PENDING_TOKEN) return json(PUBLIC_RECAP_PENDING)
    return json(null)
  }
  // set_trip_recap_share (#238) flips the owner-side recap opt-in and returns
  // void → an empty 204, exactly like a no-return RPC.
  if (pathname.endsWith('/rest/v1/rpc/set_trip_recap_share'))
    return route.fulfill({ status: 204, body: '' })
  // duplicate_trip (#80) copies a trip server-side and returns the new trip id
  // as a scalar text → a bare JSON string, exactly like join_trip.
  if (pathname.endsWith('/rest/v1/rpc/duplicate_trip')) return json(JSON.stringify(NEW_TRIP_ID))
  // apply_availability_dates (#176) writes the trip's dates owner-side and
  // returns void → an empty 204, exactly like a no-return RPC.
  if (pathname.endsWith('/rest/v1/rpc/apply_availability_dates'))
    return route.fulfill({ status: 204, body: '' })

  // ── Storage (chat images #51) ──
  // Signed-URL minting (createSignedUrls): POST { paths } → one row per path
  // with a relative signedURL the client prefixes with the storage host.
  if (pathname.startsWith('/storage/v1/object/sign/')) {
    if (method === 'POST') {
      const paths = Array.isArray(body.paths) ? body.paths : []
      return json(
        paths.map((p) => ({ error: null, path: p, signedURL: `/object/sign/chat-images/${p}?token=stub` }))
      )
    }
    // GET of a signed URL → a tiny PNG so the <img> actually resolves.
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: TINY_PNG,
    })
  }
  if (pathname.startsWith('/storage/v1/object/')) {
    // upload(): POST /storage/v1/object/chat-images/<path> → { Key }
    if (method === 'POST') return json({ Key: pathname.replace('/storage/v1/object/', '') }, 200)
    if (method === 'DELETE') return json({}) // remove() cleanup — unused in the happy path
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: TINY_PNG,
    })
  }

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
    // Trip page roster: the just-joined friend (owner + member) while the
    // welcome scenario runs; two members while the budget scenario runs, so
    // settle-up has someone to split with; one member everywhere else.
    if (search.includes('order=')) {
      if (joinWelcomeScenario) return json([OWNER_MEMBER, JOINING_MEMBER])
      return json(twoMembers ? [OWNER_MEMBER, SECOND_MEMBER] : [OWNER_MEMBER])
    }
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
    // Like itinerary_items above: during the search scenario the palette's
    // on-open prefetch reads this route with the budget page unvisited, so
    // return the one seed to prove prefetch coverage (#282).
    if (method === 'GET')
      return json(searchScenario ? [BUDGET_SEARCH_SEED] : [...budgetEntries].reverse())
    return json([]) // PATCH/DELETE unused by this scenario
  }

  // Chat messages (#214): a stateful store so a message the chat composer POSTs
  // survives the send mutation's invalidate → refetch and renders in the thread.
  // The GET embeds `message_reactions(*)`, so every row carries the array;
  // useSendMessage's insert().select('id').single() wants one row with its id.
  if (pathname.endsWith('/rest/v1/messages')) {
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = chatMessages.length + 1
      const row = {
        id: `msg-${n}`,
        pinned: false,
        edited_at: null,
        reply_to: null,
        created_at: `2026-03-01T00:10:0${n}Z`,
        ...payload,
        message_reactions: [],
      }
      chatMessages.push(row)
      return json({ id: row.id }, 201)
    }
    // Already in created_at-ascending order (seed first, then each send).
    if (method === 'GET') return json([...chatMessages])
    return json([]) // edit/delete/pin PATCH + DELETE unused by this scenario
  }

  // Itinerary items (#225): a stateful store, like budget_entries/messages
  // above, so an item the ItemDialog POSTs survives the create mutation's
  // invalidate → refetch and renders in the day timeline. useItinerary reads
  // `select('*').eq('trip_id',…).order('day').order('position')`; the create
  // insert() takes no `.select()`, so a bare 201 (return=minimal) is correct —
  // the store is what makes the refetch bring the new row back.
  if (pathname.endsWith('/rest/v1/itinerary_items')) {
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = itineraryItems.length + 1
      itineraryItems.push({
        id: `itin-${n}`,
        end_day: null,
        start_time: null,
        end_time: null,
        location: null,
        latitude: null,
        longitude: null,
        url: null,
        notes: null,
        cost: null,
        budget_entry_id: null,
        created_at: `2026-03-01T00:10:0${n}Z`,
        ...payload,
      })
      return route.fulfill({ status: 201, body: '' })
    }
    // While the search scenario runs, the palette's on-open prefetch reads this
    // route without the itinerary page ever mounting — return the one seed so a
    // match proves prefetch (#282), not navigation history.
    if (method === 'GET') return json(searchScenario ? [ITINERARY_SEARCH_SEED] : [...itineraryItems])
    return json([]) // reorder/edit PATCH + DELETE unused by this scenario
  }

  // Notification inbox (#182): the shell header bell reads the recipient's own
  // rows and marks them read (PATCH). The stub hands back one unread item.
  if (pathname.endsWith('/rest/v1/notifications')) {
    if (method === 'GET') return json([NOTIFICATION_ROW])
    return json([]) // PATCH mark-read / anything else
  }

  // Checklist items — two modes on one endpoint:
  //   • Default (every other scenario): the bell's reminder derivation (#195) and
  //     the dashboard's `select('id, done')` read one overdue task assigned to the
  //     owner — enough to surface a reminder deterministically. Writes are unused.
  //   • Checklist scenario (#233, `checklistScenario` set): a stateful store like
  //     budget_entries / messages / itinerary_items, so a created task and the
  //     assign/complete PATCHes that follow survive the invalidate → refetch and
  //     render. Scoped so the reminders/dashboard reads above stay untouched.
  if (pathname.endsWith('/rest/v1/checklist_items')) {
    if (!checklistScenario) {
      if (method === 'GET') return json([OVERDUE_TASK_ROW])
      return json([]) // insert/update/delete unused by those scenarios
    }
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = checklistItems.length + 1
      const row = {
        id: `chk-${n}`,
        notes: null,
        assignee_id: null,
        due_date: null,
        done: false,
        created_at: `2026-03-01T00:10:0${n}Z`,
        ...payload,
      }
      checklistItems.push(row)
      return json({ id: row.id }, 201) // insert().select('id').single()
    }
    if (method === 'PATCH') {
      // update(patch).eq('id', id): the target id rides in the query string, and
      // the patch (assignee_id from the edit, or done from the toggle) merges in.
      const id = decodeURIComponent((search.match(/id=eq\.([^&]+)/) ?? [])[1] ?? '')
      const patch = Array.isArray(body) ? body[0] : body
      const row = checklistItems.find((i) => i.id === id)
      if (row) Object.assign(row, patch)
      return json([]) // no `.select()` → return=minimal
    }
    if (method === 'GET') return json([...checklistItems])
    return json([]) // DELETE unused by this scenario
  }

  // Packing items — two modes on one endpoint:
  //   • Default (every other scenario): an empty read, exactly the catch-all
  //     behavior the packing route relied on before (so a lazily-mounted packing
  //     surface never errors). Writes are unused.
  //   • Packing scenario (#240, `packingScenario` set): a stateful store like
  //     budget_entries / messages / itinerary_items / checklist_items, so a
  //     quick-added item and the packed-toggle PATCH survive the invalidate →
  //     refetch and render. useAddPackingItem's insert() has no `.select()`
  //     (return=minimal → bare 201); useTogglePacked's update({ packed }).eq('id',…)
  //     has none either (return=minimal). Scoped so other scenarios stay empty.
  if (pathname.endsWith('/rest/v1/packing_items')) {
    if (!packingScenario) {
      if (method === 'GET') return json([])
      return json([]) // insert/update/delete unused by those scenarios
    }
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = packingItems.length + 1
      packingItems.push({
        id: `pack-${n}`,
        packed: false,
        added_by: null,
        created_at: `2026-03-01T00:10:0${n}Z`,
        ...payload,
      })
      return route.fulfill({ status: 201, body: '' })
    }
    if (method === 'PATCH') {
      // update({ packed }).eq('id', id): the target id rides in the query string,
      // and the patch (packed from the toggle) merges into the stored row so the
      // refetch keeps it in its new state.
      const id = decodeURIComponent((search.match(/id=eq\.([^&]+)/) ?? [])[1] ?? '')
      const patch = Array.isArray(body) ? body[0] : body
      const row = packingItems.find((i) => i.id === id)
      if (row) Object.assign(row, patch)
      return json([]) // no `.select()` → return=minimal
    }
    if (method === 'GET') return json([...packingItems])
    return json([]) // DELETE unused by this scenario
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

  // Regular polls (#239): two modes on the /rest/v1/polls + /rest/v1/votes routes.
  //   • Default (every other scenario): no poll exists — the empty list, matching
  //     today's catch-all behavior (no scenario reads polls).
  //   • Polls scenario (`pollsScenario` set): /rest/v1/polls returns the seeded
  //     poll with its options and the live votes embedded, and /rest/v1/votes is a
  //     stateful store so a cast vote survives invalidate → refetch and re-renders
  //     the tally. (`/rest/v1/availability_polls` is matched earlier, so its path
  //     never falls through to here.)
  if (pathname.endsWith('/rest/v1/polls')) {
    if (pollsScenario && method === 'GET') return json([{ ...POLL_SEED, votes: [...pollVotes] }])
    return json([]) // no polls outside the scenario; writes go through /rest/v1/votes
  }
  if (pathname.endsWith('/rest/v1/votes')) {
    if (!pollsScenario) return json([])
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      // Upsert on (poll_id, member_id): a member's prior vote is replaced, never
      // duplicated — the unique constraint the real votes table carries, so
      // switching options re-tallies rather than double-counting.
      pollVotes = pollVotes.filter(
        (v) => !(v.poll_id === payload.poll_id && v.member_id === payload.member_id)
      )
      const n = pollVotes.length + 1
      pollVotes.push({ id: `vote-${n}`, created_at: `2026-03-01T00:20:0${n}Z`, ...payload })
      return route.fulfill({ status: 201, body: '' }) // upsert without .select() → return=minimal
    }
    if (method === 'DELETE') {
      // tap-again-to-unvote: delete().eq('id', existing.id) — the id rides in the
      // query string, and the refetch returns the tally to its prior state.
      const id = decodeURIComponent((search.match(/id=eq\.([^&]+)/) ?? [])[1] ?? '')
      pollVotes = pollVotes.filter((v) => v.id !== id)
      return route.fulfill({ status: 204, body: '' })
    }
    if (method === 'GET') return json([...pollVotes])
    return json([])
  }

  // Notes (#272): two modes on /rest/v1/notes.
  //   • Default (every other scenario): an empty read, matching the catch-all
  //     behavior the notes page relied on before this route existed.
  //   • Notes scenario (`notesScenario` set): a stateful store so the guarded
  //     save's optimistic-concurrency check can be exercised. A GET with an
  //     `order=` clause is the list read; a GET without it is the post-conflict
  //     `.single()` re-read of one row. A PATCH carrying an `updated_at=eq.`
  //     filter is the guarded save — it matches only while the stored stamp is
  //     unchanged, and returns [] (zero rows → conflict) once it has moved. A
  //     PATCH without that filter is the unguarded "keep mine" overwrite.
  if (pathname.endsWith('/rest/v1/notes')) {
    if (!notesScenario) return json([])
    if (method === 'POST') {
      // Create (#273): useCreateNote's insert().select().single() wants one full
      // row back, so the create mutation's invalidate → refetch lists the new
      // note. A monotonic stamp matches the trigger's clock like the guarded save.
      const payload = Array.isArray(body) ? body[0] : body
      const n = notesRows.length + 1
      const stamp = nextNoteStamp()
      const row = { id: `note-${n}`, pinned: false, created_at: stamp, updated_at: stamp, ...payload }
      notesRows.push(row)
      return json(row) // `.select().single()` → a bare object
    }
    if (method === 'GET') {
      if (search.includes('order=')) return json([...notesRows]) // list read
      // Post-conflict re-read: `.eq('id',…).single()` → a bare object.
      const id = decodeURIComponent((search.match(/id=eq\.([^&]+)/) ?? [])[1] ?? '')
      return json(notesRows.find((n) => n.id === id) ?? null)
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent((search.match(/id=eq\.([^&]+)/) ?? [])[1] ?? '')
      const patch = Array.isArray(body) ? body[0] : body
      const row = notesRows.find((n) => n.id === id)
      const guard = search.match(/updated_at=eq\.([^&]+)/)
      if (guard) {
        const opened = decodeURIComponent(guard[1])
        // Guarded save: only the editor that opened at the current version wins.
        if (!row || row.updated_at !== opened) return json([]) // zero rows → conflict
        Object.assign(row, patch, { updated_at: nextNoteStamp() })
        return json([row]) // `.select()` → representation
      }
      // Unguarded save ("keep mine" overwrite): last write wins, no version gate.
      if (row) Object.assign(row, patch, { updated_at: nextNoteStamp() })
      return route.fulfill({ status: 204, body: '' }) // no `.select()` → return=minimal
    }
    return json([]) // insert/delete unused by this scenario
  }

  // Questions (#273): two modes on /rest/v1/questions.
  //   • Default (every other scenario): an empty read, matching the catch-all
  //     behavior the questions page mounted against before this route existed.
  //   • Questions scenario (`questionsScenario` set): a stateful store so an asked
  //     question (POST) and the answer/reopen PATCHes survive the invalidate →
  //     refetch and render. Newest-first on GET, mirroring the real descending
  //     `order('created_at')`.
  if (pathname.endsWith('/rest/v1/questions')) {
    if (!questionsScenario) return json([])
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = questionsRows.length + 1
      questionsRows.push({
        id: `q-${n}`,
        body: null,
        answered: false,
        answer: null,
        created_at: `2026-03-01T00:10:0${n}Z`,
        ...payload,
      })
      return route.fulfill({ status: 201, body: '' }) // insert() has no `.select()`
    }
    if (method === 'PATCH') {
      // update(patch).eq('id', id): answer sets {answered:true, answer}, reopen
      // sets {answered:false}. The id rides in the query string; the patch merges.
      const id = decodeURIComponent((search.match(/id=eq\.([^&]+)/) ?? [])[1] ?? '')
      const patch = Array.isArray(body) ? body[0] : body
      const row = questionsRows.find((q) => q.id === id)
      if (row) Object.assign(row, patch)
      return json([]) // no `.select()` → return=minimal
    }
    if (method === 'GET') return json([...questionsRows].reverse())
    return json([]) // DELETE unused by this scenario
  }

  // Ideas / inspiration (#273): two modes on /rest/v1/inspiration_items.
  //   • Default (every other scenario): an empty read, matching the catch-all
  //     behavior the board mounted against before this route existed.
  //   • Ideas scenario (`inspirationScenario` set): a stateful store so a pinned
  //     idea (POST) survives the invalidate → refetch and renders. Newest-first on
  //     GET, mirroring the real descending `order('created_at')`.
  if (pathname.endsWith('/rest/v1/inspiration_items')) {
    if (!inspirationScenario) return json([])
    if (method === 'POST') {
      const payload = Array.isArray(body) ? body[0] : body
      const n = inspirationRows.length + 1
      inspirationRows.push({
        id: `idea-${n}`,
        title: null,
        url: null,
        image_url: null,
        note: null,
        created_at: `2026-03-01T00:10:0${n}Z`,
        ...payload,
      })
      return route.fulfill({ status: 201, body: '' }) // insert() has no `.select()`
    }
    if (method === 'GET') return json([...inspirationRows].reverse())
    return json([]) // DELETE unused by this scenario
  }

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
  // Count the first-touch RPCs (#215). A new friend's very first open must
  // issue exactly one join_trip probe and one get_invite_preview — not the
  // 2–4× it used to, when the auth-effect re-ran on the anonymous sign-in and
  // the preview builder was consumed twice. Count only real POSTs (not the
  // CORS OPTIONS preflight), up to the moment the name form appears; the
  // deliberate second join_trip (submitting the name) happens after that.
  let firstJoinProbes = 0
  let firstPreviewFetches = 0
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    const u = req.url()
    if (u.includes('/rest/v1/rpc/join_trip')) firstJoinProbes += 1
    else if (u.includes('/rest/v1/rpc/get_invite_preview')) firstPreviewFetches += 1
  })
  try {
    await page.goto(`${BASE_URL}/#/join/lisbon2026`, { waitUntil: 'domcontentloaded' })
    // Anonymous session + NAME_REQUIRED + preview all resolved → the form shows.
    await page.getByText('Lisbon in Spring').waitFor({ state: 'visible', timeout: 10_000 })
    ok('invite preview renders after the anonymous session is created')

    // Wait for the name form itself, not a fixed delay: the "Your name" input
    // only mounts once the join_trip probe has resolved NAME_REQUIRED (the
    // 'checking' preview card can paint while that probe is still in flight),
    // so this deterministically settles past the anonymous sign-in that used to
    // re-fire the effect. Then assert the first-touch call count is exactly one
    // each — the acceptance criterion for #215. Checked before the name is
    // submitted so the legitimate join POST below is never counted.
    await page.getByPlaceholder('Your name').waitFor({ state: 'visible', timeout: 10_000 })
    if (firstJoinProbes !== 1) {
      throw new Error(`first-time join fired join_trip ${firstJoinProbes}× (expected exactly 1)`)
    }
    if (firstPreviewFetches !== 1) {
      throw new Error(
        `first-time join fired get_invite_preview ${firstPreviewFetches}× (expected exactly 1)`
      )
    }
    ok('a first-time join issues exactly one join_trip probe and one preview request')

    // #234: the form defaults to a colour no member has taken, and flags the
    // taken swatches so a manual pick is informed. INVITE_PREVIEW reports three
    // taken colours, so the pre-selected swatch must be one of the five free
    // ones (never a taken one), and exactly those three must be flagged. Poll
    // for the default, since the "pick a free colour" effect lands just after
    // the form mounts.
    await page.waitForFunction(
      () => {
        const btn = document.querySelector(
          'button[aria-pressed="true"][aria-label^="Choose color"]'
        )
        return !!btn && !btn.getAttribute('aria-label').includes('already taken')
      },
      { timeout: 10_000 }
    )
    ok('the join form defaults to a colour no member has taken (#234)')
    const takenSwatches = await page.locator('button[aria-label*="already taken"]').count()
    if (takenSwatches !== 3) {
      throw new Error(`expected 3 taken swatches flagged, saw ${takenSwatches}`)
    }
    ok('taken swatches are flagged in the colour picker (#234)')

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

    // #289: the owner's welcome colour picker now carries the same 44px tap
    // target and aria-pressed state as the friend-facing picker (#135). Exactly
    // one swatch is pre-selected (the owner's member colour), and each hit
    // target clears the 44px mobile floor.
    const ownerSwatches = page.locator('button[aria-label^="Choose color"]')
    await ownerSwatches.first().waitFor({ state: 'visible', timeout: 10_000 })
    const pressed = await page
      .locator('button[aria-pressed="true"][aria-label^="Choose color"]')
      .count()
    if (pressed !== 1) {
      throw new Error(`expected exactly one pre-selected owner colour swatch, saw ${pressed}`)
    }
    ok('the owner colour picker marks the selected swatch with aria-pressed (#289)')

    const swatchBox = await ownerSwatches.first().boundingBox()
    if (!swatchBox || swatchBox.width < 44 || swatchBox.height < 44) {
      throw new Error(
        `owner colour swatch below the 44px tap floor: ${swatchBox?.width}×${swatchBox?.height}`
      )
    }
    ok('each owner colour swatch clears the 44px mobile tap floor (#289)')
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

    // Personal notification inbox (#182) + derived reminders (#195): the header
    // bell's badge reflects both unread notifications and live reminders, and
    // the dropdown lists each in its own section with a deep link.
    const bell = page.getByRole('button', { name: /Notifications/ }).first()
    await bell.waitFor({ state: 'visible', timeout: 10_000 })
    if (!/\d+ need attention/.test((await bell.getAttribute('aria-label')) ?? '')) {
      throw new Error('notification bell did not reflect the attention count')
    }
    ok('the header notification bell shows an attention badge')

    await bell.click()
    await page.getByText('Book flights').waitFor({ state: 'visible', timeout: 10_000 })
    ok('opening the inbox lists the notification')

    // The overdue checklist item surfaces as a derived reminder — never a
    // persisted notification — under its own "Reminders" heading (#195).
    await page.getByText('Reminders').first().waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Renew passport').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText(/Overdue by/).waitFor({ state: 'visible', timeout: 10_000 })
    ok('a time-based reminder shows in its own section, distinct from notifications')
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

/*
  Chat / messages surface (#214).

  Chat is Wander's flagship collaboration surface — the wedge against the
  400-message group chat — and the most-used screen in a live trip, yet it had
  no smoke coverage and the harness had no `/rest/v1/messages` route, so it
  could regress silently through any merge. This drives the real ChatPage
  end-to-end against the stubbed Supabase: a seeded message proves the surface
  reads from the route, then a send exercises the composer → POST → invalidate →
  refetch path and asserts the new message renders. No realtime socket is
  involved (the suite is hermetic); this is the deterministic network path the
  rest of the suite covers.
*/
async function runChat(browser) {
  console.log('\n▶ chat (messages surface renders + a sent message appears)')
  chatMessages = [{ ...CHAT_SEED_MESSAGE }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/chat`, { waitUntil: 'domcontentloaded' })

    // The heading plus the seeded message prove the surface renders from the
    // /rest/v1/messages route (not just an empty "say hi" state).
    await page.getByRole('heading', { name: 'Chat' }).waitFor({ state: 'visible', timeout: 10_000 })
    await page
      .getByText('Kicking off the planning here 🎒')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('the chat surface renders a message from the messages route')

    // Sending: the composer POSTs to /rest/v1/messages; the stateful store lets
    // the send's invalidate → refetch bring the new row back so it renders.
    const sent = 'Booking the hostel tonight'
    const sendPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/messages') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    const composer = page.getByPlaceholder('Message the group…')
    await composer.fill(sent)
    await page.getByRole('button', { name: 'Send message' }).click()

    // The POST carries the trip id, the sender's member id, and the typed text.
    const payload = (await sendPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.member_id !== OWNER_MEMBER.id ||
      payload?.content !== sent
    ) {
      throw new Error(`send POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('sending posts the message with trip, sender, and content')

    // After the refetch the new message renders in the thread, and the composer
    // has cleared — the send round-tripped end to end.
    await page.getByText(sent).waitFor({ state: 'visible', timeout: 10_000 })
    ok('a sent message appears in the thread')
    if ((await composer.inputValue()) !== '') {
      throw new Error('composer did not clear after a successful send')
    }
    ok('the composer clears after a successful send')

    // Image message (#51): attach a PNG through the composer's file input, send,
    // and prove it round-trips — the POST references a path in the trip's folder
    // (what the Storage RLS scopes on), and the image renders + opens a lightbox.
    const imagePost = page.waitForRequest(
      (req) =>
        req.url().includes('/rest/v1/messages') &&
        req.method() === 'POST' &&
        !!req.postDataJSON()?.image_path,
      { timeout: 10_000 }
    )
    await page.setInputFiles('input[type="file"]', {
      name: 'lisbon.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    })
    // The attachment chip shows the picked file and enables the send.
    await page.getByText('lisbon.png').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByRole('button', { name: 'Send message' }).click()

    const imgPayload = (await imagePost).postDataJSON()
    if (!String(imgPayload.image_path).startsWith(`${TRIP_ID}/`)) {
      throw new Error(`image message path not scoped to the trip folder: ${imgPayload.image_path}`)
    }
    ok('sending an image posts a message whose path is scoped to the trip folder')

    // After the refetch, the image renders (its signed URL resolved by the app).
    const chatImage = page.getByRole('img', { name: 'Shared in chat' })
    await chatImage.waitFor({ state: 'visible', timeout: 10_000 })
    ok('a sent image renders in the thread')

    // Clicking it opens the full-screen lightbox; Escape closes it.
    await page.getByRole('button', { name: 'Open image' }).click()
    const lightbox = page.getByRole('dialog', { name: 'Image preview' })
    await lightbox.waitFor({ state: 'visible', timeout: 10_000 })
    ok('clicking a chat image opens the lightbox')
    await page.keyboard.press('Escape')
    await lightbox.waitFor({ state: 'hidden', timeout: 10_000 })
    ok('the lightbox closes on Escape')

    if (errors.length) throw new Error(`Uncaught page error on the chat page: ${errors[0]}`)
    ok('the chat flow raised no uncaught errors')
  } finally {
    chatMessages = []
    await context.close()
  }
}

/*
  Itinerary surface (#225).

  The itinerary is Wander's most-used planning surface — add/edit/reorder items,
  the per-day timeline, map pins — yet it had no smoke coverage and the harness
  had no /rest/v1/itinerary_items route, so a broken render, a mis-grouped day,
  or an item that never saves could reach `main` with nothing catching it. It
  has churned heavily lately (destinations/legs #199, multi-day #192,
  geocode-on-save #202, day directions #168), which is exactly why it needs a
  gate. This drives the real ItineraryPage + ItemDialog end-to-end against the
  stubbed Supabase: a seeded item proves the surface reads from the route, then
  adding one through the dialog exercises the composer → POST → invalidate →
  refetch path and asserts the new item renders. It stays on the deterministic,
  network-stubbed List path the rest of the suite uses — no Leaflet map tiles or
  realtime socket — and adds a location-free item so the hermetic save never
  reaches the geocoder (a located save geocodes the address on submit).
*/
async function runItinerary(browser) {
  console.log('\n▶ itinerary (timeline renders + an added item appears)')
  itineraryItems = [{ ...ITINERARY_SEED_ITEM }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/itinerary`, { waitUntil: 'domcontentloaded' })

    // The page heading plus the seeded item prove the surface renders from the
    // /rest/v1/itinerary_items route (the populated list, not the empty state).
    await page
      .getByRole('heading', { name: 'Itinerary' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Tram 28 through Alfama').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the itinerary surface renders an item from the itinerary_items route')

    // Adding: the header "Add item" opens the shared ItemDialog; the create
    // POSTs to /rest/v1/itinerary_items and the stateful store lets the
    // invalidate → refetch bring the new row back so it renders in the timeline.
    const added = 'Sunset kayak in the marina'
    const createPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/itinerary_items') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    // Only the header button exists before the dialog opens; scope the submit to
    // the dialog below, since it shares the "Add item" name with this trigger.
    await page.getByRole('button', { name: 'Add item' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#it-title').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the add-item dialog opens')

    await dialog.locator('#it-title').fill(added)
    await dialog.getByRole('button', { name: 'Add item' }).click()

    // The POST carries the trip id, the creator's member id, the typed title, and
    // the default category — the itinerary write's payload shape (#225 floor).
    const payload = (await createPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.created_by !== OWNER_MEMBER.id ||
      payload?.title !== added ||
      payload?.category !== 'activity'
    ) {
      throw new Error(`itinerary POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('adding posts an itinerary item with trip, creator, title, and category')

    // After the refetch the new item renders in the timeline, and the dialog has
    // closed — the create round-tripped end to end. The location-free item lands
    // in the "Not scheduled yet" bucket (no day), which is enough to prove it saved.
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.getByText(added).waitFor({ state: 'visible', timeout: 10_000 })
    ok('an added itinerary item appears in the timeline')

    if (errors.length) throw new Error(`Uncaught page error on the itinerary page: ${errors[0]}`)
    ok('the itinerary flow raised no uncaught errors')
  } finally {
    itineraryItems = []
    await context.close()
  }
}

/*
  Checklist surface (#233).

  The checklist — assign, complete, reorder shared to-dos — is a core
  collaboration surface, and the source of the derived "due soon / overdue"
  reminders the notification-bell scenario already asserts, yet it had no smoke
  coverage and the harness served only a single read-only /rest/v1/checklist_items
  row. A regression in checklist create/assign/complete could silently break both
  the checklist and those reminders before `main`. This drives the real
  ChecklistPage + ItemDialog end-to-end against the stubbed Supabase: a seeded
  task proves the surface reads from the route, then adding one through the dialog
  (assigned to the owner) exercises the create POST, and ticking it exercises the
  complete PATCH — asserting each payload shape and each rendered state. It stays
  on the deterministic, network-stubbed path the rest of the suite uses.
*/
async function runChecklist(browser) {
  console.log('\n▶ checklist (add a task, assign it, complete it)')
  checklistScenario = true
  checklistItems = [{ ...CHECKLIST_SEED_ITEM }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/checklist`, { waitUntil: 'domcontentloaded' })

    // The heading plus the seeded task prove the surface renders from the
    // /rest/v1/checklist_items route (the populated list, not the starter offer).
    await page
      .getByRole('heading', { name: 'Checklist' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Confirm the rental car').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the checklist surface renders a task from the checklist_items route')

    // Adding: "New task" opens the ItemDialog; the create POSTs to
    // /rest/v1/checklist_items and the stateful store lets the invalidate →
    // refetch bring the new row back so it renders in the list.
    const added = 'Reserve the airport lounge'
    const createPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/checklist_items') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'New task' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#task-title').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the new-task dialog opens')

    await dialog.locator('#task-title').fill(added)
    // Assign it to the owner through the "Assign to" select (the dialog's only
    // combobox), so the create carries an assignee — the collaboration floor.
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'planner', exact: true }).click()
    await dialog.getByRole('button', { name: 'Add task' }).click()

    // The POST carries the trip id, the creator's member id, the typed title, and
    // the chosen assignee — the checklist write's payload shape (#233 floor).
    const payload = (await createPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.created_by !== OWNER_MEMBER.id ||
      payload?.title !== added ||
      payload?.assignee_id !== OWNER_MEMBER.id
    ) {
      throw new Error(`checklist POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('adding posts a checklist item with trip, creator, title, and assignee')

    // After the refetch the new task renders; the dialog has closed, so the
    // create round-tripped end to end.
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.getByText(added).waitFor({ state: 'visible', timeout: 10_000 })
    // Its assignee avatar renders on the task's own row (MemberAvatar sets
    // title={name}); scope to the row so the roster's avatars elsewhere on the
    // page don't count toward the assertion.
    const addedRow = page.getByRole('checkbox', { name: `Mark "${added}" done` }).locator('..')
    if ((await addedRow.getByTitle('planner').count()) === 0) {
      throw new Error('the assigned task did not render its assignee avatar')
    }
    ok('an added task renders with its assignee')

    // Completing: ticking the checkbox PATCHes done:true (useToggleDone); the
    // optimistic flip plus the refetch leave it rendered in its done state.
    const donePatch = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/checklist_items') && req.method() === 'PATCH',
      { timeout: 10_000 }
    )
    await page.getByRole('checkbox', { name: `Mark "${added}" done` }).click()
    const donePayload = (await donePatch).postDataJSON()
    if (donePayload?.done !== true) {
      throw new Error(`checklist complete PATCH payload wrong: ${JSON.stringify(donePayload)}`)
    }
    ok('completing a task PATCHes done:true')

    // The row now reads as done — its checkbox aria-label flips to "not done",
    // which only renders once the toggle has taken effect.
    await page
      .getByRole('checkbox', { name: `Mark "${added}" not done` })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a completed task renders in its done state')

    if (errors.length) throw new Error(`Uncaught page error on the checklist page: ${errors[0]}`)
    ok('the checklist flow raised no uncaught errors')
  } finally {
    checklistScenario = false
    checklistItems = []
    await context.close()
  }
}

/*
  Packing surface (#240).

  The packing list — the shared "so nobody forgets the adapter" surface every
  traveler builds before a trip — is backed by `packing_items` and rendered by
  PackingPage, yet had no smoke coverage: the harness served only an empty
  read-only /rest/v1/packing_items. A regression in the add write or the
  packed-toggle (or the per-category progress they feed) could reach `main`
  unnoticed. This drives the real PackingPage end to end against the stubbed
  Supabase: a seeded item proves the surface reads from the route, quick-adding
  one exercises the create POST (asserting its payload shape), and ticking it
  exercises the packed PATCH — asserting the toggle payload and the rendered
  state flip. It stays on the deterministic, network-stubbed path the rest of the
  suite uses; the weather-nudge render (which reads the shared forecast) is out
  of the floor and degrades to nothing without a forecast, so it never blocks.
*/
async function runPacking(browser) {
  console.log('\n▶ packing (add an item, toggle it packed)')
  packingScenario = true
  packingItems = [{ ...PACKING_SEED_ITEM }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/packing`, { waitUntil: 'domcontentloaded' })

    // The heading plus the seeded item prove the surface renders from the
    // /rest/v1/packing_items route (not an empty list).
    await page
      .getByRole('heading', { name: 'Packing' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Passport').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the packing surface renders an item from the packing_items route')

    // Adding: the Clothes category's quick-add input takes a name; submitting the
    // form POSTs to /rest/v1/packing_items and the stateful store lets the
    // invalidate → refetch bring the new row back so it renders in that section.
    const added = 'Rain jacket'
    const createPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/packing_items') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    const clothesInput = page.getByPlaceholder(/Add to clothes/i)
    await clothesInput.waitFor({ state: 'visible', timeout: 10_000 })
    await clothesInput.fill(added)
    await clothesInput.press('Enter')

    // The POST carries the trip id, the adder's member id, the typed name, and the
    // chosen category — the packing write's payload shape (#240 floor).
    const payload = (await createPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.added_by !== OWNER_MEMBER.id ||
      payload?.name !== added ||
      payload?.category !== 'clothes'
    ) {
      throw new Error(`packing POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('adding posts a packing item with trip, adder, name, and category')

    // After the refetch the new item renders in an unpacked state — its checkbox
    // offers to mark it packed.
    const packBox = page.getByRole('checkbox', { name: `Mark ${added} packed` })
    await packBox.waitFor({ state: 'visible', timeout: 10_000 })
    ok('an added item renders in its unpacked state')

    // Toggling: ticking the checkbox PATCHes packed:true (useTogglePacked); the
    // optimistic flip plus the refetch leave it rendered in its packed state.
    const packedPatch = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/packing_items') && req.method() === 'PATCH',
      { timeout: 10_000 }
    )
    await packBox.click()
    const patchPayload = (await packedPatch).postDataJSON()
    if (patchPayload?.packed !== true) {
      throw new Error(`packing toggle PATCH payload wrong: ${JSON.stringify(patchPayload)}`)
    }
    ok('toggling an item PATCHes packed:true')

    // The row now reads as packed — its checkbox aria-label flips to "unpacked",
    // which only renders once the toggle has taken effect.
    await page
      .getByRole('checkbox', { name: `Mark ${added} unpacked` })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a packed item renders in its packed state')

    if (errors.length) throw new Error(`Uncaught page error on the packing page: ${errors[0]}`)
    ok('the packing flow raised no uncaught errors')
  } finally {
    packingScenario = false
    packingItems = []
    await context.close()
  }
}

/*
  Polls surface (#239).

  Regular polls — the group-decision primitive where friends actually agree on
  what to do — are backed by the `polls`/`poll_options`/`votes` tables and
  rendered by PollsPage, yet had no smoke coverage and the harness had no writable
  /rest/v1/votes route. A regression in the vote write, the one-vote-per-member /
  tap-again-to-unvote toggle, or the live tally render could reach `main` with no
  gate catching it. (Distinct from availability polls, which runAvailabilityPoll
  already covers.) This drives the real PollsPage end to end against the stubbed
  Supabase: a seeded two-option poll proves the surface reads from /rest/v1/polls,
  casting a vote exercises the upsert POST (asserting its payload shape) and the
  refetch proves the tally re-renders, and tapping the same option again exercises
  the unvote DELETE. It stays on the deterministic, network-stubbed path the rest
  of the suite uses — no realtime socket.
*/
async function runPolls(browser) {
  console.log('\n▶ polls (cast a vote, see the tally, tap again to unvote)')
  pollsScenario = true
  pollVotes = []
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/polls`, { waitUntil: 'domcontentloaded' })

    // The heading plus the seeded question prove the surface renders from the
    // /rest/v1/polls route (the populated list, not the empty state).
    await page.getByRole('heading', { name: 'Polls' }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Where should we stay?').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the polls surface renders a poll from the polls route')

    // No vote yet: the chosen option shows a 0 tally (scoped to its own button so
    // the card's "0 votes" subtitle doesn't count) and the card prompts to vote.
    const optionA = page.locator('button', { hasText: 'Alfama guesthouse' })
    await optionA.getByText('0', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Tap an option to vote.').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the poll renders with an empty tally before voting')

    // Casting: tapping an option upserts a vote to /rest/v1/votes; the stateful
    // store lets the invalidate → refetch bring it back so the tally re-renders.
    const votePost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/votes') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await optionA.click()

    // The POST carries the trip id, the poll id, the chosen option, and the
    // voter's member id — the vote write's payload shape (the #239 floor). The
    // column is `option_id` (the issue's prose says poll_option_id, but both the
    // schema in src/types and useVote use option_id).
    const raw = (await votePost).postDataJSON()
    const vote = Array.isArray(raw) ? raw[0] : raw
    if (
      vote?.trip_id !== TRIP_ID ||
      vote?.poll_id !== POLL_SEED.id ||
      vote?.option_id !== POLL_OPTION_A.id ||
      vote?.member_id !== OWNER_MEMBER.id
    ) {
      throw new Error(`vote POST payload wrong: ${JSON.stringify(raw)}`)
    }
    ok('casting a vote posts trip, poll, option, and voter member id')

    // After the refetch the tally re-renders: the chosen option counts 1 and the
    // card flips to the "tap again to remove" prompt (myVote is now set).
    await optionA.getByText('1', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await page
      .getByText('Tap your choice again to remove your vote.')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a cast vote appears in the tally and marks the poll as voted')

    // Tapping the same option again removes the vote: delete().eq('id', …) → a
    // DELETE to /rest/v1/votes, and the refetch returns the tally to empty.
    const voteDelete = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/votes') && req.method() === 'DELETE',
      { timeout: 10_000 }
    )
    await optionA.click()
    await voteDelete
    ok('tapping the voted option again issues the unvote DELETE')

    await optionA.getByText('0', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Tap an option to vote.').waitFor({ state: 'visible', timeout: 10_000 })
    ok('unvoting returns the tally to empty')

    if (errors.length) throw new Error(`Uncaught page error on the polls page: ${errors[0]}`)
    ok('the polls flow raised no uncaught errors')
  } finally {
    pollsScenario = false
    pollVotes = []
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

  // The client bounds how many reports it fires per tab session, and the bound
  // survives a reload (persisted in sessionStorage) so a crash-loop that reloads
  // the page can't reset the budget and keep hammering. This is the client half
  // of #170's defense-in-depth; the DB trigger is the real boundary.
  const capContext = await newContext(browser, OWNER_SESSION)
  const capPage = await capContext.newPage()
  try {
    let inserts = 0
    capPage.on('request', (req) => {
      if (req.url().includes('/rest/v1/error_reports') && req.method() === 'POST') {
        inserts += 1
      }
    })

    await capPage.goto(`${BASE_URL}/#/`, { waitUntil: 'domcontentloaded' })
    await capPage.getByRole('button', { name: 'New trip' }).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    })

    // Fire well past the per-session cap with distinct messages (so dedup never
    // masks the cap). Only the cap should limit how many requests go out.
    await capPage.evaluate(() => {
      for (let i = 0; i < 30; i += 1) {
        window.dispatchEvent(
          new ErrorEvent('error', {
            message: `cap-boom-${i}`,
            error: new Error(`cap-boom-${i}`),
          })
        )
      }
    })
    // Let the fire-and-forget inserts flush.
    await capPage.waitForTimeout(1_000)
    // Exactly the cap: 30 distinct messages fired, so a correct cap sends 20 and
    // no more. Asserting the exact value (not just <=20) catches a regression
    // that clamped reports to 1 — which a <=20 bound would silently pass.
    if (inserts !== 20) {
      throw new Error(`expected the per-session cap to send exactly 20 reports, saw ${inserts}`)
    }
    ok('the per-session cap bounds how many reports are sent (exactly 20)')

    // Reload: the in-memory counter resets but sessionStorage remembers the cap,
    // so a reload-loop gets no fresh budget.
    const before = inserts
    await capPage.reload({ waitUntil: 'domcontentloaded' })
    await capPage.getByRole('button', { name: 'New trip' }).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    await capPage.evaluate(() => {
      for (let i = 0; i < 5; i += 1) {
        window.dispatchEvent(
          new ErrorEvent('error', {
            message: `post-reload-boom-${i}`,
            error: new Error(`post-reload-boom-${i}`),
          })
        )
      }
    })
    await capPage.waitForTimeout(1_000)
    if (inserts !== before) {
      throw new Error(`the cap should persist across a reload, but ${inserts - before} more reports fired`)
    }
    ok('the per-session cap persists across a reload')
  } finally {
    await capContext.close()
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

async function runPublicRecap(browser) {
  console.log('\n▶ public recap (read-only post-trip recap for someone with no account)')
  // No initSession: an outsider with no Wander session must reach the page
  // through the token alone — the whole point of the public-read surface.
  const context = await newContext(browser)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/r/${SHARE_TOKEN}`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('heading', { name: 'Lisbon in Spring' }).waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    ok('a valid recap link renders the recap with no session')

    // Aggregate stats render (5 inclusive days from May 1–5; 4 stops; 3 travelers)
    // and a located stop appears in the "where they went" list.
    await page.getByText('travelers').first().waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Belém Tower').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the recap shows aggregate stats and located stops')

    // The read-only places-visited map (#248) renders from the projection's
    // coordinates — two located stops, so the route map appears (lazy Leaflet).
    await page
      .getByRole('region', { name: 'Map of places visited' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('the places-visited map renders from the located stops')

    // The epic's growth CTA links a first-time visitor into the create-trip flow.
    await page.getByRole('link', { name: /Plan your own trip/ }).first().waitFor({
      state: 'visible',
      timeout: 10_000,
    })
    ok('the "plan your own trip" CTA is present')

    // Read-only: no join / chat / edit affordances, and NO cost/settle-up figure
    // leaks onto the page (the recap deliberately carries no financials, like #127).
    for (const forbidden of ['Join the trip', 'Add item', 'Chat', 'Edit']) {
      if ((await page.getByRole('button', { name: forbidden }).count()) > 0) {
        throw new Error(`public recap exposed a "${forbidden}" control`)
      }
    }
    if (await page.getByText(/settle up/i).isVisible().catch(() => false)) {
      throw new Error('the public recap leaked a settle-up figure')
    }
    ok('no join / chat / edit / settle-up affordances appear on the recap')

    if (errors.length) throw new Error(`Uncaught page error on the recap page: ${errors[0]}`)
    ok('the recap page raised no uncaught errors')
  } finally {
    await context.close()
  }
}

async function runPublicRecapPending(browser) {
  console.log('\n▶ public recap: a valid link before the trip ends reads "not ready"')
  const context = await newContext(browser)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/r/${RECAP_PENDING_TOKEN}`, { waitUntil: 'domcontentloaded' })
    // A shared, valid link whose trip hasn't ended → the friendly not-ready state,
    // distinct from both a dead link and an empty page.
    await page.getByText('This recap isn’t ready yet').waitFor({ state: 'visible', timeout: 10_000 })
    ok('a not-yet-ended trip shows the "recap isn’t ready yet" state')
    if (await page.getByText('Belém Tower').isVisible().catch(() => false)) {
      throw new Error('a pending recap leaked ready content')
    }
    ok('no recap content leaks before the trip ends')
  } finally {
    await context.close()
  }
}

async function runPublicRecapRevoked(browser) {
  console.log('\n▶ public recap: a revoked / invalid token is a clean not-found')
  const context = await newContext(browser)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/r/${'d'.repeat(64)}`, { waitUntil: 'domcontentloaded' })
    // The RPC returned null → the honest "link isn’t available" state.
    await page.getByText('This link isn’t available').waitFor({ state: 'visible', timeout: 10_000 })
    ok('an invalid token yields the "link isn’t available" state')
    if (await page.getByText('Belém Tower').isVisible().catch(() => false)) {
      throw new Error('a revoked token still leaked recap content')
    }
    ok('no recap content leaks for an invalid token')
  } finally {
    await context.close()
  }
}

async function runRecapShareToggle(browser) {
  console.log('\n▶ public recap: owner enables the recap link from Settings')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/settings`, { waitUntil: 'domcontentloaded' })
    // The owner-only "Public recap link" card renders with its toggle.
    await page
      .getByRole('heading', { name: 'Public recap link' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('the owner sees the Public recap link card')

    const recapRpc = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/rpc/set_trip_recap_share') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.getByRole('switch', { name: 'Public recap link active' }).click()
    const req = await recapRpc
    if (req.postDataJSON()?.p_enabled !== true) {
      throw new Error('enabling the recap did not call set_trip_recap_share with p_enabled=true')
    }
    ok('toggling on calls set_trip_recap_share to opt the recap in')
  } finally {
    await context.close()
  }
}

async function runNotes(browser) {
  console.log('\n▶ notes: concurrent edits do not silently clobber (#272)')
  notesScenario = true
  notesStampSeq = 0
  notesRows = [{ ...NOTES_SEED_ITEM }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/notes`, { waitUntil: 'domcontentloaded' })
    const card = page.getByRole('heading', { name: 'Restaurant shortlist' })
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    ok('the seeded note renders on the notes page')

    // ── A normal single-editor save still works, unchanged (criterion 2) ──
    await card.click()
    const titleInput = page.getByPlaceholder('Note title')
    await titleInput.waitFor({ state: 'visible', timeout: 10_000 })
    const textarea = page.locator('textarea')
    await textarea.fill('- Ichiran ramen\n- Booked for Friday')
    await page.getByRole('button', { name: 'Save note' }).click()
    await page.getByText('Booked for Friday').waitFor({ state: 'visible', timeout: 10_000 })
    if (notesRows[0].content !== '- Ichiran ramen\n- Booked for Friday') {
      throw new Error('a normal save did not persist the edited content')
    }
    ok('a normal single-editor save persists unchanged')

    // ── A colliding save is caught, not silently applied (criterion 1) ──
    await card.click()
    await titleInput.waitFor({ state: 'visible', timeout: 10_000 })
    // Someone else saves while this editor is open: the stored row moves to a
    // newer version whose content differs from what this editor will submit.
    notesRows[0] = {
      ...notesRows[0],
      content: 'THEIRS — moved to a different place',
      updated_at: nextNoteStamp(),
    }
    await textarea.fill('MINE — my own rewrite')
    await page.getByRole('button', { name: 'Save note' }).click()
    await page
      .getByText('This note changed while you were editing.')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a save against a moved note surfaces the conflict prompt, not a clobber')
    if (notesRows[0].content !== 'THEIRS — moved to a different place') {
      throw new Error('the colliding save overwrote the other version instead of stopping')
    }
    ok('the other member’s version is intact — nothing was clobbered')

    // Reload theirs: the editor loads the current server version in place.
    await page.getByRole('button', { name: 'Reload theirs' }).click()
    await page.waitForFunction(
      () => document.querySelector('textarea')?.value === 'THEIRS — moved to a different place',
      { timeout: 10_000 }
    )
    ok('“Reload theirs” loads the version that landed while editing')

    // ── "Keep mine" is the deliberate-overwrite escape hatch (criterion 1) ──
    // One more concurrent save, then choose to keep our own text over it.
    notesRows[0] = { ...notesRows[0], content: 'THEIRS AGAIN', updated_at: nextNoteStamp() }
    await textarea.fill('MINE — keep this one')
    await page.getByRole('button', { name: 'Save note' }).click()
    const keepMine = page.getByRole('button', { name: 'Keep mine' })
    await keepMine.waitFor({ state: 'visible', timeout: 10_000 })
    await keepMine.click()
    await page.getByText('MINE — keep this one').waitFor({ state: 'visible', timeout: 10_000 })
    if (notesRows[0].content !== 'MINE — keep this one') {
      throw new Error('“Keep mine” did not overwrite with the editor’s content')
    }
    ok('“Keep mine” overwrites deliberately after an explicit choice')

    if (errors.length) throw new Error(`Uncaught page error on the notes page: ${errors[0]}`)
    ok('the notes conflict flow raised no uncaught errors')
  } finally {
    notesScenario = false
    notesRows = []
    await context.close()
  }
}

/*
  Questions surface (#273).

  Questions — the "who's driving? who books the flights?" ledger a group settles
  once — is a shipped interactive surface that mounted with no smoke scenario and
  no /rest/v1/questions route in the harness, so a broken render or a dead
  ask/answer control could reach `main` with nothing catching it (the exact class
  of production escape #262/#264 were). This drives the real QuestionsPage end to
  end against the stubbed Supabase: a seeded question proves the surface reads
  from the route, asking one exercises the create POST, and answering it exercises
  the PATCH — asserting each payload shape and that the answered question moves to
  the "Answered" section with its answer shown.
*/
async function runQuestions(browser) {
  console.log('\n▶ questions (ask a question, then answer it)')
  questionsScenario = true
  questionsRows = [{ ...QUESTION_SEED_ITEM }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/questions`, { waitUntil: 'domcontentloaded' })

    // The heading plus the seeded question prove the surface renders from the
    // /rest/v1/questions route (the populated list, not the empty state).
    await page
      .getByRole('heading', { name: 'Questions' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Who is booking the Airbnb?').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the questions surface renders a question from the questions route')

    // Asking: "Ask" opens the dialog; the create POSTs to /rest/v1/questions and
    // the stateful store lets the invalidate → refetch bring the new row back.
    const asked = 'Do we need travel insurance?'
    const createPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/questions') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'Ask', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#q-title').waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.locator('#q-title').fill(asked)
    await dialog.getByRole('button', { name: 'Post question' }).click()

    // The POST carries the trip id, the asker's member id, and the typed title.
    const payload = (await createPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.member_id !== OWNER_MEMBER.id ||
      payload?.title !== asked
    ) {
      throw new Error(`question POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('asking posts a question with trip, asker, and title')

    // After the refetch the new question renders in the open list.
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.getByText(asked).waitFor({ state: 'visible', timeout: 10_000 })
    ok('an asked question appears in the open list')

    // Answering: the asked card's "Answer" opens an inline editor; "Mark answered"
    // PATCHes {answered:true, answer}, and the refetch moves it to the Answered
    // section with the answer shown. Scope to the asked card so the seed's own
    // "Answer" control doesn't get clicked instead.
    const answerPatch = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/questions') && req.method() === 'PATCH',
      { timeout: 10_000 }
    )
    const askedCard = page.locator('.p-5', { hasText: asked })
    await askedCard.getByRole('button', { name: 'Answer', exact: true }).click()
    const answer = 'Yes — booking it through the card provider.'
    await askedCard.getByPlaceholder('Write the answer…').fill(answer)
    await askedCard.getByRole('button', { name: 'Mark answered' }).click()

    const patchPayload = (await answerPatch).postDataJSON()
    if (patchPayload?.answered !== true) {
      throw new Error(`answer PATCH payload wrong: ${JSON.stringify(patchPayload)}`)
    }
    ok('answering a question PATCHes answered:true')

    // The answered question surfaces under its "Answered" heading with the answer.
    await page.getByText('Answered (1)').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText(answer).waitFor({ state: 'visible', timeout: 10_000 })
    ok('an answered question moves to the Answered section with its answer')

    if (errors.length) throw new Error(`Uncaught page error on the questions page: ${errors[0]}`)
    ok('the questions flow raised no uncaught errors')
  } finally {
    questionsScenario = false
    questionsRows = []
    await context.close()
  }
}

/*
  Notes create surface (#273).

  The notes concurrency scenario (runNotes, #272) already covers rendering and a
  guarded edit on a seeded note, but never the create path — the "New note" →
  write → it appears flow, which had no /rest/v1/notes POST in the harness. This
  fills that gap: it mounts the empty board, creates a note through the real
  editor, asserts the create POST's payload shape, and asserts the new note
  renders on the board.
*/
async function runNotesCreate(browser) {
  console.log('\n▶ notes: create a note from scratch (#273)')
  notesScenario = true
  notesStampSeq = 0
  notesRows = []
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/notes`, { waitUntil: 'domcontentloaded' })

    // The surface mounts and renders its empty state — the route is reachable.
    await page.getByRole('heading', { name: 'Notes' }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('No notes yet').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the notes surface renders its empty state')

    // Creating: "New note" opens the editor; "Create note" POSTs to /rest/v1/notes
    // and the stateful store lets the invalidate → refetch list the new note.
    const title = 'Packing reminders'
    const createPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/notes') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'New note' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('Note title').waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.getByPlaceholder('Note title').fill(title)
    await dialog.locator('textarea').fill('- Universal adapter\n- Rain shell')
    await dialog.getByRole('button', { name: 'Create note' }).click()

    // The POST carries the trip id, the creator's member id, and the typed title.
    const payload = (await createPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.created_by !== OWNER_MEMBER.id ||
      payload?.title !== title
    ) {
      throw new Error(`note POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('creating posts a note with trip, creator, and title')

    // After the refetch the new note renders on the board and the dialog closed.
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.getByRole('heading', { name: title }).waitFor({ state: 'visible', timeout: 10_000 })
    ok('a created note appears on the notes board')

    if (errors.length) throw new Error(`Uncaught page error on the notes page: ${errors[0]}`)
    ok('the note-create flow raised no uncaught errors')
  } finally {
    notesScenario = false
    notesRows = []
    await context.close()
  }
}

/*
  Ideas / inspiration surface (#273).

  The shared idea board — the moodboard of hotels, restaurants and things worth
  doing — is a shipped interactive surface that mounted with no smoke scenario and
  no /rest/v1/inspiration_items route in the harness. This drives the real
  InspirationPage end to end against the stubbed Supabase: a seeded idea proves
  the surface reads from the route, then pinning one through the dialog exercises
  the create POST (asserting its payload shape) and the refetch proves the new
  idea renders on the board.
*/
async function runIdeas(browser) {
  console.log('\n▶ ideas (board renders + a pinned idea appears)')
  inspirationScenario = true
  inspirationRows = [{ ...INSPIRATION_SEED_ITEM }]
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/ideas`, { waitUntil: 'domcontentloaded' })

    // The heading plus the seeded idea prove the surface renders from the
    // /rest/v1/inspiration_items route (the populated board, not the empty state).
    await page.getByRole('heading', { name: 'Ideas' }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Rooftop bar in Bairro Alto').waitFor({ state: 'visible', timeout: 10_000 })
    ok('the ideas surface renders an idea from the inspiration_items route')

    // Pinning: "Pin an idea" opens the dialog; "Pin it" POSTs to
    // /rest/v1/inspiration_items and the stateful store lets the invalidate →
    // refetch bring the new row back so it renders on the board.
    const idea = 'Tram 28 photo spot'
    const createPost = page.waitForRequest(
      (req) => req.url().includes('/rest/v1/inspiration_items') && req.method() === 'POST',
      { timeout: 10_000 }
    )
    await page.getByRole('button', { name: 'Pin an idea' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#idea-title').waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.locator('#idea-title').fill(idea)
    await dialog.getByRole('button', { name: 'Pin it' }).click()

    // The POST carries the trip id, the creator's member id, the typed title, and
    // the default category — the idea write's payload shape.
    const payload = (await createPost).postDataJSON()
    if (
      payload?.trip_id !== TRIP_ID ||
      payload?.created_by !== OWNER_MEMBER.id ||
      payload?.title !== idea ||
      payload?.category !== 'general'
    ) {
      throw new Error(`idea POST payload wrong: ${JSON.stringify(payload)}`)
    }
    ok('pinning posts an idea with trip, creator, title, and category')

    // After the refetch the new idea renders on the board and the dialog closed.
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.getByText(idea).waitFor({ state: 'visible', timeout: 10_000 })
    ok('a pinned idea appears on the board')

    if (errors.length) throw new Error(`Uncaught page error on the ideas page: ${errors[0]}`)
    ok('the ideas flow raised no uncaught errors')
  } finally {
    inspirationScenario = false
    inspirationRows = []
    await context.close()
  }
}

/*
  Calendar surface (#273).

  The month view — travel dates, reservations, deadlines and activities in one
  grid — is a shipped surface that mounted with no smoke scenario at all, so a
  render break (a bad date parse, a null crash) could ship a silent white screen.
  This drives the real CalendarPage against the stubbed Supabase and asserts the
  primary things a smoke click protects: the month grid mounts without crashing,
  and paging to the next month updates the month label. It reads the default
  itinerary/checklist/budget routes the harness already serves; the weather
  overlay degrades to nothing without a forecast, so it never blocks (the same way
  the itinerary scenario tolerates it).
*/
async function runCalendar(browser) {
  console.log('\n▶ calendar (month grid renders + month navigation)')
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The month heading is the one "MMMM yyyy" <h2> — read it by that shape so a
  // layout heading elsewhere in the shell never stands in for it.
  const monthLabel = () =>
    page.evaluate(() => {
      const h = Array.from(document.querySelectorAll('h2')).find((el) =>
        /\s\d{4}$/.test((el.textContent || '').trim())
      )
      return h ? h.textContent.trim() : null
    })
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/calendar`, { waitUntil: 'domcontentloaded' })

    // The page heading and the weekday grid prove the month view mounts without
    // crashing — the escape class this scenario guards (a silent render break).
    await page
      .getByRole('heading', { name: 'Calendar' })
      .waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByText('Mon', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    ok('the calendar renders its heading and weekday grid')

    // Paging forward updates the month label — the primary interaction produces a
    // visible result, independent of what today's date happens to be.
    const before = await monthLabel()
    if (!before) throw new Error('the calendar did not render a month label')
    await page.getByRole('button', { name: 'Next month' }).click()
    await page.waitForFunction(
      (prev) => {
        const h = Array.from(document.querySelectorAll('h2')).find((el) =>
          /\s\d{4}$/.test((el.textContent || '').trim())
        )
        return !!h && h.textContent.trim() !== prev
      },
      before,
      { timeout: 10_000 }
    )
    ok('paging to the next month updates the month label')

    if (errors.length) throw new Error(`Uncaught page error on the calendar page: ${errors[0]}`)
    ok('the calendar flow raised no uncaught errors')
  } finally {
    await context.close()
  }
}

/*
  Global search palette (#273, extended for #282).

  The ⌘K command palette searches the trip's cached feature data and deep-links
  to matches. As of #282 it also covers the itinerary and budget, and warms every
  section's cache the moment it opens — so a record is found on a page this
  session never visited, not only the ones already navigated to. This lands on
  the checklist (which reads neither itinerary nor budget) and proves: the palette
  opens on ⌘K; the still-cached checklist item matches; an itinerary stop and a
  budget expense are found on unvisited pages via the on-open prefetch (the
  budget one by its category label); Escape closes it; and selecting a result
  deep-links to the record so the highlighter can scroll to it.
*/
async function runSearch(browser) {
  console.log('\n▶ search (⌘K finds itinerary + budget on unvisited pages, deep-links, closes)')
  searchScenario = true
  const context = await newContext(browser, OWNER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    // Land on the checklist — it reads neither the itinerary nor the budget, so
    // those caches are empty until the palette warms them. Its own overdue task
    // (the default route's single row) stays searchable, covering the pre-#282
    // cache-read path in the same run.
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}/checklist`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Renew passport').waitFor({ state: 'visible', timeout: 10_000 })

    // ⌘/Ctrl-K opens the command palette from anywhere in the trip.
    await page.keyboard.press('Control+k')
    const searchInput = page.getByRole('combobox', { name: 'Search this trip' })
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 })
    ok('⌘K opens the search palette')

    // A query matches the already-cached checklist item and surfaces it.
    await searchInput.fill('passport')
    await page
      .getByRole('option', { name: /Renew passport/ })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a query jumps to a matching cached result')

    // The itinerary page was never opened, so its stop is searchable only
    // because the palette prefetched it on open (#282). The result appears a
    // beat after the palette opens, once that prefetch lands.
    await searchInput.fill('Belém')
    await page
      .getByRole('option', { name: /Pastéis de Belém tasting/ })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('an itinerary stop is found on a page not visited this session')

    // The budget page was never opened either; this also proves the category
    // match — "Food" hits the seed's "Food & drinks" category, not its title.
    await searchInput.fill('Food')
    await page
      .getByRole('option', { name: /Dinner at Time Out Market/ })
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('a budget expense is found by its category on an unvisited page')

    // Escape closes the palette — the focus/escape behaviour the surface owns.
    await page.keyboard.press('Escape')
    await searchInput.waitFor({ state: 'hidden', timeout: 10_000 })
    ok('the palette closes on Escape')

    // Reopen and select the itinerary result: it must deep-link to the itinerary
    // page with the record's `#wander-item-<id>` hash, and that record must
    // render there (the anchor the SearchHighlighter scrolls to).
    await page.keyboard.press('Control+k')
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 })
    await searchInput.fill('Belém')
    const itineraryOption = page.getByRole('option', { name: /Pastéis de Belém tasting/ })
    await itineraryOption.waitFor({ state: 'visible', timeout: 10_000 })
    await itineraryOption.click()
    await page.waitForURL(
      (url) =>
        url.hash.includes(`/trip/${TRIP_ID}/itinerary`) &&
        url.hash.includes('wander-item-itin-search-1'),
      { timeout: 10_000 }
    )
    await page
      .locator('#wander-item-itin-search-1')
      .waitFor({ state: 'visible', timeout: 10_000 })
    ok('selecting a result deep-links to the record on its page')

    if (errors.length) throw new Error(`Uncaught page error on the search palette: ${errors[0]}`)
    ok('the search flow raised no uncaught errors')
  } finally {
    searchScenario = false
    await context.close()
  }
}

async function runJoinWelcome(browser) {
  console.log('\n▶ join welcome (a just-joined friend is oriented, once)')
  const SEEN_KEY = `wander_welcome_seen:${TRIP_ID}:${JOINING_MEMBER.id}`
  joinWelcomeScenario = true
  // ── A member landing on the dashboard sees the one-time orientation ──
  const context = await newContext(browser, MEMBER_SESSION)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${BASE_URL}/#/trip/${TRIP_ID}`, { waitUntil: 'domcontentloaded' })

    // The panel is a labelled region ("Welcome to Lisbon in Spring"); it points
    // to the trip's collaborative surfaces and names who's already here.
    const welcome = page.getByRole('region', { name: /Welcome to Lisbon in Spring/ })
    await welcome.waitFor({ state: 'visible', timeout: 10_000 })
    ok('a just-joined member sees the first-visit orientation')

    await welcome.getByText(/planning this trip with planner/).waitFor({ state: 'visible', timeout: 10_000 })
    for (const surface of ['Chat', 'Itinerary', 'Polls', 'Packing']) {
      await welcome
        .getByRole('link', { name: new RegExp(surface) })
        .waitFor({ state: 'visible', timeout: 10_000 })
    }
    ok('the orientation points to the trip’s main surfaces')

    // Dismissing it persists per (trip, member) and it does not reappear.
    await welcome.getByRole('button', { name: 'Dismiss welcome' }).click()
    await welcome.waitFor({ state: 'hidden', timeout: 10_000 })
    const seen = await page.evaluate((k) => localStorage.getItem(k), SEEN_KEY)
    if (seen !== '1') throw new Error('dismissing the welcome did not persist the seen flag')
    ok('dismissing the welcome persists a per-membership seen flag')

    // A reload must not resurrect a dismissed welcome.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Lisbon in Spring').first().waitFor({ state: 'visible', timeout: 10_000 })
    if (await welcome.isVisible()) throw new Error('a dismissed welcome reappeared after reload')
    ok('a dismissed welcome stays dismissed on the next visit')

    if (errors.length) throw new Error(`Uncaught page error on the welcome flow: ${errors[0]}`)
    ok('the welcome flow raised no uncaught errors')
  } finally {
    await context.close()
  }

  // ── The owner's create-trip flow is not a join, so they never see it ──
  const ownerContext = await newContext(browser, OWNER_SESSION)
  const ownerPage = await ownerContext.newPage()
  try {
    await ownerPage.goto(`${BASE_URL}/#/trip/${TRIP_ID}`, { waitUntil: 'domcontentloaded' })
    // Wait for the dashboard to actually render before asserting the absence,
    // so this can't pass merely because the page hadn't painted yet.
    await ownerPage.getByText('Lisbon in Spring').first().waitFor({ state: 'visible', timeout: 10_000 })
    const ownerWelcome = ownerPage.getByRole('region', { name: /Welcome to Lisbon in Spring/ })
    if (await ownerWelcome.isVisible()) {
      throw new Error('the owner was shown the just-joined welcome')
    }
    ok('the owner never sees the just-joined welcome')
  } finally {
    joinWelcomeScenario = false
    await ownerContext.close()
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
    await runJoinWelcome(browser)
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
    await runChat(browser)
    await runItinerary(browser)
    await runChecklist(browser)
    await runPacking(browser)
    await runNotes(browser)
    await runNotesCreate(browser)
    await runQuestions(browser)
    await runIdeas(browser)
    await runCalendar(browser)
    await runSearch(browser)
    await runPolls(browser)
    await runErrorReporting(browser)
    await runPublicShare(browser)
    await runPublicShareRevoked(browser)
    await runPublicShareToggle(browser)
    await runPublicRecap(browser)
    await runPublicRecapPending(browser)
    await runPublicRecapRevoked(browser)
    await runRecapShareToggle(browser)
    console.log(`\n✓ smoke: ${passed} assertions passed`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('\n✗ smoke test failed:', err)
  process.exit(1)
})
