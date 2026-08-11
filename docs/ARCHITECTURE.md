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
access to everything in their trip. Only the owner can delete the trip,
remove members, regenerate/disable invite links, and close polls.

## 3. Database schema

All tables live in `public`, keyed by `uuid`. Every content table carries a
`trip_id` and is protected by two helper functions:

* `is_trip_member(trip_id)` — an accepted `members` row exists for `auth.uid()`
* `is_trip_owner(trip_id)` — the caller owns the trip

```
trips ────────────┬─ members            (person ↔ trip, role, name, color)
  │  (+share_token)├─ destinations       (ordered legs: place, date range, position)
  │               ├─ polls ─ poll_options ─ votes   (one vote per member per poll)
  │               ├─ messages ─ message_reactions   (threads via reply_to)
  │               ├─ questions           (asked / answered)
  │               ├─ checklist_items     (assignee, due date, done)
  │               ├─ itinerary_items     (day, time, category, position, latitude/longitude)
  │               ├─ budget_entries      (estimated vs actual, paid_by, currency + *_converted)
  │               ├─ repayments          (settle-up transfers: from/to member, amount)
  │               ├─ packing_items       (category, packed)
  │               ├─ notes               (markdown)
  │               ├─ inspiration_items   (image / link board)
  │               ├─ notifications       (per-recipient inbox: type, entity, read state)
  │               ├─ error_reports       (write-only client error telemetry)
  │               └─ activity            (lightweight event feed)
```

Notable decisions:

* **`activity`** is a plain append-only table written by the client helpers on
  meaningful mutations. It powers "Recent activity" on the dashboard without
  expensive cross-table queries.
* **Votes** enforce *one vote per member per poll* with a unique index; voting
  again switches your vote (upsert).
* **Ordering** (itinerary, checklist) uses a float `position` column —
  drag-and-drop writes the midpoint of its neighbours, no renumbering.
* **Multi-currency budget.** A `budget_entries` row may be logged in its own
  `currency`; its `estimated_converted` / `actual_converted` amounts are
  frozen into the trip currency at entry time (the client reads
  `converted ?? raw`), so roll-ups and the settle-up math stay correct even if
  reference rates move afterwards.
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
    ├── messages/            # chat: replies, reactions, pins, @-mentions → inbox
    ├── questions/
    ├── checklist/
    ├── itinerary/           # timeline + list ⇄ Leaflet/OSM map view, per-leg distance, weather
    ├── budget/              # multi-currency entries, trip-currency conversion, settle-up
    ├── packing/
    ├── calendar/            # month view + daily weather forecast
    ├── notes/
    ├── inspiration/
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
* See `README.md` for the one-time Supabase setup checklist (enable
  anonymous sign-ins, set the site URL for magic links).
