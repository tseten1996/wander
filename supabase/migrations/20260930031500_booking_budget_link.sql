-- #370, epic #346 (final slice): link a stay or transport hop to the budget
-- entry that paid for it. Until now "the €600 Airbnb in Berlin" lived twice —
-- once as a Stay with no cost, once as a nameless expense on the Budget page —
-- with nothing tying the two together. This adds a nullable pointer from each
-- booking to the single budget entry that records its cost, so a group can see
-- what a stay/hop cost, who paid, and how it splits without retyping the booking
-- as a separate expense.
--
-- This is the exact shape #151 already gave itinerary items
-- (20260730183756_itinerary_budget_link.sql): an additive, nullable FK, so the
-- link is a pointer between two existing rows, never a new expense. Budget totals
-- and settle-up keep reading `budget_entries` alone (settlement.ts is blind to
-- this column), so nothing is ever double-counted and the who-owes-whom math is
-- unchanged.
--
-- ON DELETE SET NULL is the safety valve: deleting the expense can never leave a
-- dangling reference — the booking's link clears itself and the booking stays
-- intact. Deleting the booking, conversely, leaves the budget entry untouched
-- (no cascade either way).
--
-- No RLS change is needed. Both `stays` and `transport` already enable RLS with
-- member select / self-insert / author-or-owner update+delete policies
-- (20260915142000_stays.sql, 20260921143000_transport.sql), and a row-level
-- policy governs every column, new ones included — so only the booking's author
-- or the trip owner can set or clear the link, through the existing update gate.
-- The FK reference is validated by Postgres with table-owner privileges
-- (constraint checks bypass RLS), so a member linking their own booking to a
-- budget entry they can already read needs no new grant. Both tables are
-- trip-scoped, so the join surface stays inside one trip. `stays` and
-- `transport` are already in the supabase_realtime publication, so the new
-- column — and the SET NULL that fires on an expense delete — replicate live
-- with no publication change. `duplicate_trip` does not copy stays/transport at
-- all, so the link is not copied either (deferred, like the bookings themselves).

alter table public.stays
  add column if not exists budget_entry_id uuid
    references public.budget_entries(id) on delete set null;

alter table public.transport
  add column if not exists budget_entry_id uuid
    references public.budget_entries(id) on delete set null;

-- Partial indexes over only the linked rows: keep the "which bookings point at
-- this entry?" reverse lookup (the Budget page's back-reference) and the
-- ON DELETE SET NULL cascade cheap, without indexing the common unlinked case.
create index if not exists stays_budget_entry_id_idx
  on public.stays(budget_entry_id)
  where budget_entry_id is not null;

create index if not exists transport_budget_entry_id_idx
  on public.transport(budget_entry_id)
  where budget_entry_id is not null;
