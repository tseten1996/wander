-- Carry itinerary→budget links through duplicate_trip.
--
-- duplicate_trip() copies itinerary_items and budget_entries independently, so
-- the `budget_entry_id` link added in 20260730183756_itinerary_budget_link.sql
-- was silently dropped: a duplicated trip came back with every costed item
-- reading "planning note, not in budget" even though the matching estimate had
-- been copied alongside it. The link is part of the reusable structure the
-- feature exists to preserve (#80) — losing it is exactly the retyping the
-- link was built to remove.
--
-- Fix: copy the budget FIRST with pre-generated ids, keep an old→new map, and
-- resolve each itinerary item's link through it. Items whose entry wasn't
-- copied (budget excluded from the duplicate) fall back to NULL, which is the
-- pre-existing behaviour.
--
-- No signature change, no new table, no RLS/publication change — CREATE OR
-- REPLACE preserves the existing grants, and the revoke is restated at the
-- bottom to keep this file idempotent on its own.
create or replace function public.duplicate_trip(
  p_source_trip_id uuid,
  p_name text default null,
  p_start_date date default null,
  p_end_date date default null,
  p_include_itinerary boolean default true,
  p_include_checklist boolean default true,
  p_include_packing boolean default true,
  p_include_budget boolean default true,
  p_include_notes boolean default true
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

  return v_new_trip_id;
end;
$$;

revoke execute on function public.duplicate_trip(
  uuid, text, date, date, boolean, boolean, boolean, boolean, boolean
) from public, anon;
