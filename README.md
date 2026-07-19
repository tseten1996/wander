# Wander — collaborative trip planner ✈️

Plan trips with your friends in one beautiful place: polls, group chat,
itinerary, budget, packing lists, notes and an inspiration board — replacing
the 400-message group chat.

**Stack**: React 19 + TypeScript + Vite + Tailwind v4 + Framer Motion +
TanStack Query, backed by Supabase (Postgres, RLS, Realtime, Auth) on the free
tier. Hosted as a static site on GitHub Pages. Installable as a PWA.

> Architecture, database schema and folder structure are documented in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How access works (by design, ultra-simple)

- **You (the owner)** sign in once with an **email magic link**. No passwords.
- **Friends never create accounts.** You send them an invite link; they open
  it, type a display name, pick a color, and they're in — under 15 seconds.
  Behind the scenes they get an invisible anonymous Supabase session that's
  remembered on their device.
- Only the owner can: delete/archive the trip, remove members, regenerate or
  disable the invite link, and edit trip details. Everyone can plan.

## Local development

```bash
npm install
npm run dev
```

That's it — the Supabase project is already configured in
`src/lib/config.ts` (URL + publishable key are public; Row Level Security is
the actual security boundary). To use your own project, copy `.env.example`
to `.env.local` and fill in your values.

## One-time Supabase setup checklist

The database schema is applied (see `supabase/migrations/`). Two switches
must be flipped in the [Supabase dashboard](https://supabase.com/dashboard/project/qqmfxbcroxunvtgxxray)
(they have no Management-API/MCP equivalent):

1. **Enable anonymous sign-ins** — *Authentication → Sign In / Up →
   Allow anonymous sign-ins*. Required for the friend join flow.
2. **Set auth URLs** — *Authentication → URL Configuration*: set **Site URL**
   to your GitHub Pages URL (e.g. `https://YOURNAME.github.io/trip/`) and add
   `http://localhost:5173` to **Redirect URLs** for local dev. Required so
   magic links return to the app.

Optional hardening for a public deployment: enable
[CAPTCHA protection](https://supabase.com/docs/guides/auth/auth-captcha) on
anonymous sign-ins, and note that anonymous users are cleaned up by you —
they only ever hold membership of trips they were invited to.

## Deploying to GitHub Pages

1. Create a GitHub repo and push this project to `main`.
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. Done — `.github/workflows/deploy.yml` builds and publishes on every push.

The Vite `base: './'` + hash routing means it works under any repo name with
zero configuration. After the first deploy, update the Supabase **Site URL**
(step 2 above) to the published address.

## Feature map

| Area | What you get |
|------|--------------|
| Dashboard | Cover hero, countdown, planning-progress bar (confetti at 100%), budget summary, upcoming items, live activity feed |
| Polls | Categories, expiry, one vote per member, live results, winner highlight, owner/creator close |
| Chat | Realtime messages, replies, emoji reactions, pinned messages, edit/delete |
| Questions | Ask → answer → done; anyone can answer |
| Checklist | Assignees, due dates (overdue badges), notes, optimistic toggles |
| Itinerary | Day-by-day timeline, six categories, drag-to-reorder, times/locations/costs |
| Budget | Trip budget vs planned vs spent, per-category chart, paid-by tracking |
| Packing | Five categories, per-category progress, quick add |
| Calendar | Month view merging travel dates, itinerary, checklist deadlines and payments |
| Notes | Shared markdown notes with preview, pinning |
| Ideas | Pinterest-style masonry board with category filters |
| Settings | Trip details, profile, invite management, members, export/import JSON, print-to-PDF summary, archive/delete |

## Data & security model (summary)

Every table carries `trip_id` and is protected by RLS: you must have a
`members` row for that trip to read or write anything. Mutating helpers
(`is_trip_member`, `is_trip_owner`, `my_member_id`) are `SECURITY DEFINER`
Postgres functions; joining happens exclusively through the `join_trip(code,
name, color)` RPC so invite codes are validated server-side. Full schema in
[supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql).

`supabase/seed.sql` contains demo data for a local `supabase db reset`.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Type-check only |
