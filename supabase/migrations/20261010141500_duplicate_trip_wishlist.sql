-- Carry the wishlist forward through duplicate_trip (#393).
--
-- duplicate_trip() is the retention lever — "the reason a group doesn't come
-- back for trip #2" — and #352 built the finished-trip recap's "plan your next
-- trip from this one" hook on top of it. But the one piece of content whose
-- value is inherently forward-looking was silently dropped: the wishlist
-- (`wishlist_items`, #355 / epic #164).
--
-- The wishlist is the "want to go but didn't get to" shelf — saved-but-
-- unscheduled places with no date attached. When a group replans ("let's do
-- Lisbon again, we never made it to that rooftop bar"), those saved places are
-- exactly what should seed the new trip. The omission was one of age, not
-- intent: duplicate_trip was last redefined in
-- 20260809032000_duplicate_trip_budget_link.sql, six weeks before
-- wishlist_items existed (20260923143000_wishlist_items.sql), so it was never
-- in the copy set.
--
-- Unlike stays/transport (date-bound: a specific flight on specific dates has
-- no meaning in a new trip) and legs (route structure), a wishlist place is
-- date-free — the natural carry-forward. So copy it the same way packing is
-- copied: a member-authored shelf, re-authored as the new owner (the old
-- members.id values don't exist in the new trip), behind a new
-- p_include_wishlist flag that defaults on like the other five.
--
-- No RLS change: the insert runs as definer exactly like the other five copy
-- blocks, and pinning added_by to the new owner means no forged author.
--
-- The signature grows by one trailing defaulted parameter. A function's
-- identity is (name, argument types), so CREATE OR REPLACE at the new arity
-- would NOT replace the 9-arg version — it would create a second overload
-- beside it, and a call omitting p_include_wishlist (an old frontend still live
-- during the deploy↔migration window) would then be ambiguous between the two.
-- So drop the old 9-arg signature first, then create the 10-arg one. The
-- one-way race that remains — a new frontend sending 10 args before this
-- migration lands — fails loudly and self-heals on retry; the reverse (old
-- frontend, new DB) resolves cleanly to the new function with p_include_wishlist
-- taking its default. Supabase re-grants EXECUTE to anon/authenticated on the
-- freshly created function (per 20260729231000_duplicate_trip.sql), so the
-- revoke footer is restated at the new arity to strip public + anon, leaving
-- `authenticated` as the only executor exactly as before.
drop function if exists public.duplicate_trip(
  uuid, text, date, date, boolean, boolean, boolean, boolean, boolean
);

create or replace function public.duplicate_trip(
  p_source_trip_id uuid,
  p_name text default null,
  p_start_date date default null,
  p_end_date date default null,
  p_include_itinerary boolean default true,
  p_include_checklist boolean default true,
  p_include_packing boolean default true,
  p_include_budget boolean default true,
  p_include_notes boolean default true,
  p_include_wishlist boolean default true
)
returns uuid
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_src trips%rowtype;
  v_new_trip_id uuid;
  v_owner_member uuid;
  -- old budget_entries.id (text) → new budget_entries.id (text). Empty when
  -- the budget isn't part of this duplicate, which makes every lookup NULL.
  v_budget_map jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Guardrail #3: anonymous friends never create trips.
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'NOT_ALLOWED';
  end if;

  -- Access boundary: the caller must belong to the source trip. Enforced here
  -- because SECURITY DEFINER bypasses the row-level policies below it.
  select * into v_src from trips where id = p_source_trip_id;
  if not found or not is_trip_member(p_source_trip_id) then
    raise exception 'NO_ACCESS';
  end if;

  -- The new trip, owned by the caller. The `on_trip_created` trigger creates
  -- the owner's members row; a fresh, unguessable invite_code comes from the
  -- column default (never copied — the old link stays scoped to the old trip).
  insert into trips (owner_id, name, destination, description, cover_url,
                     start_date, end_date, estimated_budget, currency)
  values (
    v_uid,
    coalesce(nullif(btrim(p_name), ''), 'Copy of ' || v_src.name),
    v_src.destination, v_src.description, v_src.cover_url,
    p_start_date, p_end_date, v_src.estimated_budget, v_src.currency
  )
  returning id into v_new_trip_id;

  -- Author every copied row as the new owner: the old members.id values don't
  -- exist in the new trip, and the caller owns everything they just created.
  select id into v_owner_member
  from members
  where trip_id = v_new_trip_id and user_id = v_uid;

  -- Budget: keep the estimate skeleton (title, category, estimated + its frozen
  -- conversion + rate); reset the actual spend, who-paid, the split, and the
  -- entry date — those are records of what the old trip actually spent.
  --
  -- Runs before the itinerary so the links below have something to point at.
  -- `src` is MATERIALIZED so its volatile gen_random_uuid() is evaluated once
  -- and both the INSERT and the map read the same new ids; the data-modifying
  -- CTE runs to completion whether or not the outer query reads its output.
  if p_include_budget then
    with src as materialized (
      select b.*, gen_random_uuid() as new_id
      from budget_entries b
      where b.trip_id = p_source_trip_id
    ), ins as (
      insert into budget_entries (id, trip_id, title, category, estimated,
        actual, currency, estimated_converted, actual_converted, exchange_rate,
        participants, paid_by, entry_date, notes, created_by)
      select s.new_id, v_new_trip_id, s.title, s.category, s.estimated,
        null, s.currency, s.estimated_converted, null, s.exchange_rate,
        null, null, null, s.notes, v_owner_member
      from src s
      returning 1
    )
    select coalesce(jsonb_object_agg(s.id::text, s.new_id::text), '{}'::jsonb)
    into v_budget_map
    from src s;
  end if;

  -- Itinerary: keep the structure (title, category, place, coordinates, link,
  -- times, cost, order, budget link); drop `day` so items land unscheduled
  -- under the new trip's fresh dates rather than pointing at the old trip's
  -- calendar. An unmapped or absent link resolves to NULL.
  if p_include_itinerary then
    insert into itinerary_items (trip_id, title, category, day, start_time,
      end_time, location, latitude, longitude, url, notes, cost, position,
      budget_entry_id, created_by)
    select v_new_trip_id, title, category, null, start_time, end_time, location,
      latitude, longitude, url, notes, cost, position,
      (v_budget_map ->> budget_entry_id::text)::uuid,
      v_owner_member
    from itinerary_items where trip_id = p_source_trip_id;
  end if;

  -- Checklist: reset done + assignee + due date; keep title / notes / order.
  if p_include_checklist then
    insert into checklist_items (trip_id, title, notes, assignee_id, due_date,
      done, position, created_by)
    select v_new_trip_id, title, notes, null, null, false, position,
      v_owner_member
    from checklist_items where trip_id = p_source_trip_id;
  end if;

  -- Packing: reset packed; keep name / category / order.
  if p_include_packing then
    insert into packing_items (trip_id, name, category, packed, position,
      added_by)
    select v_new_trip_id, name, category, false, position, v_owner_member
    from packing_items where trip_id = p_source_trip_id;
  end if;

  -- Notes: shared reference material with no per-instance state — copied as-is.
  if p_include_notes then
    insert into notes (trip_id, title, content, pinned, created_by)
    select v_new_trip_id, title, content, pinned, v_owner_member
    from notes where trip_id = p_source_trip_id;
  end if;

  -- Wishlist: the "want to go, didn't get to" shelf — date-free saved places,
  -- the natural carry-forward into a replanned trip (#393). Modeled exactly on
  -- the packing copy: keep name / category / note / url / coordinates / order,
  -- re-author as the new owner (`added_by`), and carry no per-instance state
  -- (the shelf has none). Pinning `added_by` to the new owner means no forged
  -- author, so no RLS surface is added.
  if p_include_wishlist then
    insert into wishlist_items (trip_id, name, category, note, url,
      latitude, longitude, position, added_by)
    select v_new_trip_id, name, category, note, url,
      latitude, longitude, position, v_owner_member
    from wishlist_items where trip_id = p_source_trip_id;
  end if;

  return v_new_trip_id;
end;
$$;

revoke execute on function public.duplicate_trip(
  uuid, text, date, date, boolean, boolean, boolean, boolean, boolean, boolean
) from public, anon;
