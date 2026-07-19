# Wander — Architecture

Wander is a collaborative trip planner for a small group of friends. One person
(the **owner**) signs in with a Supabase magic link; everyone else joins a trip
through an **invite link** in under 15 seconds — no accounts, no passwords.

This document explains the overall approach, the database schema, and the
folder structure. Read it before touching the code.

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

## 2. Identity & permissions

Two kinds of people, one mechanism:

| Who | How they authenticate | What it costs them |
|-----|----------------------|--------------------|
| Owner | Supabase **email magic link** | one click in their inbox |
| Friend | Supabase **anonymous sign-in**, created invisibly when they open an invite link | nothing — they just type a display name |

Every person therefore has a real `auth.uid()`, which is what RLS policies
check. The anonymous session is persisted in Local Storage (alongside a
`wander_device_id`), so friends stay recognized on their device.

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
  │               ├─ polls ─ poll_options ─ votes   (one vote per member per poll)
  │               ├─ messages ─ message_reactions   (threads via reply_to)
  │               ├─ questions           (asked / answered)
  │               ├─ checklist_items     (assignee, due date, done)
  │               ├─ itinerary_items     (day, time, category, position)
  │               ├─ budget_entries      (estimated vs actual, paid_by)
  │               ├─ packing_items       (category, packed)
  │               ├─ notes               (markdown)
  │               ├─ inspiration_items   (image / link board)
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
│   ├── config.ts            # env vars with safe defaults
│   ├── utils.ts             # cn(), formatters, misc helpers
│   ├── device.ts            # device id in Local Storage
│   ├── colors.ts            # avatar palette
│   └── export.ts            # JSON export/import, print-to-PDF helpers
├── types/
│   └── index.ts             # DB row types + enums shared by all features
├── components/
│   ├── ui/                  # design-system primitives (button, card, dialog…)
│   └── layout/              # AppShell: sidebar (desktop) / tab bar (mobile)
├── hooks/
│   ├── useAuth.tsx          # session context (owner or anonymous friend)
│   ├── useTrip.tsx          # current trip + my membership context
│   └── useRealtime.ts       # per-trip realtime → query invalidation
└── features/
    ├── trips/               # home: trip list, create trip
    ├── join/                # invite landing page (name + colour → in)
    ├── dashboard/           # countdown, progress, summaries
    ├── polls/
    ├── messages/
    ├── questions/
    ├── checklist/
    ├── itinerary/
    ├── budget/
    ├── packing/
    ├── calendar/
    ├── notes/
    ├── inspiration/
    └── settings/            # trip info, members, invite link, danger zone
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
  the shell + dashboard only.
* TanStack Query caches per `[table, tripId]`; realtime events invalidate
  instead of refetch-on-focus storms.
* Images (covers, inspiration) are plain `<img loading="lazy">` with URL
  sources — nothing is proxied or stored (free tier friendly).

## 7. Deployment

* `npm run build` → static `dist/`.
* `.github/workflows/deploy.yml` builds and publishes to GitHub Pages on
  every push to `main`. Supabase URL/key are public values baked at build
  time (RLS is the security boundary, not the key).
* See `README.md` for the one-time Supabase setup checklist (enable
  anonymous sign-ins, set the site URL for magic links).
