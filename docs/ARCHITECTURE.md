# Wander — Architecture

Wander is a collaborative trip planner for a small group of friends. One person
(the **owner**) signs in with a Supabase magic link; everyone else joins a trip
through an **invite link** in under 15 seconds — no accounts, no passwords.

This document explains the overall approach, the database schema, and the
folder structure. Read it before touching the code.

For how AI fits on top of all of this — and what it is deliberately not allowed
to do — see [`AI-ARCHITECTURE.md`](./AI-ARCHITECTURE.md).

---

## 1. High-level approach

```
┌──────────────────────┐        ┌─────────────────────────────┐
│  React SPA (Vite)    │  HTTPS │  Supabase (free tier)       │
│  GitHub Pages        │ ─────► │  • Postgres + RLS           │
│                      │        │  • Auth (magic link + anon) │
│  TanStack Query      │ ◄───── │  • Realtime (postgres CDC)  │
│  cache + realtime    │  WS    │  • RPCs (SECURITY DEFINER)  │
└──────────────────────┘        └─────────────────────────────┘
```

* **No custom backend.** The browser talks straight to Supabase. All
  authorization lives in Postgres **Row Level Security** policies, so the
  client can never be trusted-but-wrong.
* **TanStack Query** owns all server state (fetching, caching, optimistic
  updates). **Supabase Realtime** invalidates queries when other members
  change data, so everyone sees updates live.
* **HashRouter** is used because GitHub Pages is a static host with no
  rewrite rules — `https://you.github.io/trip/#/join/CODE` always resolves.
  `base: './'` in Vite makes the bundle work under any repo name.
* **PWA**: `vite-plugin-pwa` precaches the app shell so it can be installed
  on phones and opens instantly.
* **Free, keyless data services.** Beyond Supabase the app calls only free,
  no-key HTTP services, consistent with the "no paid anything" guardrail:
  OpenStreetMap raster tiles (itinerary map), Open-Meteo (`src/lib/weather.ts`,
  daily forecast on the Calendar and Itinerary), Photon/komoot
  (`src/lib/geocode.ts`, location autocomplete), and Frankfurter/ECB
  (`src/lib/rates.ts`, currency conversion). Each degrades gracefully to
  "unavailable" on failure rather than breaking the field it feeds.
* **Live presence.** A per-trip Supabase realtime presence channel
  (`src/hooks/usePresence.ts`) reports which members currently have the trip
  open; the shell header renders them as an avatar stack
  (`src/components/layout/LivePresence.tsx`).

## 2. Identity & permissions

Two kinds of people, one mechanism:

| Who | How they authenticate | What it costs them |
|-----|----------------------|--------------------|
| Owner | Supabase **email magic link** | one click in their inbox |
| Friend | Supabase **anonymous sign-in**, created invisibly when they open an invite link | nothing — they just type a display name |

Every person therefore has a real `auth.uid()`, which is what RLS policies
check. The anonymous session — persisted in Local Storage — is what keeps
friends recognized on their device. A `wander_device_id` is also generated and
stored on first load, but it is currently **inert**: nothing reads it yet (it's
reserved for the identity-persistence work in epic #97, e.g. helping a returning
friend recover a session Safari has evicted). The session, not this id, is the
credential today.

Joining is done by a `SECURITY DEFINER` RPC — `join_trip(invite_code, name,
color)` — which validates the invite code server-side and inserts a
`members` row. The invite code itself is never readable through RLS by
non-members, so the URL is the only capability.

