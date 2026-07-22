-- Wander: collaborative trip planner — initial schema
-- Identity model: everyone (owner via magic link, friends via anonymous
-- sign-in) has an auth.uid(). Membership of a trip is what grants access;
-- RLS policies below are the entire authorization layer.

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.generate_invite_code()
returns text
language sql
volatile
as $$
  -- 12 chars from an unambiguous alphabet (no 0/O/1/l)
  select string_agg(
    substr('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', (random() * 53)::int + 1, 1),
    ''
  ) from generate_series(1, 12);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  destination text,
  description text,
  cover_url text,
  start_date date,
  end_date date,
  estimated_budget numeric(12,2),
  currency text not null default 'USD',
  invite_code text not null unique default public.generate_invite_code(),
  invite_enabled boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  color text not null default '#0f766e',
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique (trip_id, user_id)
);

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  created_by uuid references public.members(id) on delete set null,
  question text not null,
  category text not null default 'general'
    check (category in ('dates','stay','flights','food','activities','transport','general')),
  closes_at timestamptz,
  closed boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.poll_options (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null,
  position int not null default 0
);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (poll_id, member_id)          -- one vote per member per poll
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  content text not null,
  reply_to uuid references public.messages(id) on delete set null,
  pinned boolean not null default false,
  edited_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  emoji text not null,
  unique (message_id, member_id, emoji)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  title text not null,
  body text,
  answered boolean not null default false,
  answer text,
  created_at timestamptz not null default now()
);

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null,
  notes text,
  assignee_id uuid references public.members(id) on delete set null,
  due_date date,
  done boolean not null default false,
  position double precision not null default 0,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null,
  category text not null default 'activity'
    check (category in ('flight','hotel','activity','restaurant','transport','free')),
  day date,
  start_time time,
  end_time time,
  location text,
  notes text,
  cost numeric(12,2),
  position double precision not null default 0,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.budget_entries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null,
  category text not null default 'other'
    check (category in ('stay','transport','food','activities','shopping','other')),
  estimated numeric(12,2),
  actual numeric(12,2),
  paid_by uuid references public.members(id) on delete set null,
  entry_date date,
  notes text,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.packing_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  category text not null default 'misc'
    check (category in ('clothes','toiletries','electronics','documents','misc')),
  packed boolean not null default false,
  added_by uuid references public.members(id) on delete set null,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null default 'Untitled',
  content text not null default '',
  pinned boolean not null default false,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inspiration_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text,
  url text,
  image_url text,
  note text,
  category text not null default 'general'
    check (category in ('stay','food','activities','places','general')),
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Lightweight event feed for the dashboard ("Maya voted on 'Where to stay?'")
create table public.activity (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  verb text not null,
  subject text,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

create index members_trip_idx on public.members (trip_id);
create index members_user_idx on public.members (user_id);
create index polls_trip_idx on public.polls (trip_id, created_at desc);
create index poll_options_poll_idx on public.poll_options (poll_id, position);
create index poll_options_trip_idx on public.poll_options (trip_id);
create index votes_poll_idx on public.votes (poll_id);
create index votes_trip_idx on public.votes (trip_id);
create index votes_option_idx on public.votes (option_id);
create index votes_member_idx on public.votes (member_id);
create index messages_trip_idx on public.messages (trip_id, created_at);
create index messages_member_idx on public.messages (member_id);
create index messages_reply_idx on public.messages (reply_to);
create index reactions_message_idx on public.message_reactions (message_id);
create index reactions_trip_idx on public.message_reactions (trip_id);
create index reactions_member_idx on public.message_reactions (member_id);
create index questions_trip_idx on public.questions (trip_id, created_at desc);
create index questions_member_idx on public.questions (member_id);
create index checklist_trip_idx on public.checklist_items (trip_id, position);
create index checklist_assignee_idx on public.checklist_items (assignee_id);
create index checklist_created_by_idx on public.checklist_items (created_by);
create index itinerary_trip_idx on public.itinerary_items (trip_id, day, position);
create index itinerary_created_by_idx on public.itinerary_items (created_by);
create index budget_trip_idx on public.budget_entries (trip_id, created_at desc);
create index budget_paid_by_idx on public.budget_entries (paid_by);
create index budget_created_by_idx on public.budget_entries (created_by);
create index packing_trip_idx on public.packing_items (trip_id, category, position);
create index packing_added_by_idx on public.packing_items (added_by);
create index notes_trip_idx on public.notes (trip_id, updated_at desc);
create index notes_created_by_idx on public.notes (created_by);
create index inspiration_trip_idx on public.inspiration_items (trip_id, created_at desc);
create index inspiration_created_by_idx on public.inspiration_items (created_by);
create index activity_trip_idx on public.activity (trip_id, created_at desc);
create index activity_member_idx on public.activity (member_id);
create index trips_owner_idx on public.trips (owner_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Authorization helpers
-- security definer so they can read members/trips without recursive RLS
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_trip_member(t uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from members
    where trip_id = t and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_trip_owner(t uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from trips
    where id = t and owner_id = (select auth.uid())
  );
$$;

-- The caller's members.id for a trip (used to pin authorship server-side)
create or replace function public.my_member_id(t uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select id from members
  where trip_id = t and user_id = (select auth.uid());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- Creating a trip atomically creates the owner's member row
create or replace function public.handle_new_trip()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select coalesce(nullif(split_part(email, '@', 1), ''), 'Owner')
    into v_name
    from auth.users where id = new.owner_id;
  insert into members (trip_id, user_id, display_name, role)
  values (new.id, new.owner_id, coalesce(v_name, 'Owner'), 'owner');
  return new;
end;
$$;

create trigger on_trip_created
  after insert on public.trips
  for each row execute function public.handle_new_trip();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Preview a trip by invite code (called from the join page, pre-membership)
create or replace function public.get_invite_preview(p_invite_code text)
returns table (trip_name text, destination text, cover_url text, member_count bigint, start_date date, end_date date)
language sql stable security definer
set search_path = public
as $$
  select t.name, t.destination, t.cover_url,
         (select count(*) from members m where m.trip_id = t.id),
         t.start_date, t.end_date
  from trips t
  where t.invite_code = p_invite_code
    and t.invite_enabled
    and not t.archived;
$$;

-- Join a trip via invite code. Validates the code server-side; the URL is the
-- only capability a friend needs. Idempotent for existing members.
create or replace function public.join_trip(p_invite_code text, p_display_name text, p_color text default null)
returns uuid
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_trip trips%rowtype;
  v_member_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into v_trip
  from trips
  where invite_code = p_invite_code and invite_enabled and not archived;

  if not found then
    raise exception 'INVALID_INVITE';
  end if;

  select id into v_member_id
  from members
  where trip_id = v_trip.id and user_id = (select auth.uid());
  if found then
    return v_trip.id;              -- already a member: just enter
  end if;

  if p_display_name is null or length(trim(p_display_name)) < 1 then
    raise exception 'NAME_REQUIRED';
  end if;

  insert into members (trip_id, user_id, display_name, color)
  values (v_trip.id, (select auth.uid()), left(trim(p_display_name), 40), coalesce(p_color, '#0f766e'))
  returning id into v_member_id;

  insert into activity (trip_id, member_id, verb)
  values (v_trip.id, v_member_id, 'joined the trip');

  return v_trip.id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.trips enable row level security;
alter table public.members enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.votes enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.questions enable row level security;
alter table public.checklist_items enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.budget_entries enable row level security;
alter table public.packing_items enable row level security;
alter table public.notes enable row level security;
alter table public.inspiration_items enable row level security;
alter table public.activity enable row level security;

-- trips ──────────────────────────────────────────────────────────────────────
create policy trips_select on public.trips for select
  using (owner_id = (select auth.uid()) or is_trip_member(id));

-- Only real (non-anonymous) users can create trips
create policy trips_insert on public.trips for insert
  with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

create policy trips_update on public.trips for update
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy trips_delete on public.trips for delete
  using (owner_id = (select auth.uid()));

-- members ────────────────────────────────────────────────────────────────────
create policy members_select on public.members for select
  using (is_trip_member(trip_id));

-- Friends join only through join_trip() (security definer bypasses RLS);
-- the owner's row is created by the on_trip_created trigger.
-- Direct inserts are therefore never allowed.

-- Editing profile (name/colour) is column-restricted below; row access:
create policy members_update on public.members for update
  using (user_id = (select auth.uid()) or is_trip_owner(trip_id))
  with check (user_id = (select auth.uid()) or is_trip_owner(trip_id));

-- Owner removes members; members may leave. The owner row is undeletable.
create policy members_delete on public.members for delete
  using (role = 'member' and (user_id = (select auth.uid()) or is_trip_owner(trip_id)));

-- Column-level guard: nobody can flip `role` or move rows between trips
revoke update on public.members from authenticated, anon;
grant update (display_name, color) on public.members to authenticated;

-- polls ──────────────────────────────────────────────────────────────────────
create policy polls_select on public.polls for select
  using (is_trip_member(trip_id));
create policy polls_insert on public.polls for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy polls_update on public.polls for update
  using (is_trip_member(trip_id) and (created_by = my_member_id(trip_id) or is_trip_owner(trip_id)));
create policy polls_delete on public.polls for delete
  using (is_trip_member(trip_id) and (created_by = my_member_id(trip_id) or is_trip_owner(trip_id)));

-- poll_options (managed by the poll's creator or the owner) ─────────────────
create policy poll_options_select on public.poll_options for select
  using (is_trip_member(trip_id));
create policy poll_options_insert on public.poll_options for insert
  with check (
    is_trip_member(trip_id)
    and exists (
      select 1 from public.polls p
      where p.id = poll_id
        and (p.created_by = my_member_id(p.trip_id) or is_trip_owner(p.trip_id))
    )
  );
create policy poll_options_delete on public.poll_options for delete
  using (
    exists (
      select 1 from public.polls p
      where p.id = poll_id
        and (p.created_by = my_member_id(p.trip_id) or is_trip_owner(p.trip_id))
    )
  );

-- votes (always your own; unique index enforces one per poll) ───────────────
create policy votes_select on public.votes for select
  using (is_trip_member(trip_id));
create policy votes_insert on public.votes for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy votes_update on public.votes for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));
create policy votes_delete on public.votes for delete
  using (member_id = my_member_id(trip_id));

-- messages (edit your own; owner may delete any; owner pins) ────────────────
create policy messages_select on public.messages for select
  using (is_trip_member(trip_id));
create policy messages_insert on public.messages for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy messages_update on public.messages for update
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));
create policy messages_delete on public.messages for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- reactions ──────────────────────────────────────────────────────────────────
create policy reactions_select on public.message_reactions for select
  using (is_trip_member(trip_id));
create policy reactions_insert on public.message_reactions for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy reactions_delete on public.message_reactions for delete
  using (member_id = my_member_id(trip_id));

-- Collaborative content: any member may update (mark done/packed/answered,
-- reorder, edit shared notes); delete is creator-or-owner.
-- questions
create policy questions_select on public.questions for select
  using (is_trip_member(trip_id));
create policy questions_insert on public.questions for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy questions_update on public.questions for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy questions_delete on public.questions for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- checklist
create policy checklist_select on public.checklist_items for select
  using (is_trip_member(trip_id));
create policy checklist_insert on public.checklist_items for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy checklist_update on public.checklist_items for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy checklist_delete on public.checklist_items for delete
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- itinerary
create policy itinerary_select on public.itinerary_items for select
  using (is_trip_member(trip_id));
create policy itinerary_insert on public.itinerary_items for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy itinerary_update on public.itinerary_items for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy itinerary_delete on public.itinerary_items for delete
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- budget
create policy budget_select on public.budget_entries for select
  using (is_trip_member(trip_id));
create policy budget_insert on public.budget_entries for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy budget_update on public.budget_entries for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy budget_delete on public.budget_entries for delete
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- packing
create policy packing_select on public.packing_items for select
  using (is_trip_member(trip_id));
create policy packing_insert on public.packing_items for insert
  with check (is_trip_member(trip_id) and added_by = my_member_id(trip_id));
create policy packing_update on public.packing_items for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy packing_delete on public.packing_items for delete
  using (added_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- notes (shared editing)
create policy notes_select on public.notes for select
  using (is_trip_member(trip_id));
create policy notes_insert on public.notes for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy notes_update on public.notes for update
  using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
create policy notes_delete on public.notes for delete
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- inspiration
create policy inspiration_select on public.inspiration_items for select
  using (is_trip_member(trip_id));
create policy inspiration_insert on public.inspiration_items for insert
  with check (is_trip_member(trip_id) and created_by = my_member_id(trip_id));
create policy inspiration_delete on public.inspiration_items for delete
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- activity (append-only feed)
create policy activity_select on public.activity for select
  using (is_trip_member(trip_id));
create policy activity_insert on public.activity for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy activity_delete on public.activity for delete
  using (is_trip_owner(trip_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: broadcast row changes (RLS still applies per subscriber)
-- ─────────────────────────────────────────────────────────────────────────────

alter publication supabase_realtime add table
  public.trips, public.members, public.polls, public.poll_options,
  public.votes, public.messages, public.message_reactions, public.questions,
  public.checklist_items, public.itinerary_items, public.budget_entries,
  public.packing_items, public.notes, public.inspiration_items, public.activity;
