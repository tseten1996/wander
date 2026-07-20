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
- 2026-07-19 — Owner welcome step: after creating a trip, the owner (whose
  member row previously defaulted silently to their email username) is now
  prompted once to confirm/edit their display name and color, mirroring the
  friend join flow — skippable, no migration needed
- 2026-07-19 — Mobile-responsive audit (375/390/768px): mobile bottom nav only
  reached 5 of 12 pages — added a "More" bottom-sheet tab so every page is
  reachable and thumb-sized; fixed 5 hover-only actions (chat bubble menu,
  note card actions, checklist row menu, packing delete, idea delete) that
  were unreachable on touch; global CSS fix for the classic iOS input-zoom
  bug (16px minimum on mobile inputs, applied outside Tailwind's layer so it
  can't be silently overridden); global 44px tap-target floor for icon-only
  buttons via a `[data-icon-button]` marker rather than per-instance classes
  (avoids a tailwind-merge footgun — see the comment in index.css); wrapped
  the print-summary budget table in a scroll container. Verified with
  `npm run build` and a Playwright pass that mocks the Supabase network layer
  (this sandbox can't reach the real project — see prior sessions) to render
  an authenticated trip at all three breakpoints and confirm zero horizontal
  overflow anywhere, including the new More sheet.
- 2026-07-19 — Bumped remaining mobile touch targets under 44px: Input,
  SelectTrigger/SelectItem, TabsTrigger and DropdownMenuItem now carry a
  `data-tap-target` marker floored to 44px height by an unlayered
  `@media (max-width:767px)` rule in index.css — same min-height trick as
  the existing `[data-icon-button]` fix, so it composes with any call
  site's own height class instead of fighting it in tailwind-merge (Packing's
  compact `h-9` quick-add still gets the floor without its desktop size
  changing). Checkbox keeps its 20px visible box and instead gets an
  invisible, centered 44x44 hit area via a `data-tap-target-overlay`
  pseudo-element, so the checkbox itself doesn't look oversized; Packing's
  list rows (the only place dense enough for neighbouring checkboxes' hit
  areas to overlap) got `max-md:py-3` so consecutive rows stay ≥44px apart.
  Also floored a raw `<button>` in Packing's delete action that had been
  missed by the icon-button fix (it didn't use the shared `<Button>`
  component, so never got `data-icon-button`). Verified with `npm run
  build` and a local Playwright pass (own throwaway script, not committed)
  that mocks the Supabase REST layer to render Packing/Checklist/
  Settings/Notes (incl. the note-editor Tabs) at desktop + mobile —
  screenshots in docs/screenshots/ show taller, comfortably spaced controls
  on mobile with no overlap/overflow, and an unchanged desktop.
- 2026-07-19 — Comprehensive mobile audit (user-requested, 320-1024px):
  4 parallel research passes over every UI primitive, layout/nav component,
  form dialog and content page turned up 19 confirmed bugs, all fixed:
  (1) Dialog's close button lived inside its own `overflow-y-auto` region
  and scrolled out of reach on tall content — moved to a sibling of a new
  inner scroll wrapper so it stays pinned, and floored it to 44px via
  `data-icon-button` (it had neither mobile marker, unlike every other
  icon-only control). (2) Dialog's mobile/desktop switch was gated on
  Tailwind's `sm:` (640px) while every other mobile rule in the app (tap
  targets, 16px input font) uses `md:` (768px) — inputs behaved "mobile"
  while the dialog chrome behaved "desktop" between 640-767px; unified on
  `md:`. (3) Popover/Select/DropdownMenu content had no `collisionPadding`,
  so flipped/shifted popups could render flush against the screen edge —
  added a 16px default to all three, plus `max-w-[calc(100vw-2rem)]` and
  (for Popover/DropdownMenu, Select already had it) `max-h-*
  overflow-y-auto` so tall/wide content scrolls instead of clipping.
  (4) SelectItem's option text had no truncate/`min-w-0` guard and could
  force the popper wider than the viewport — fixed. (5) Seven `grid
  grid-cols-2`/`grid-cols-3` form rows (CreateTripDialog, ItineraryPage x2,
  PollsPage, BudgetPage x3, SettingsPage, ChecklistPage, InspirationPage)
  packed date/time inputs or the Budget summary cards into ~130px columns
  on a 320-375px phone with no mobile-first stacking — every one now reads
  `grid-cols-1 sm:grid-cols-2/3/4`. (6) Calendar day cells used a forced
  `aspect-square` that could be shorter than its content (a date circle +
  up to 4 event dots) on a 320-375px phone, spilling dots into the row
  below with no clipping; replaced with a `min-h-11` floor (content-driven
  height, also now a real 44px tap target) plus `overflow-hidden` as a
  backstop, keeping `sm:aspect-[4/3]` where there's room. (7) Note card
  titles had no `break-words`, and — the actual root cause once traced —
  the note's CSS Grid item (a `motion.div`) had no `min-w-0`, so Grid's
  automatic per-item minimum-size algorithm still sized the column to fit
  one long unbroken title/URL token regardless of the child's own
  wrapping, causing real page-level horizontal scroll; fixed at both
  layers. Verified with `npm run build` and a local mocked-Supabase
  Playwright pass (own throwaway script, not committed — see the P3 idea
  below) at 320/375/414px covering the dialogs and pages the fixes touch;
  screenshots in docs/screenshots/ (w320/w375/w414 prefixes) confirm every
  fix. Everything else audited (bottom tab bar, sidebar/header truncation,
  PageHeader wrapping, chat bubbles, inspiration masonry, dashboard grids,
  images) came back clean — see the audit agents' full findings in this
  session's transcript if a future session wants the negative results too.