**Roles** are exactly two: `owner` and `member`, stored on the `members` row.
Policies grant members write access to their own rows and the owner write
access to everything in their trip. A member edits their own profile (name,
colour) and their own **arrival/departure dates** (#286); the owner may edit
any member's — both cases are the *same* `members_update` policy
(`user_id = auth.uid() OR is_trip_owner`), so the dates added no new policy,
only two columns to the column-level UPDATE grant. Only the owner can delete
the trip, remove members, and regenerate/disable invite links. Closing or reopening a
poll is **not** owner-exclusive: a poll's creator (any member) can close or
reopen their own poll, as can the owner (`polls_update`: `created_by =
my_member_id(trip_id) OR is_trip_owner(trip_id)`).

## 3. Database schema

All tables live in `public`, keyed by `uuid`. Every content table carries a
`trip_id` and is protected by two helper functions:

* `is_trip_member(trip_id)` — an accepted `members` row exists for `auth.uid()`
* `is_trip_owner(trip_id)` — the caller owns the trip

```
trips ────────────┬─ members            (person ↔ trip, role, name, color, arrival/departure dates)
  │  (+share_token)├─ destinations       (ordered legs: place, date range, position)
  │               ├─ polls ─ poll_options ─ votes   (one vote per member per poll)
  │               ├─ availability_polls ─ availability_candidates ─ availability_responses  (owner-run date poll; one response per member per candidate)
  │               ├─ messages ─ message_reactions   (threads via reply_to; inline images via image_path)
  │               ├─ questions           (asked / answered)
  │               ├─ checklist_items     (assignee, due date, done)
  │               ├─ itinerary_items     (day, time, category, position, latitude/longitude)
  │               ├─ budget_entries      (estimated vs actual, paid_by, currency + *_converted, weighted/itemized shares)
  │               ├─ repayments          (settle-up transfers: from/to member, amount)
  │               ├─ packing_items       (category, packed)
  │               ├─ notes               (markdown)
  │               ├─ inspiration_items   (image / link board)
  │               ├─ trip_photos         (pointers to directly-uploaded gallery photos)
  │               ├─ notifications       (per-recipient inbox: type, entity, read state)
  │               ├─ error_reports       (write-only client error telemetry)
  │               └─ activity            (lightweight event feed)
```

Notable decisions:

* **`activity`** is a plain append-only table written by the client helpers on
  meaningful mutations. It powers "Recent activity" on the dashboard without
  expensive cross-table queries.
* **Member trip dates.** A `members` row carries optional `arrives_on` /
  `departs_on` dates (#286, epic #285): null means "here for the whole trip",
  so a trip that never sets them is unchanged. Two guards enforce them
  server-side, not just in the client — a same-row `CHECK`
  (`departs_on >= arrives_on`) and a validate-only trigger
  (`members_validate_trip_dates`) that rejects a date outside the trip's own
  `[start_date, end_date]` (a CHECK can't reach the parent `trips` row). The
  calendar day cells and the header's "who's here today" read these; nothing in
  the join flow touches them.
* **Votes** enforce *one vote per member per poll* with a unique index; voting
  again switches your vote (upsert).
* **Ordering** (itinerary, checklist) uses a float `position` column —
  drag-and-drop writes the midpoint of its neighbours, no renumbering.
* **Multi-currency budget.** A `budget_entries` row may be logged in its own
  `currency`; its `estimated_converted` / `actual_converted` amounts are
  frozen into the trip currency at entry time (the client reads
  `converted ?? raw`), so roll-ups and the settle-up math stay correct even if
  reference rates move afterwards.
* **Weighted splits.** Beyond *who* shares a cost (`participants`), a
  `budget_entries` row may carry a `shares` `{ member_id: weight }` JSON map for
  weighted or itemized splits; `NULL`/empty means an even split. Weights are
  scale-free and a `CHECK` keeps the map clean, but the split is UX only —
  writes are still gated by the `budget_update` policy.
* **Availability polls** find a date everyone can make. The owner opens a poll
  and proposes candidate date ranges (`availability_polls` +
  `availability_candidates`, both owner-managed via `is_trip_owner`); every
  member marks each range yes/maybe/no (`availability_responses`, self-written,
  one row per member per candidate). The owner-only `apply_availability_dates`
  RPC writes the chosen range back onto the trip. All three tables are in the
  `supabase_realtime` publication — the overlap counts update live as members
  respond.
* **Destinations** model a multi-city trip as an ordered list of legs (place +
  optional geocoded pin + date range), sharing the same float `position`
  ordering. Members read (`is_trip_member`); **owner-only** writes
  (`is_trip_owner` on insert/update/delete) — the route is trip structure, like
  the dates.
* **Repayments** record settle-up transfers between members. Any member reads
  (`is_trip_member`) and logs a transfer they created (`created_by =
  my_member_id`); a transfer is deletable by its creator or the owner.
* **Notifications** are a per-recipient inbox (`type`, soft `entity_id` pointer,
  title snapshot, `read_at`). You read (`select`) and mark-read (`update`) only
  your own rows (`recipient_id = my_member_id`); inserts are self-attributed and
  trip-scoped (`is_trip_member AND actor_id = my_member_id`), so no member can
  forge a notification as someone else or across trips. `type` is a `CHECK`-listed
  set (`checklist_assigned`, `poll_opened`, `expense_owed`, `mention`).
* **Error reports** are a write-only telemetry sink for uncaught client errors.
  The anon key may `INSERT` (self-attributed: `user_id = auth.uid()` and
  `trip_id IS NULL OR is_trip_member`), but rows are **not** world-readable —
  `SELECT` is owner-only for trip-scoped rows, and deploy-level (`trip_id IS
  NULL`) rows are readable only via the dashboard `service_role`. No `UPDATE` /
  `DELETE` policies, so the log is append-only.
* **Chat images.** A message may carry an optional `image_path` (text-only,
  image-only, or both). Images live in a **private** Storage bucket
  (`public = false`) keyed `<trip_id>/<uuid>.<ext>`; Storage RLS scopes read
  and write to trip members, so no image leaks across trips and nothing is
  proxied or re-hosted (free-tier friendly).
* **Trip photos** are a browsable gallery (#294, epic #205 slice 4) that *aggregates*
  the images already in a trip — chat images (`messages.image_path`) and
  inspiration-board images (`inspiration_items.image_url`) — into one date-grouped
  grid with a lightbox, adding no new trust boundary. A member may also upload a
  photo straight into the gallery: `trip_photos` is a thin pointer row (`trip_id`,
  `member_id`, `image_path`), and the object itself reuses the same private
  `chat-images` bucket, path convention, and Storage RLS as a chat image — no new
  bucket and no new public-read surface. Read is member-scoped, insert is
  self-attributed, delete is uploader-or-owner, and there is no update policy; the
  table is in the `supabase_realtime` publication so an uploaded photo appears live.
* **Public share link** (read-only): an owner mints an unguessable `share_token`
  on `trips` via the `set_trip_share` RPC; a token holder reads a whitelisted,
  read-only itinerary projection through the `get_public_itinerary` (SECURITY
  DEFINER) RPC — no membership, no write, no member PII, no invite code. It is
  the app's only public-read surface and is kept entirely separate from the join
  path (there is no public `SELECT` policy on any base table).
* **Realtime** is enabled for all content tables via the
  `supabase_realtime` publication; the client subscribes per-trip and simply
  invalidates the matching query keys.
* Migrations live in `supabase/migrations/` and are applied in order; seed
  data for demos lives in `supabase/seed.sql`.

## 4. Frontend folder structure

```
src/
├── main.tsx                 # entry: providers (Query, Theme, Auth, Router)
├── App.tsx                  # route table + layout composition
├── index.css                # Tailwind v4 theme tokens (light/dark), base styles
├── lib/
│   ├── supabase.ts          # single Supabase client
│   ├── queryClient.ts       # TanStack Query client + localStorage persister (offline cache, sign-out purge)
│   ├── config.ts            # env vars with safe defaults
│   ├── utils.ts             # cn(), formatters, misc helpers
│   ├── device.ts            # device id in Local Storage
│   ├── colors.ts            # avatar palette
│   ├── activity.ts          # fire-and-forget writes to the trip activity feed
│   ├── notify.ts            # fire-and-forget writes to the per-recipient notification inbox
│   ├── errors.ts            # Postgres/PostgREST codes → friendly toast copy (friendlyError)
│   ├── errorReporting.ts    # global onerror/unhandledrejection → error_reports telemetry
│   ├── confetti.ts          # canvas-confetti burst when planning hits 100%
│   ├── geo.ts               # keyless haversine distance + travel-time estimate between itinerary stops
│   ├── geocode.ts           # keyless place autocomplete via Photon (komoot/OSM)
│   ├── weather.ts           # keyless daily forecast via Open-Meteo
│   ├── rates.ts             # keyless FX rates via Frankfurter (ECB) + supported-currency list
│   └── export.ts            # JSON export/import, print-to-PDF helpers
├── types/
│   └── index.ts             # DB row types + enums shared by all features
├── components/
│   ├── ui/                  # design-system primitives (button, card, dialog…)
│   └── layout/              # AppShell: sidebar (desktop) / tab bar (mobile)
├── hooks/
│   ├── useAuth.tsx          # session context (owner or anonymous friend)
│   ├── useTrip.tsx          # current trip + my membership context
│   ├── useRealtime.ts       # per-trip realtime → query invalidation
│   ├── usePresence.ts       # per-trip realtime presence channel → set of live member ids
│   └── useWeather.ts        # trip destination + dates → daily forecast (Open-Meteo)
└── features/
    ├── trips/               # home: trip list, create trip
    ├── join/                # invite landing page (name + colour → in)
    ├── dashboard/           # countdown, progress, summaries
    ├── destinations/        # multi-city legs: editor + leg/route derivation (owner-only)
    ├── polls/
    ├── dates/               # date-range availability poll (owner-run, live overlap)
    ├── messages/            # chat: replies, reactions, pins, images, @-mentions → inbox
    ├── questions/
    ├── checklist/
    ├── itinerary/           # timeline + list ⇄ Leaflet/OSM map view, per-leg distance, weather
    ├── budget/              # multi-currency entries, trip-currency conversion, settle-up
    ├── packing/
    ├── calendar/            # month view + daily weather forecast
    ├── notes/
    ├── inspiration/
    ├── photos/              # browsable trip gallery: aggregates chat + inspiration images + direct uploads
    ├── search/              # ⌘/Ctrl-K command-palette over cached trip data
    ├── notifications/       # personal inbox bell (per-recipient, cross-device)
    ├── me/                  # cross-trip personal view ("my stuff")
    ├── share/               # public read-only itinerary page (token RPC, no session)
    └── settings/            # trip info, members, invite link, share link, danger zone
```

Each feature folder contains its **api.ts** (TanStack Query hooks — the only
place that touches Supabase for that feature) and its page/components. UI
primitives never import from features.

## 5. Design system

Tokens are defined once in `index.css` with Tailwind v4 `@theme`:

* **Palette** — warm paper background, deep-teal primary ("ocean"), amber
  accent ("sunset"), stone ink. Dark mode swaps the neutrals, keeps the hues.
* **Type** — Inter Variable for UI, Bricolage Grotesque Variable for display
  headings. Both self-hosted via Fontsource (no external requests, PWA-safe).
* **Shape** — large radii (`rounded-2xl` cards), soft layered shadows,
  generous spacing, subtle gradients only on hero surfaces.
* **Motion** — Framer Motion for page transitions and list items;
  120–250 ms, ease-out, respects `prefers-reduced-motion`.

## 6. Performance

* Every feature page is lazy-loaded (`React.lazy`) — the initial bundle is
  the shell + dashboard only. The itinerary **map view is itself lazily
  imported** (`ItineraryMap`), so Leaflet + its CSS land in a separate async
  chunk that loads only when a member opens the Map tab.
* TanStack Query caches per `[table, tripId]`; realtime events invalidate
  instead of refetch-on-focus storms.
* The query cache is **persisted to `localStorage`** (`src/lib/queryClient.ts`,
  `PersistQueryClientProvider`) so a previously-visited trip renders read-only
  when the device is offline; an `OfflineBanner` makes the read-only state
  explicit. Only successful queries are dehydrated, and the snapshot is
  **purged on sign-out** (`useAuth`) so no account's data survives on disk or
  re-hydrates for the next user on a shared browser.
* Images (covers, inspiration) are plain `<img loading="lazy">` with URL
  sources — nothing is proxied or stored (free tier friendly).

## 7. Deployment

* `npm run build` → static `dist/`.
* `.github/workflows/deploy.yml` builds and publishes to GitHub Pages on
  every push to `main`. Supabase URL/key are public values baked at build
  time (RLS is the security boundary, not the key).
* `.github/workflows/deploy-cloudflare.yml` publishes the same `dist` to
  **Cloudflare Pages** (#246), running *alongside* GitHub Pages rather than
  replacing it. Two origins serve the app while Cloudflare proves itself;
  GitHub Pages stays canonical, so every URL already in circulation keeps
  working and abandoning either direction costs one deleted file. The job
  no-ops until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist, so
  it cannot break `main` before it is configured.
* **Why a second host at all:** GitHub Pages cannot set response headers or
  build a pull request. `public/_headers` gives content-hashed `/assets/*`
  an immutable year and forces `index.html` / `sw.js` to revalidate — the
  cause behind the post-deploy blank screen that `src/lib/chunkReload.ts`
  recovers from — and Cloudflare builds a preview URL per PR, which is the
  review surface an agent-driven PR workflow has been missing.
* **HashRouter is unchanged by that move.** Cloudflare supports rewrites, so
  the constraint in §1 could be lifted, but doing so breaks every invite
  link, share link, bookmark and installed PWA already out there. That is
  tracked separately (#247) and must not be folded into a hosting change.
* See `README.md` for the one-time Supabase setup checklist (enable
  anonymous sign-ins, set the site URL for magic links).
