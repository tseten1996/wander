# Wander — Improvement Ledger

This file is the single source of truth for what has been built and what to
build next. **Every improvement session must read this file first and update
it before finishing.** Never re-implement anything in the Shipped list.

## How to use this ledger (rules for improvement sessions)

1. Read this whole file + `docs/ARCHITECTURE.md` before writing code.
2. Pick the **top unblocked item** from the Backlog (or a P1 before a P2).
3. Ship the **smallest complete version** — one improvement per session.
4. Keep the product philosophy: simplicity beats features; mobile-first;
   design tokens from `src/index.css` only (no raw palette values); RLS is
   the security boundary; TypeScript strict; `npm run build` must pass.
5. When done: move the item to Shipped with the date and a one-line note,
   add any new ideas discovered while working, and open a PR.
6. DB changes go in a new `supabase/migrations/NNNN_name.sql` file and the
   item gets tagged **[needs migration apply]** — migrations are applied to
   project `qqmfxbcroxunvtgxxray` manually, never assume they ran.
7. If an item needs a secret, a paid API, or a human decision, tag it
   **[blocked: reason]**, skip it, and take the next item.

## Shipped

- 2026-07-18 — Project scaffold: Vite + React 19 + TS strict + Tailwind v4 theme, architecture docs
- 2026-07-18 — Full Supabase schema: 15 tables, RLS on all, `join_trip`/`get_invite_preview` RPCs, realtime publication, advisor hardening pass
- 2026-07-18 — Auth: owner magic link, invisible anonymous sessions for friends, 15-second invite join flow with name + color picker
- 2026-07-18 — Trips home: list with cover/countdown/avatars, create-trip dialog (RHF + zod), archived section
- 2026-07-18 — App shell: desktop sidebar / mobile bottom tabs, dark + light themes, theme persistence
- 2026-07-18 — Dashboard: hero + countdown, planning-progress bar with confetti at 100%, budget summary, upcoming items, activity feed, quick-nav cards
- 2026-07-18 — Polls: categories, expiry, one vote per member (tap-again to unvote), live results, winner highlight, close/reopen/delete
- 2026-07-18 — Chat: realtime, replies, emoji reactions, owner pins, edit/delete, day dividers
- 2026-07-18 — Questions: ask → anyone answers → answered section, reopen
- 2026-07-18 — Checklist: assignees, due dates with overdue badges, notes, optimistic toggles, progress bar
- 2026-07-18 — Itinerary: day grouping, six categories, drag-to-reorder (dnd-kit, float positions), times/locations/costs
- 2026-07-18 — Budget: trip budget vs planned vs spent, per-category bars, paid-by, estimate-vs-actual
- 2026-07-18 — Packing: five categories with per-category progress and quick-add
- 2026-07-18 — Calendar: month grid merging travel dates, itinerary, checklist due dates, payment dates; day detail list
- 2026-07-18 — Notes: shared markdown notes with write/preview tabs, pinning
- 2026-07-18 — Inspiration board: masonry cards (image/link/note), category filters
- 2026-07-18 — Settings: trip details, profile editor, invite copy/regenerate/disable, member removal + leave, danger zone with typed confirm
- 2026-07-18 — Exports: JSON export/import, print-to-PDF trip summary page
- 2026-07-18 — PWA (installable, precached shell) + GitHub Pages CI deploy; live at https://tseten1996.github.io/wander/
- 2026-07-18 — Fix: CI empty env vars blanked Supabase config (`||` vs `??`)
- 2026-07-19 — Validation hardening: zod + react-hook-form on itinerary, budget,
  packing, ideas and settings (trip info + profile) forms with inline field
  errors; shared `friendlyError()` mapping for Postgres error codes wired into
  every mutation's error toast

## Backlog

### P1 — polish what exists
- [ ] Extend the zod + react-hook-form + `friendlyError()` pattern (shipped
      2026-07-19 on itinerary/budget/packing/ideas/settings) to Checklist,
      Polls, Messages, Questions and Notes — those five still create/update
      via ad-hoc `useState` forms and raw `error.message` toasts
- [ ] Replace native date inputs with a styled popover calendar widget
      (build on the Calendar page's grid; keep native inputs on mobile)
- [ ] Itinerary links: URL field on items; auto-detect pasted URLs in
      title/notes; show favicon + hostname chip that opens the restaurant/
      hotel page; "Open in Google Maps" link built from the location field
- [ ] Empty-trip onboarding: first-visit checklist template offer
      ("Book flights, reserve stay, travel insurance…" one-tap starter pack)
- [ ] Unread indicators: per-feature "new since last visit" dots in the nav
      (store last-seen timestamps locally)
- [ ] Loading/error states audit: every query error currently fails silent —
      add toast + retry affordance
- [ ] Accessibility pass: focus management in dialogs, aria-live for vote
      counts, contrast check in both themes, keyboard drag alternative for
      itinerary reorder

### P2 — new capability, still simple
- [ ] Expense settlement: "who owes who" math from paid_by amounts with a
      per-member balance card on the Budget page
- [ ] Place autocomplete for itinerary/trip destination via a free geocoder
      (Photon/komoot or Nominatim — check usage policy, debounce, no key
      needed; degrade gracefully offline)
- [ ] Trip cover picker: curated gradient presets + paste-URL preview
      (skip API keys; Unsplash source URLs work without auth)
- [ ] Poll options with images/links (e.g. Airbnb candidates side by side)
- [ ] ICS export: download the itinerary as a .ics file so it lands in
      Apple/Google Calendar
- [ ] Search: one search box over polls/messages/checklist/notes/ideas
      (client-side over cached queries is enough at this scale)
- [ ] Chat images: Supabase Storage bucket + RLS, paste/drop upload,
      lightbox view [needs migration apply + storage setup]
- [ ] Realtime presence: "who's looking at the plan right now" avatars via
      Supabase presence channels

### P3 — infrastructure & quality
- [ ] Playwright smoke test (sign-in stubbed, join flow, create trip) run in
      CI on PRs; typecheck job on PRs
- [ ] Bundle split: framer-motion + supabase into separate chunks (main
      chunk is ~860 kB pre-gzip)
- [ ] Offline read cache: persist TanStack Query cache to localStorage so a
      trip opens read-only without network
- [ ] RLS regression tests as SQL (pgTAP or plain scripts) covering the
      permission matrix in ARCHITECTURE.md
- [ ] Error reporting: lightweight window.onerror → Supabase table so broken
      deploys surface without user reports

### Blocked / decided against (do not revisit without a human decision)
- Turnstile CAPTCHA on auth — decided against 2026-07-19: friends-only app,
  invite codes validated server-side; CAPTCHA off in Supabase settings
- Email/push notifications — needs a server or paid service; free tier has
  no scheduled functions without cost; revisit only if requested
- Account avatars (image upload) — colored initials chosen deliberately for
  the 15-second join; don't add upload friction
