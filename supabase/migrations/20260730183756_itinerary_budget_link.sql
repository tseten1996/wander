-- #151: give the itinerary item's cost somewhere real to go. Today a costed
-- itinerary item *looks* tracked but moves no budget total — the only way to
-- actually track that money is to retype it on the Budget page, with no link
-- between the two. This adds a nullable pointer from an itinerary item to the
-- budget entry that pays for it, so the two can be connected without ever
-- double-counting: totals keep reading `budget_entries` only, and linking just
-- creates (or points at) a single real entry.
--
-- ON DELETE SET NULL is the safety valve the issue calls for: deleting an
-- expense can never leave a dangling reference — the itinerary item's link
-- clears itself and its cost quietly reverts to an unlinked planning note.
--
-- Additive, nullable column. No RLS change is needed: itinerary_items already
-- has RLS enabled with member select/insert/update/delete policies (init
-- migration), and those row-level policies govern every column, new ones
-- included. The FK reference is validated by Postgres with table-owner
-- privileges (constraint checks bypass RLS), so a member linking their own
-- itinerary item to a budget entry they can already read needs no new grant.
-- Both tables are trip-scoped, so the join surface stays inside one trip.
-- itinerary_items is already in the supabase_realtime publication, so the new
-- column — and the SET NULL that fires on an expense delete — replicate live
-- with no publication change.
alter table public.itinerary_items
  add column if not exists budget_entry_id uuid
    references public.budget_entries(id) on delete set null;

-- Partial index over only the linked rows: keeps the "which items point at this
-- entry?" reverse lookup and the ON DELETE SET NULL cascade cheap without
-- indexing the common unlinked case.
create index if not exists itinerary_items_budget_entry_id_idx
  on public.itinerary_items(budget_entry_id)
  where budget_entry_id is not null;
