-- #125: record a repayment so "who owes who" updates as people pay each other back.
--
-- The settle-up card (#45, settlement.ts) computes the minimal "A pays B $X"
-- transfers a group should make to square up, but the loop dead-ended there:
-- there was no way to record that a payment *actually happened*, so after the
-- first Venmo the card still showed the debt and the group fell back to a chat
-- message or Splitwise. This adds a first-class **repayment** record — a member
-- paid another member back — that nets against the computed balances.
--
-- Design:
--   • A repayment is kept **separate from `budget_entries`** on purpose: it is a
--     transfer *between members*, not a cost the trip incurred. Keeping it out of
--     the expenses table means it never pollutes "what did the trip cost" totals
--     or the per-category bars — settlement is the only place it participates
--     (settlement.ts nets recorded repayments against the owed amounts).
--   • `from_member` / `to_member` — who paid whom, as `members.id`. A repayment
--     from A to B reduces A's debt and B's credit by `amount`. ON DELETE CASCADE:
--     if either party is removed from the trip the repayment loses its meaning,
--     so it is dropped rather than left dangling (settlement.ts additionally only
--     nets repayments whose both endpoints are current members).
--   • Multi-currency, frozen exactly like #79 expenses: `amount` is the figure in
--     `currency` (NULL = trip currency), and `amount_converted` is that amount
--     expressed in the trip currency, frozen at record time (NULL when already in
--     the trip currency). Settlement reads `amount_converted ?? amount`, so a
--     multi-currency trip reconciles on the same converted footing as its
--     expenses and a settled balance never drifts when reference rates later move.
--   • `exchange_rate` — original→trip rate used, kept for transparency, like the
--     budget_entries currency columns.
--
-- Additive: no change to `budget_entries` or to settlement semantics for trips
-- with no repayments (an empty repayment set nets nothing).
create table if not exists public.repayments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  from_member uuid not null references public.members(id) on delete cascade,
  to_member uuid not null references public.members(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  -- Original ISO currency the amount was recorded in. NULL = trip currency.
  currency text,
  -- `amount` expressed in the trip currency, frozen at record time. NULL when the
  -- repayment is already in the trip currency (read `amount_converted ?? amount`).
  amount_converted numeric(12,2),
  -- original→trip rate used, kept so a settled balance doesn't drift on rate moves.
  exchange_rate numeric(18,8),
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  -- A payment to oneself is meaningless and would net to zero anyway; reject it
  -- at the DB boundary (Wander invariant: Postgres enforces, the client is UX).
  constraint repayments_distinct_parties check (from_member <> to_member)
);

create index if not exists repayments_trip_idx
  on public.repayments (trip_id, created_at desc);

alter table public.repayments enable row level security;

-- RLS: identical trip-member scoping to every other content table. Any member can
-- record a repayment (they insert it as themselves via created_by); the payer or
-- the trip owner can remove one that was recorded in error.
create policy repayment_select on public.repayments for select
  using (is_trip_member(trip_id));
create policy repayment_insert on public.repayments for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy repayment_update on public.repayments for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy repayment_delete on public.repayments for delete
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime: broadcast row changes so the settle-up card updates live for every
-- member the moment a repayment is recorded (RLS still applies per subscriber).
alter publication supabase_realtime add table public.repayments;
