# Wander Improvement Loop — Routines

Three Claude routines run a continuous improvement loop over
`tseten1996/wander`, tiered by responsibility. GitHub Issues are the single
source of truth for the backlog (`docs/IMPROVEMENTS.md` is a historical
ledger — never add new backlog items there).

| Tier | Routine | Cadence | Owns |
|---|---|---|---|
| 3 — Product | [`03-discovery-strategy.md`](03-discovery-strategy.md) | Daily (scheduled) | Audit, backlog hygiene, issue creation, staging the build queue |
| 1 — Engineering | [`01-build-and-ship.md`](01-build-and-ship.md) | On demand (label webhook) | Implementing one queued issue as a PR |
| 2 — Review | [`02-code-review.md`](02-code-review.md) | On demand (CI webhook) | Reviewing the PR, bouncing or approving |

The human's jobs: file ideas (via the `wander-idea-triage` skill or by hand),
override the queue when they want something built next, and **merge PRs** —
merging is the only way work becomes Done.

## Label state machine

```
improvement ──(discovery stages, score ≥14)──► queue:ready
queue:ready ──(build routine picks it up)────► queue:in-progress
queue:in-progress ──(PR opened)──────────────► queue:in-review
queue:in-review ──(review FAIL: needs-changes on PR)──► queue:in-progress
queue:in-review ──(review PASS, human merges; `Closes #` fires)──► closed
```

- `improvement` — a scored backlog issue (every non-epic issue has it)
- `epic` — parent of a large bet; never queued, never scored; slices are
- `blocked` — needs a secret, a paid service, or a human decision; never queued
- `theme:*` — optional area tags (e.g. `theme:collaboration`) for balance
- `queue:ready` — staged for build; **only the discovery routine (or the
  human, deliberately) applies it**
- `queue:in-progress` — being built; **only the build routine applies it**
- `queue:in-review` — PR open, awaiting review verdict
- `needs-changes` — on the PR, applied by review on a bounce; removed by
  build when findings are addressed

Transition rule everywhere: when swapping queue labels, **add the new label
first, then remove the old one** — a crash mid-swap must leave a detectable
dual-label, never a label-less issue.

## Issue schema (the contract all routines parse)

```md
## Problem
<1–3 sentences, from the affected member's point of view>

## Proposed approach
<2–4 sentences>

## Acceptance criteria
- [ ] <criterion>
- [ ] `npm run build` passes

## Scores (1–5, higher is better)
impact: <n> · frequency: <n> · differentiation: <n> · ease: <n> · safety: <n> · **total: <n>/25**

## Meta
files: <concrete paths — conflict detection depends on them>
migration_required: <yes|no>
depends_on: <#s or none>
complexity: <small|medium|large>
signal: <audit|strategy|user|ledger>
```

Score anchors:

- **impact** — how much better the trip-planning experience gets at the
  affected moment (5 = transforms a core flow, 1 = cosmetic)
- **frequency** — how often a real group hits that moment (5 = every
  session, 1 = rare edge)
- **differentiation** — movement vs the status quo (the 400-message group
  chat) and competitors (Wanderlog, TripIt, Google Travel)
- **ease** — inverse effort (5 = an hour, 1 = multi-day)
- **safety** — risk-free-ness (a 1–2 means it touches RLS policies, the
  join/auth flow, or destructive data paths)

**Score floor: total ≥ 14/25 to be stageable as `queue:ready`.** Sub-14
issues stay in the backlog as records; the human can stage them by hand.

## Guardrails (violating any of these is a defect; weakening one is never a valid issue)

1. **RLS is the security boundary.** The client is never trusted. Every new
   table carries `trip_id` and policies built on `is_trip_member` /
   `is_trip_owner`. Client-side permission checks are UX; Postgres is
   enforcement.
2. **The invite code is the only capability.** It is never readable through
   RLS by non-members; joining happens exclusively through the `join_trip`
   RPC. Never add a second join path.
3. **Friends never create accounts.** The 15-second anonymous join flow is
   the product. Nothing may require a friend to sign up, verify an email,
   or lose their remembered device session.
4. **Owner-only powers stay owner-only** — delete/archive trip, remove
   members, manage the invite link, edit trip details.
5. **No backend, no paid anything.** Static SPA on GitHub Pages + Supabase
   free tier. No server code, no API keys, no paid APIs. Free no-key
   services (Open-Meteo, Nominatim-style) are the established pattern.
6. **Design tokens only** from `src/index.css`; both themes; mobile floors
   (44px tap targets, 16px inputs, no hover-only actions);
   `prefers-reduced-motion` respected.
7. **Simplicity beats features.** Silence beats a modal. The smallest
   complete version wins.
