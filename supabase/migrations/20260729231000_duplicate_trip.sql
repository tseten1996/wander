-- #80: Duplicate a trip as a starting point for the next one.
--
-- A group that just finished a trip has real structure worth reusing — an
-- itinerary skeleton, a checklist, a packing list, budget categories, notes —
-- but every new trip started from a blank slate, which is the single biggest
-- reason a group doesn't come back for trip #2. duplicate_trip() copies that
-- reusable structure into a brand-new trip owned by the caller while resetting
-- everything that belongs only to the old trip instance: dates, members,
-- invite code, chat, votes, polls, activity, and each item's
-- done / packed / paid / actual-spend progress.
--
-- SECURITY DEFINER, mirroring join_trip: the copy runs server-side in one
-- transaction and enforces access in SQL — the client is UX, Postgres is the
-- boundary (guardrail #1). Two checks gate it:
--   • the caller must be a MEMBER of the source trip (is_trip_member) — this is
--     re-checked here because SECURITY DEFINER bypasses RLS; and
--   • the caller must be a real, non-anonymous user — the same gate the
--     `trips_insert` RLS policy applies to trip creation (guardrail #3:
--     friends never create accounts, so friends never create trips).
-- Reading rows the caller can already see and inserting them into their own
-- new trip leaks nothing, so ANY member — not only the owner — may reuse a
-- trip; the source trip is only ever read, never modified.
--
-- No new tables and no new join path, so no RLS / realtime / publication
-- changes are needed: every row is written into an existing content table that
-- already carries the correct policies and realtime publication.
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

  -- Itinerary: keep the structure (title, category, place, coordinates, link,
  -- times, cost, order); drop `day` so items land unscheduled under the new
  -- trip's fresh dates rather than pointing at the old trip's calendar.
  if p_include_itinerary then
    insert into itinerary_items (trip_id, title, category, day, start_time,
      end_time, location, latitude, longitude, url, notes, cost, position,
      created_by)
    select v_new_trip_id, title, category, null, start_time, end_time, location,
      latitude, longitude, url, notes, cost, position, v_owner_member
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

  -- Budget: keep the estimate skeleton (title, category, estimated + its frozen
  -- conversion + rate); reset the actual spend, who-paid, the split, and the
  -- entry date — those are records of what the old trip actually spent.
  if p_include_budget then
    insert into budget_entries (trip_id, title, category, estimated, actual,
      currency, estimated_converted, actual_converted, exchange_rate,
      participants, paid_by, entry_date, notes, created_by)
    select v_new_trip_id, title, category, estimated, null,
      currency, estimated_converted, null, exchange_rate,
      null, null, null, notes, v_owner_member
    from budget_entries where trip_id = p_source_trip_id;
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

-- Keep the RPC surface minimal (mirrors the hardening pass,
-- 20260719012632_hardening.sql): Supabase auto-grants EXECUTE on every new
-- function to public/anon/authenticated. Strip public + anon so a request with
-- no session at all cannot reach this SECURITY DEFINER function. `authenticated`
-- retains execute (granted directly by Supabase defaults, not via `public`), so
-- the Settings reuse flow is unaffected.
revoke execute on function public.duplicate_trip(
  uuid, text, date, date, boolean, boolean, boolean, boolean, boolean
) from public, anon;