- 2026-07-20 — Popup + input design polish (user-requested): reworked the
  dialog/popup presentation so popups feel native on mobile and refined on
  desktop. Dialogs now animate — mobile sheets slide up from the bottom
  edge and back down on close (no more instant pop-in), desktop dialogs
  fade+zoom from center; all three floating menus (Select, DropdownMenu,
  Popover) gained matching exit animations so nothing vanishes abruptly.
  Added a mobile grabber handle to the sheet, tightened mobile padding
  (p-5 vs desktop p-6) and enlarged the mobile dialog title (text-xl) and
  close-button hit area. Inputs/Textarea/Select now render a real error
  state driven by `aria-invalid` (danger border + soft danger ring that
  survives focus), wired into every form field that shows an inline error
  across all dialogs — so an invalid field looks broken at the control,
  not only in the helper text, and the a11y signal matches the visual.
  Also: hover-border affordance on all text controls, `inputMode="decimal"`
  on every numeric field (cost/budget/estimated/actual) for a better mobile
  keypad, stripped the crowded webkit number spinners, and left-aligned
  native date/time values so mixed forms read as one clean column. Verified
  with `npm run build` and a mocked-Supabase Playwright pass: mobile sheet
  rests flush to the viewport bottom with the invalid field showing a red
  border (rgb(225,29,72)) + error text and zero overflow, and the desktop
  dialog lands dead-center (640,400 on a 1280x800 viewport) after its enter
  animation and closes cleanly on Escape.

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
- [ ] Commit a reusable mock-Supabase screenshot/test harness (scripts/
      screenshot-mock.mjs): every sandboxed session that needs a screenshot
      of a data-bearing page currently re-derives its own throwaway
      Playwright script that stubs the REST/auth layer with fabricated
      trip/member/content rows, because this environment can't reach the
      real Supabase project. A committed, parameterized version (pick
      tables + rows via args) would save that rework and could double as
      the base for the Playwright smoke test above.

### Blocked / decided against (do not revisit without a human decision)
- Turnstile CAPTCHA on auth — decided against 2026-07-19: friends-only app,
  invite codes validated server-side; CAPTCHA off in Supabase settings
- Email/push notifications — needs a server or paid service; free tier has
  no scheduled functions without cost; revisit only if requested
- Account avatars (image upload) — colored initials chosen deliberately for
  the 15-second join; don't add upload friction
