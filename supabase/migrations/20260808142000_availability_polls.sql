-- Wander: date-range availability poll — epic #175, slice 1 (issue #176)
--
-- The earliest group question — "which dates actually work for everyone?" —
-- today happens in a group chat or an external tool (when2meet/Doodle), and
-- only the outcome is typed into Wander. This brings that step inside: the
-- owner proposes candidate date ranges, every member marks each yes/maybe/no
-- using their existing anonymous-friend identity (no account), the group sees
-- the overlap, and the owner applies the winning range to the trip's real
-- `start_date`/`end_date` in one action so itinerary/calendar/weather/countdown
-- light up from the agreed answer.
--
-- Deliberately a NEW set of tables, not a `polls` subtype: existing polls (one
-- vote per member, single option) are untouched, and availability is a
-- different shape — a per-member, three-state response for every candidate.
-- Modeled on the polls RLS shape: owner creates the poll + candidates, each
-- member writes only their own availability row, one row per member per
-- candidate. "Apply dates" is a SECURITY DEFINER RPC that validates the caller
-- is the owner (the join_trip pattern), never a client-side trips update.

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table public.availability_polls (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  created_by uuid references public.members(id) on delete set null,
  title text not null,
  closed boolean not null default false,
  -- The candidate whose range was applied to the trip. A soft pointer (nullable,
  -- no FK — same choice as notifications.entity_id) so it survives the candidate
  -- being deleted and avoids a circular FK with availability_candidates. Set by
  -- the apply_availability_dates RPC; drives the "Applied to trip" badge.
  applied_candidate_id uuid,
  created_at timestamptz not null default now()
);

create table public.availability_candidates (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  poll_id uuid not null references public.availability_polls(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table public.availability_responses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  poll_id uuid not null references public.availability_polls(id) on delete cascade,
  candidate_id uuid not null references public.availability_candidates(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  status text not null check (status in ('yes', 'maybe', 'no')),
  created_at timestamptz not null default now(),
  unique (candidate_id, member_id)   -- one response per member per candidate
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

create index availability_polls_trip_idx on public.availability_polls (trip_id, created_at desc);
create index availability_candidates_poll_idx on public.availability_candidates (poll_id, position);
create index availability_candidates_trip_idx on public.availability_candidates (trip_id);
create index availability_responses_poll_idx on public.availability_responses (poll_id);
create index availability_responses_candidate_idx on public.availability_responses (candidate_id);
create index availability_responses_member_idx on public.availability_responses (member_id);
create index availability_responses_trip_idx on public.availability_responses (trip_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Apply winning dates — SECURITY DEFINER, owner-only, validates its inputs
-- (the join_trip pattern). This is the only way availability results write the
-- trip's real dates; there is no client-side trips update path for it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.apply_availability_dates(p_poll_id uuid, p_candidate_id uuid)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_poll public.availability_polls%rowtype;
  v_candidate public.availability_candidates%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into v_poll from availability_polls where id = p_poll_id;
  if not found then
    raise exception 'POLL_NOT_FOUND';
  end if;

  -- Owner-only, enforced in Postgres — not merely hidden in the UI.
  if not is_trip_owner(v_poll.trip_id) then
    raise exception 'NOT_OWNER';
  end if;

  select * into v_candidate
  from availability_candidates
  where id = p_candidate_id and poll_id = p_poll_id;
  if not found then
    raise exception 'CANDIDATE_NOT_FOUND';
  end if;

  update trips
  set start_date = v_candidate.start_date,
      end_date = v_candidate.end_date
  where id = v_poll.trip_id;

  update availability_polls
  set closed = true,
      applied_candidate_id = p_candidate_id
  where id = p_poll_id;

  insert into activity (trip_id, member_id, verb, subject)
  values (v_poll.trip_id, my_member_id(v_poll.trip_id), 'set the trip dates from', v_poll.title);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.availability_polls enable row level security;
alter table public.availability_candidates enable row level security;
alter table public.availability_responses enable row level security;

-- availability_polls — any member reads; only the owner creates/updates/deletes.
create policy availability_polls_select on public.availability_polls for select
  using (is_trip_member(trip_id));
create policy availability_polls_insert on public.availability_polls for insert
  with check (is_trip_owner(trip_id) and created_by = my_member_id(trip_id));
create policy availability_polls_update on public.availability_polls for update
  using (is_trip_owner(trip_id))
  with check (is_trip_owner(trip_id));
create policy availability_polls_delete on public.availability_polls for delete
  using (is_trip_owner(trip_id));

-- availability_candidates — managed by the owner (the poll's author); readable
-- by every member. No update path: candidates are immutable once proposed.
create policy availability_candidates_select on public.availability_candidates for select
  using (is_trip_member(trip_id));
create policy availability_candidates_insert on public.availability_candidates for insert
  with check (
    is_trip_owner(trip_id)
    and exists (
      select 1 from public.availability_polls p
      where p.id = poll_id and p.trip_id = trip_id
    )
  );
create policy availability_candidates_delete on public.availability_candidates for delete
  using (is_trip_owner(trip_id));

-- availability_responses — a member writes only their OWN availability; the
-- unique(candidate_id, member_id) index enforces one row per member per
-- candidate. This is what makes "members write only their own" a database fact.
create policy availability_responses_select on public.availability_responses for select
  using (is_trip_member(trip_id));
create policy availability_responses_insert on public.availability_responses for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy availability_responses_update on public.availability_responses for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));
create policy availability_responses_delete on public.availability_responses for delete
  using (member_id = my_member_id(trip_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publication decision: YES. Availability is inherently collaborative —
-- the overlap counts and the best-option highlight must update live as members
-- mark their dates, on whatever device they have open. RLS still applies per
-- subscriber, exactly like the other content tables.
-- ─────────────────────────────────────────────────────────────────────────────

alter publication supabase_realtime add table
  public.availability_polls, public.availability_candidates, public.availability_responses;
