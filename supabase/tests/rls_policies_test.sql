-- ─────────────────────────────────────────────────────────────────────────────
-- Wander — RLS regression tests (plain SQL)
--
-- Guardrail #1 (ARCHITECTURE.md §2, routines/README.md): "RLS is the security
-- boundary. The client is never trusted." These policies are the *entire*
-- authorization layer, yet a future migration could silently weaken one with no
-- automated signal. This file is that signal: it asserts the permission matrix
-- documented in ARCHITECTURE.md, table by table, and fails loudly on regression.
--
-- WHAT IT COVERS (every content table in supabase/migrations/*_init.sql):
--   • trip isolation — a non-member sees zero rows and can write nothing
--   • membership gate — a member sees the trip's rows and may create content
--   • cross-trip isolation — a member of trip A cannot see trip B
--   • the invite capability — the code is unreadable to non-members; join_trip
--     is the only join path; get_invite_preview honours enabled/archived
--   • owner-only powers — edit/delete trip, remove members, delete activity
--   • role immutability — a member cannot escalate themselves to owner
--   • creator-or-owner delete vs any-member update on collaborative content
--   • votes/messages/reactions/activity authorship pinned to the caller
--
-- HOW IT WORKS
--   The whole file runs inside one transaction that ROLLS BACK at the end, so it
--   leaves no residue and is safe to run repeatedly against any Supabase project
--   (local stack or a scratch/staging project). It seeds its own auth.users and
--   trip fixtures as the `postgres` superuser, then exercises every policy while
--   impersonating each test user via `set role authenticated` + a synthetic
--   `request.jwt.claims` (exactly what auth.uid()/auth.jwt() read at runtime).
--   Every assertion appends to a temp results table; the final block RAISES if
--   any assertion failed, so the process exits non-zero on a policy regression.
--
-- HOW TO RUN (see supabase/tests/README.md for detail)
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_policies_test.sql
--   A clean run prints "RLS regression suite: N/N passed" and exits 0.
--   Any failure prints the failing checks and exits 1.
--
-- NOTE ON ENVIRONMENT: the tests assume the Supabase role baseline — the
-- `authenticated` role holds the default table/function grants Supabase
-- provisions, and RLS is what scopes access. A denied WRITE therefore surfaces
-- as an RLS error (captured as rowcount -1); a denied UPDATE/DELETE that matches
-- no rows surfaces as rowcount 0. Both are treated as "denied" below.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── Results collector ───────────────────────────────────────────────────────
create temp table _rls_results (
  id      serial primary key,
  name    text    not null,
  passed  boolean not null,
  got     text,
  want    text
) on commit drop;

create function pg_temp.rec(p_name text, p_got text, p_want text) returns void
language plpgsql as $$
begin
  insert into _rls_results(name, passed, got, want)
  values (p_name, p_got is not distinct from p_want, p_got, p_want);
end $$;

-- ── Impersonation helpers ────────────────────────────────────────────────────
-- Run a query AS a given user. We set the JWT claims auth.uid()/auth.jwt() read,
-- switch to the unprivileged `authenticated` role so RLS is enforced (the
-- postgres superuser and table owners bypass RLS), run the statement, then
-- always restore the superuser role for the next assertion.

-- Scalar SELECT as a user → returns the value, or -1 if the statement raised
-- (e.g. a SELECT of a SECURITY DEFINER RPC that validates its input).
create function pg_temp.as_user_count(p_uid uuid, p_is_anon boolean, p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated',
                      'is_anonymous', p_is_anon)::text, true);
  set local role authenticated;
  begin
    execute p_sql into n;
  exception when others then
    reset role;
    return -1;
  end;
  reset role;
  return n;
end $$;

-- DML as a user → affected row count, or -1 if the statement raised.
-- Denied INSERT (WITH CHECK) raises → -1. Denied UPDATE/DELETE matches the
-- policy's USING clause to zero rows → 0. Allowed write → the real rowcount.
create function pg_temp.as_user_dml(p_uid uuid, p_is_anon boolean, p_sql text)
returns integer language plpgsql as $$
declare rc integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated',
                      'is_anonymous', p_is_anon)::text, true);
  set local role authenticated;
  begin
    execute p_sql;
    get diagnostics rc = row_count;
  exception when others then
    reset role;
    return -1;
  end;
  reset role;
  return rc;
end $$;

-- Convenience assertions -------------------------------------------------------
create function pg_temp.expect_count(
  p_name text, p_uid uuid, p_is_anon boolean, p_sql text, p_want bigint) returns void
language plpgsql as $$
begin
  perform pg_temp.rec(p_name, pg_temp.as_user_count(p_uid, p_is_anon, p_sql)::text, p_want::text);
end $$;

create function pg_temp.expect_dml(
  p_name text, p_uid uuid, p_is_anon boolean, p_sql text, p_want integer) returns void
language plpgsql as $$
begin
  perform pg_temp.rec(p_name, pg_temp.as_user_dml(p_uid, p_is_anon, p_sql)::text, p_want::text);
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Test principals. uA/uB own trips; uF/uG are members of trip A; uX is a
-- signed-in outsider (member of nothing); uJ joins via the invite RPC.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('aaaa0000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ownera@wander.test', '', now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ownerb@wander.test', '', now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}'),
  ('aaaa0000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}')
on conflict (id) do nothing;

-- Trip A (owner uA), Trip B (owner uB, invite DISABLED), Trip C (owner uA,
-- throwaway for the owner-delete test). The on_trip_created trigger creates each
-- owner's member row automatically.
insert into public.trips (id, owner_id, name, invite_code, invite_enabled) values
  ('bbbb0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000001', 'Trip A', 'invitecodeAAAA', true),
  ('bbbb0000-0000-0000-0000-000000000002', 'aaaa0000-0000-0000-0000-000000000004', 'Trip B', 'invitecodeBBBB', false),
  ('bbbb0000-0000-0000-0000-000000000003', 'aaaa0000-0000-0000-0000-000000000001', 'Trip C', 'invitecodeCCCC', true);

-- Members of Trip A. uF/uG are the working members (used throughout); uH/uI are
-- disposable — the "leave" and "owner removes member" tests consume them so the
-- working members stay alive for later sections. Owner row id fetched via subquery.
insert into public.members (id, trip_id, user_id, display_name, role) values
  ('cccc0000-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000002', 'Friend F', 'member'),
  ('cccc0000-0000-0000-0000-000000000003', 'bbbb0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000003', 'Friend G', 'member'),
  ('cccc0000-0000-0000-0000-000000000004', 'bbbb0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000007', 'Friend H', 'member'),
  ('cccc0000-0000-0000-0000-000000000005', 'bbbb0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000008', 'Friend I', 'member');

-- Content in Trip A, authored by member F (unless noted). These give members
-- something to see and give the delete/update tests concrete targets.
insert into public.polls (id, trip_id, created_by, question) values
  ('dddd0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'Poll by F'),
  ('dddd0000-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'Second poll by F'),
  ('dddd0000-0000-0000-0000-000000000003', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000003', 'Poll by G');
insert into public.poll_options (id, trip_id, poll_id, label) values
  ('dddd0000-0000-0000-0000-000000000004', 'bbbb0000-0000-0000-0000-000000000001', 'dddd0000-0000-0000-0000-000000000001', 'Option 1');
insert into public.votes (id, trip_id, poll_id, option_id, member_id) values
  ('dddd0000-0000-0000-0000-000000000005', 'bbbb0000-0000-0000-0000-000000000001', 'dddd0000-0000-0000-0000-000000000001', 'dddd0000-0000-0000-0000-000000000004', 'cccc0000-0000-0000-0000-000000000002');
insert into public.messages (id, trip_id, member_id, content) values
  ('dddd0000-0000-0000-0000-000000000006', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'Hello from F');
insert into public.message_reactions (id, trip_id, message_id, member_id, emoji) values
  ('dddd0000-0000-0000-0000-000000000007', 'bbbb0000-0000-0000-0000-000000000001', 'dddd0000-0000-0000-0000-000000000006', 'cccc0000-0000-0000-0000-000000000002', '👍');
insert into public.questions (id, trip_id, member_id, title) values
  ('dddd0000-0000-0000-0000-000000000008', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'Question by F');
insert into public.checklist_items (id, trip_id, title, created_by) values
  ('dddd0000-0000-0000-0000-000000000009', 'bbbb0000-0000-0000-0000-000000000001', 'Checklist by F', 'cccc0000-0000-0000-0000-000000000002');
insert into public.itinerary_items (id, trip_id, title, created_by) values
  ('dddd0000-0000-0000-0000-00000000000a', 'bbbb0000-0000-0000-0000-000000000001', 'Itinerary by F', 'cccc0000-0000-0000-0000-000000000002');
insert into public.budget_entries (id, trip_id, title, created_by) values
  ('dddd0000-0000-0000-0000-00000000000b', 'bbbb0000-0000-0000-0000-000000000001', 'Budget by F', 'cccc0000-0000-0000-0000-000000000002');
insert into public.packing_items (id, trip_id, name, added_by) values
  ('dddd0000-0000-0000-0000-00000000000c', 'bbbb0000-0000-0000-0000-000000000001', 'Packing by F', 'cccc0000-0000-0000-0000-000000000002');
insert into public.notes (id, trip_id, title, created_by) values
  ('dddd0000-0000-0000-0000-00000000000d', 'bbbb0000-0000-0000-0000-000000000001', 'Note by F', 'cccc0000-0000-0000-0000-000000000002');
insert into public.inspiration_items (id, trip_id, title, created_by) values
  ('dddd0000-0000-0000-0000-00000000000e', 'bbbb0000-0000-0000-0000-000000000001', 'Inspiration by F', 'cccc0000-0000-0000-0000-000000000002');
insert into public.activity (id, trip_id, member_id, verb) values
  ('dddd0000-0000-0000-0000-00000000000f', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'did a thing');

-- A poll and a message in Trip B, to prove cross-trip isolation.
insert into public.polls (id, trip_id, created_by, question) values
  ('eeee0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000002',
   (select id from public.members where trip_id = 'bbbb0000-0000-0000-0000-000000000002'), 'Poll in B');

-- Handy uuids reused below.
--   uA=..01 uF=..02 uG=..03 uB=..04 uX=..05 uJ=..06
--   tA=bbbb..01 tB=bbbb..02 tC=bbbb..03

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. SELECT isolation — a signed-in outsider (uX) sees ZERO rows of trip A,
--    across every content table. This is the core "invite code is the only
--    capability" property: without membership the whole trip is invisible.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_count('trips: outsider sees no trip',            'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from trips where id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('members: outsider sees no members',       'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from members where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('polls: outsider sees no polls',           'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from polls where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('poll_options: outsider sees none',        'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from poll_options where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('votes: outsider sees none',               'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from votes where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('messages: outsider sees none',            'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from messages where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('message_reactions: outsider sees none',   'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from message_reactions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('questions: outsider sees none',           'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from questions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('checklist_items: outsider sees none',     'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from checklist_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('itinerary_items: outsider sees none',     'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from itinerary_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('budget_entries: outsider sees none',      'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from budget_entries where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('packing_items: outsider sees none',       'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from packing_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('notes: outsider sees none',               'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from notes where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('inspiration_items: outsider sees none',   'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from inspiration_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('activity: outsider sees none',            'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from activity where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. SELECT membership — member F sees the trip and its seeded content, on
--    every table. Proves the `is_trip_member` select policies grant access.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_count('trips: member sees the trip',             'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from trips where id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('members: member sees all members',        'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from members where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 5);
select pg_temp.expect_count('polls: member sees polls',                'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from polls where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 3);
select pg_temp.expect_count('poll_options: member sees options',       'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from poll_options where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('votes: member sees votes',                'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from votes where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('messages: member sees messages',          'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from messages where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('message_reactions: member sees reactions','aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from message_reactions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('questions: member sees questions',        'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from questions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('checklist_items: member sees items',      'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from checklist_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('itinerary_items: member sees items',      'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from itinerary_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('budget_entries: member sees entries',     'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from budget_entries where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('packing_items: member sees items',        'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from packing_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('notes: member sees notes',                'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from notes where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('inspiration_items: member sees items',    'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from inspiration_items where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('activity: member sees feed',              'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from activity where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Cross-trip isolation — member F (trip A) cannot see trip B or its content.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_count('cross-trip: A-member cannot see trip B',  'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from trips where id='bbbb0000-0000-0000-0000-000000000002'$$, 0);
select pg_temp.expect_count('cross-trip: A-member cannot see B polls',  'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from polls where trip_id='bbbb0000-0000-0000-0000-000000000002'$$, 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Write gate — a non-member (uX) cannot INSERT into any content table, even
--    with an otherwise-valid payload (correct trip_id, real member_id). The
--    only thing missing is membership, so RLS is the sole reason for denial.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('polls: outsider cannot insert',            'aaaa0000-0000-0000-0000-000000000005', false, $$insert into polls(trip_id, created_by, question) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','x')$$, -1);
select pg_temp.expect_dml('poll_options: outsider cannot insert',     'aaaa0000-0000-0000-0000-000000000005', false, $$insert into poll_options(trip_id, poll_id, label) values('bbbb0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000001','x')$$, -1);
select pg_temp.expect_dml('votes: outsider cannot insert',            'aaaa0000-0000-0000-0000-000000000005', false, $$insert into votes(trip_id, poll_id, option_id, member_id) values('bbbb0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000004','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('messages: outsider cannot insert',         'aaaa0000-0000-0000-0000-000000000005', false, $$insert into messages(trip_id, member_id, content) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','x')$$, -1);
select pg_temp.expect_dml('reactions: outsider cannot insert',        'aaaa0000-0000-0000-0000-000000000005', false, $$insert into message_reactions(trip_id, message_id, member_id, emoji) values('bbbb0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000006','cccc0000-0000-0000-0000-000000000002','😀')$$, -1);
select pg_temp.expect_dml('questions: outsider cannot insert',        'aaaa0000-0000-0000-0000-000000000005', false, $$insert into questions(trip_id, member_id, title) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','x')$$, -1);
select pg_temp.expect_dml('checklist: outsider cannot insert',        'aaaa0000-0000-0000-0000-000000000005', false, $$insert into checklist_items(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','x','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('itinerary: outsider cannot insert',        'aaaa0000-0000-0000-0000-000000000005', false, $$insert into itinerary_items(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','x','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('budget: outsider cannot insert',          'aaaa0000-0000-0000-0000-000000000005', false, $$insert into budget_entries(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','x','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('packing: outsider cannot insert',         'aaaa0000-0000-0000-0000-000000000005', false, $$insert into packing_items(trip_id, name, added_by) values('bbbb0000-0000-0000-0000-000000000001','x','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('notes: outsider cannot insert',           'aaaa0000-0000-0000-0000-000000000005', false, $$insert into notes(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','x','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('inspiration: outsider cannot insert',     'aaaa0000-0000-0000-0000-000000000005', false, $$insert into inspiration_items(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','x','cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('activity: outsider cannot insert',        'aaaa0000-0000-0000-0000-000000000005', false, $$insert into activity(trip_id, member_id, verb) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','x')$$, -1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Member writes — member F CAN create content on every writable table, with
--    authorship pinned to their own member id (my_member_id).
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('polls: member can insert',           'aaaa0000-0000-0000-0000-000000000002', false, $$insert into polls(trip_id, created_by, question) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','new')$$, 1);
select pg_temp.expect_dml('messages: member can insert',        'aaaa0000-0000-0000-0000-000000000002', false, $$insert into messages(trip_id, member_id, content) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','hi')$$, 1);
select pg_temp.expect_dml('checklist: member can insert',       'aaaa0000-0000-0000-0000-000000000002', false, $$insert into checklist_items(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','todo','cccc0000-0000-0000-0000-000000000002')$$, 1);
select pg_temp.expect_dml('itinerary: member can insert',       'aaaa0000-0000-0000-0000-000000000002', false, $$insert into itinerary_items(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','see','cccc0000-0000-0000-0000-000000000002')$$, 1);
select pg_temp.expect_dml('budget: member can insert',          'aaaa0000-0000-0000-0000-000000000002', false, $$insert into budget_entries(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','cost','cccc0000-0000-0000-0000-000000000002')$$, 1);
select pg_temp.expect_dml('notes: member can insert',           'aaaa0000-0000-0000-0000-000000000002', false, $$insert into notes(trip_id, title, created_by) values('bbbb0000-0000-0000-0000-000000000001','memo','cccc0000-0000-0000-0000-000000000002')$$, 1);
select pg_temp.expect_dml('activity: member can insert',        'aaaa0000-0000-0000-0000-000000000002', false, $$insert into activity(trip_id, member_id, verb) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','noted')$$, 1);

-- A member cannot forge authorship as ANOTHER member (my_member_id gate).
select pg_temp.expect_dml('messages: member cannot post as another member', 'aaaa0000-0000-0000-0000-000000000002', false, $$insert into messages(trip_id, member_id, content) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','forged')$$, -1);
select pg_temp.expect_dml('votes: member cannot vote as another member',    'aaaa0000-0000-0000-0000-000000000002', false, $$insert into votes(trip_id, poll_id, option_id, member_id) values('bbbb0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000004','cccc0000-0000-0000-0000-000000000003')$$, -1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Trips — creation is real-users-only; edit and delete are owner-only.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('trips: anonymous user cannot create a trip', 'aaaa0000-0000-0000-0000-000000000005', true,  $$insert into trips(owner_id, name) values('aaaa0000-0000-0000-0000-000000000005','Anon trip')$$, -1);
select pg_temp.expect_dml('trips: real user can create a trip',         'aaaa0000-0000-0000-0000-000000000005', false, $$insert into trips(owner_id, name) values('aaaa0000-0000-0000-0000-000000000005','Real trip')$$, 1);
select pg_temp.expect_dml('trips: member cannot rename the trip',       'aaaa0000-0000-0000-0000-000000000002', false, $$update trips set name='hijack' where id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('trips: owner can rename the trip',           'aaaa0000-0000-0000-0000-000000000001', false, $$update trips set name='Trip A renamed' where id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_dml('trips: member cannot delete the trip',       'aaaa0000-0000-0000-0000-000000000002', false, $$delete from trips where id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('trips: owner can delete their trip',         'aaaa0000-0000-0000-0000-000000000001', false, $$delete from trips where id='bbbb0000-0000-0000-0000-000000000003'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Members — profile self-service, role immutability, owner-only removal.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('members: cannot insert directly (join_trip only)', 'aaaa0000-0000-0000-0000-000000000005', false, $$insert into members(trip_id, user_id, display_name) values('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000005','Sneak')$$, -1);
select pg_temp.expect_dml('members: member can rename themselves',            'aaaa0000-0000-0000-0000-000000000002', false, $$update members set display_name='F renamed' where id='cccc0000-0000-0000-0000-000000000002'$$, 1);
select pg_temp.expect_dml('members: member cannot escalate to owner',         'aaaa0000-0000-0000-0000-000000000002', false, $$update members set role='owner' where id='cccc0000-0000-0000-0000-000000000002'$$, -1);
select pg_temp.expect_dml('members: non-owner cannot remove another member',  'aaaa0000-0000-0000-0000-000000000002', false, $$delete from members where id='cccc0000-0000-0000-0000-000000000005'$$, 0);
select pg_temp.expect_dml('members: member can leave (delete own row)',       'aaaa0000-0000-0000-0000-000000000007', false, $$delete from members where id='cccc0000-0000-0000-0000-000000000004'$$, 1);
select pg_temp.expect_dml('members: owner can remove a member',               'aaaa0000-0000-0000-0000-000000000001', false, $$delete from members where id='cccc0000-0000-0000-0000-000000000005'$$, 1);
select pg_temp.expect_dml('members: owner cannot be deleted (owner row)',     'aaaa0000-0000-0000-0000-000000000001', false, $$delete from members where trip_id='bbbb0000-0000-0000-0000-000000000001' and role='owner'$$, 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- 7b. Member trip dates (#286) — a member sets ONLY their own arrival/departure
--     dates; the owner may set anyone's; the values are bounded by the trip's
--     own date range and by arrives_on ≤ departs_on. The security property under
--     test is the same single-writer rule as the profile: `members_update` +
--     the extended column grant let F write F's row and the owner write any
--     row, and nothing lets F write G's.
-- ═════════════════════════════════════════════════════════════════════════════
-- Give Trip A a concrete date window so the range trigger has something to bound.
update public.trips set start_date='2026-09-01', end_date='2026-09-10'
  where id='bbbb0000-0000-0000-0000-000000000001';

-- A member CAN set their own dates within the trip window (proves the column
-- grant now covers arrives_on/departs_on — without it this would be denied).
select pg_temp.expect_dml('member dates: member can set own dates in range',       'aaaa0000-0000-0000-0000-000000000002', false, $$update members set arrives_on='2026-09-03', departs_on='2026-09-08' where id='cccc0000-0000-0000-0000-000000000002'$$, 1);
-- The trip-range trigger rejects a date before the trip start or after its end.
select pg_temp.expect_dml('member dates: arrival before trip start is rejected',   'aaaa0000-0000-0000-0000-000000000002', false, $$update members set arrives_on='2026-08-20' where id='cccc0000-0000-0000-0000-000000000002'$$, -1);
select pg_temp.expect_dml('member dates: departure after trip end is rejected',    'aaaa0000-0000-0000-0000-000000000002', false, $$update members set departs_on='2026-09-20' where id='cccc0000-0000-0000-0000-000000000002'$$, -1);
-- The same-row CHECK rejects a departure before the arrival.
select pg_temp.expect_dml('member dates: departure before arrival is rejected',    'aaaa0000-0000-0000-0000-000000000002', false, $$update members set departs_on='2026-09-02' where id='cccc0000-0000-0000-0000-000000000002'$$, -1);
-- THE KEY CHECK: a member cannot write ANOTHER member's dates (row USING denies
-- → zero rows), even though the column grant permits the columns.
select pg_temp.expect_dml('member dates: member cannot set another member''s dates','aaaa0000-0000-0000-0000-000000000002', false, $$update members set arrives_on='2026-09-04' where id='cccc0000-0000-0000-0000-000000000003'$$, 0);
-- The owner CAN set any member's dates (is_trip_owner branch of members_update).
select pg_temp.expect_dml('member dates: owner can set a member''s dates',          'aaaa0000-0000-0000-0000-000000000001', false, $$update members set arrives_on='2026-09-05', departs_on='2026-09-09' where id='cccc0000-0000-0000-0000-000000000003'$$, 1);
-- A member can clear their own dates back to "here the whole trip".
select pg_temp.expect_dml('member dates: member can clear own dates',              'aaaa0000-0000-0000-0000-000000000002', false, $$update members set arrives_on=null, departs_on=null where id='cccc0000-0000-0000-0000-000000000002'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Collaborative content — ANY member may UPDATE (mark done/answered, reorder,
--    edit shared notes), but DELETE is creator-or-owner only. This asymmetry is
--    a deliberate, regression-prone design choice; assert both halves.
-- ═════════════════════════════════════════════════════════════════════════════
-- Any member (G) may update another member's (F's) content:
select pg_temp.expect_dml('checklist: any member can update',   'aaaa0000-0000-0000-0000-000000000003', false, $$update checklist_items set done=true where id='dddd0000-0000-0000-0000-000000000009'$$, 1);
select pg_temp.expect_dml('itinerary: any member can update',   'aaaa0000-0000-0000-0000-000000000003', false, $$update itinerary_items set notes='edited' where id='dddd0000-0000-0000-0000-00000000000a'$$, 1);
select pg_temp.expect_dml('questions: any member can answer',   'aaaa0000-0000-0000-0000-000000000003', false, $$update questions set answered=true where id='dddd0000-0000-0000-0000-000000000008'$$, 1);
select pg_temp.expect_dml('notes: any member can edit',         'aaaa0000-0000-0000-0000-000000000003', false, $$update notes set content='shared edit' where id='dddd0000-0000-0000-0000-00000000000d'$$, 1);

-- Budget entries are the exception: financial (settle-up) data, NOT shared
-- editing. #161 pins UPDATE to creator-or-owner, matching DELETE, so a
-- non-creator, non-owner member (G) may NOT alter F's expense through the API
-- (denied UPDATE matches zero rows via the USING clause → 0)...
select pg_temp.expect_dml('budget: non-creator member cannot update', 'aaaa0000-0000-0000-0000-000000000003', false, $$update budget_entries set actual=999 where id='dddd0000-0000-0000-0000-00000000000b'$$, 0);
-- ...but the creator (F) and the trip owner (A) still can.
select pg_temp.expect_dml('budget: creator can update own entry',     'aaaa0000-0000-0000-0000-000000000002', false, $$update budget_entries set actual=42 where id='dddd0000-0000-0000-0000-00000000000b'$$, 1);
select pg_temp.expect_dml('budget: owner can update member entry',    'aaaa0000-0000-0000-0000-000000000001', false, $$update budget_entries set actual=43 where id='dddd0000-0000-0000-0000-00000000000b'$$, 1);

-- A non-creator, non-owner member (G) may NOT delete F's content:
select pg_temp.expect_dml('checklist: non-creator cannot delete',   'aaaa0000-0000-0000-0000-000000000003', false, $$delete from checklist_items where id='dddd0000-0000-0000-0000-000000000009'$$, 0);
select pg_temp.expect_dml('itinerary: non-creator cannot delete',   'aaaa0000-0000-0000-0000-000000000003', false, $$delete from itinerary_items where id='dddd0000-0000-0000-0000-00000000000a'$$, 0);
select pg_temp.expect_dml('budget: non-creator cannot delete',      'aaaa0000-0000-0000-0000-000000000003', false, $$delete from budget_entries where id='dddd0000-0000-0000-0000-00000000000b'$$, 0);
select pg_temp.expect_dml('packing: non-creator cannot delete',     'aaaa0000-0000-0000-0000-000000000003', false, $$delete from packing_items where id='dddd0000-0000-0000-0000-00000000000c'$$, 0);
select pg_temp.expect_dml('notes: non-creator cannot delete',       'aaaa0000-0000-0000-0000-000000000003', false, $$delete from notes where id='dddd0000-0000-0000-0000-00000000000d'$$, 0);
select pg_temp.expect_dml('inspiration: non-creator cannot delete', 'aaaa0000-0000-0000-0000-000000000003', false, $$delete from inspiration_items where id='dddd0000-0000-0000-0000-00000000000e'$$, 0);
select pg_temp.expect_dml('questions: non-creator cannot delete',   'aaaa0000-0000-0000-0000-000000000003', false, $$delete from questions where id='dddd0000-0000-0000-0000-000000000008'$$, 0);

-- The creator (F) CAN delete their own content:
select pg_temp.expect_dml('checklist: creator can delete own',      'aaaa0000-0000-0000-0000-000000000002', false, $$delete from checklist_items where id='dddd0000-0000-0000-0000-000000000009'$$, 1);
-- The owner CAN delete a member's content (moderation):
select pg_temp.expect_dml('itinerary: owner can delete member content', 'aaaa0000-0000-0000-0000-000000000001', false, $$delete from itinerary_items where id='dddd0000-0000-0000-0000-00000000000a'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Polls — creator-or-owner update/delete; poll_options managed by the poll's
--    creator/owner; a plain member cannot delete another's poll.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('polls: non-creator member cannot delete',  'aaaa0000-0000-0000-0000-000000000003', false, $$delete from polls where id='dddd0000-0000-0000-0000-000000000002'$$, 0);
select pg_temp.expect_dml('polls: creator can delete own',            'aaaa0000-0000-0000-0000-000000000002', false, $$delete from polls where id='dddd0000-0000-0000-0000-000000000002'$$, 1);
select pg_temp.expect_dml('polls: owner can delete a member poll',    'aaaa0000-0000-0000-0000-000000000001', false, $$delete from polls where id='dddd0000-0000-0000-0000-000000000003'$$, 1);
select pg_temp.expect_dml('poll_options: non-manager cannot add',     'aaaa0000-0000-0000-0000-000000000003', false, $$insert into poll_options(trip_id, poll_id, label) values('bbbb0000-0000-0000-0000-000000000001','dddd0000-0000-0000-0000-000000000001','sneak')$$, -1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. Messages — owner moderation: owner may delete any member's message; a
--     plain member may not delete another's; a member may edit their own.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('messages: non-owner cannot delete another''s', 'aaaa0000-0000-0000-0000-000000000003', false, $$delete from messages where id='dddd0000-0000-0000-0000-000000000006'$$, 0);
select pg_temp.expect_dml('messages: author can edit own',               'aaaa0000-0000-0000-0000-000000000002', false, $$update messages set content='edited', edited_at=now() where id='dddd0000-0000-0000-0000-000000000006'$$, 1);
select pg_temp.expect_dml('messages: owner can delete a member message',  'aaaa0000-0000-0000-0000-000000000001', false, $$delete from messages where id='dddd0000-0000-0000-0000-000000000006'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 11. Activity — append-only for members; only the owner may delete.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_dml('activity: member cannot delete', 'aaaa0000-0000-0000-0000-000000000002', false, $$delete from activity where id='dddd0000-0000-0000-0000-00000000000f'$$, 0);
select pg_temp.expect_dml('activity: owner can delete',     'aaaa0000-0000-0000-0000-000000000001', false, $$delete from activity where id='dddd0000-0000-0000-0000-00000000000f'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- 12. The invite capability — the code is the ONLY way in.
--     • get_invite_preview returns a card for an enabled invite, nothing for a
--       disabled one (trip B), even to a non-member.
--     • join_trip is the sole join path: a valid code admits a fresh user; an
--       invalid code is rejected.
-- ═════════════════════════════════════════════════════════════════════════════
select pg_temp.expect_count('invite: preview works for enabled code',  'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from get_invite_preview('invitecodeAAAA')$$, 1);
select pg_temp.expect_count('invite: preview hidden for disabled code', 'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from get_invite_preview('invitecodeBBBB')$$, 0);
select pg_temp.expect_dml('invite: invalid code is rejected',          'aaaa0000-0000-0000-0000-000000000006', false, $$select join_trip('not-a-real-code','Joiner')$$, -1);
select pg_temp.expect_dml('invite: valid code admits a fresh user',    'aaaa0000-0000-0000-0000-000000000006', false, $$select join_trip('invitecodeAAAA','Joiner')$$, 1);
select pg_temp.expect_count('invite: joined user now sees the trip',   'aaaa0000-0000-0000-0000-000000000006', false, $$select count(*) from trips where id='bbbb0000-0000-0000-0000-000000000001'$$, 1);


-- ═════════════════════════════════════════════════════════════════════════════
-- ai_usage — the AI quota ledger (#211)
--
-- This table is what makes the per-trip AI quota trustworthy, so the property
-- under test is narrow and specific: a member may READ their trip's usage and
-- APPEND to it only through record_ai_usage, and may never edit or erase a row.
--
-- Editing matters more than it looks. The quota is computed by COUNTING rows in
-- a trailing window, so a member who could delete rows could reset their own
-- allowance at will and the quota would bound nothing.
--
-- Note what is deliberately NOT asserted: that clients cannot insert at all.
-- That was true when the endpoint held a service-role key, and stopped being
-- true when that key was replaced by the record_ai_usage SECURITY DEFINER RPC
-- (see 20260818030000_record_ai_usage.sql). A member can now append rows for
-- their own trip — which only lets them spend their own allowance faster, the
-- same thing using the feature does. Exhaustible, never evadable.
-- ═════════════════════════════════════════════════════════════════════════════

-- Seed one row per trip as superuser: there is no insert policy, so the direct
-- INSERT below is exactly what a client is forbidden from doing.
insert into public.ai_usage (id, trip_id, member_id, feature, outcome) values
  ('fada0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-000000000001',
   (select id from public.members where trip_id = 'bbbb0000-0000-0000-0000-000000000001' and role = 'owner'),
   'improve_day', 'ok'),
  ('fada0000-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000002',
   (select id from public.members where trip_id = 'bbbb0000-0000-0000-0000-000000000002'),
   'improve_day', 'ok');

-- Read: members see their own trip; nobody else sees anything.
select pg_temp.expect_count('ai_usage: member reads own trip usage',        'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from ai_usage where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('ai_usage: A-member cannot read B usage',       'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from ai_usage where trip_id='bbbb0000-0000-0000-0000-000000000002'$$, 0);
select pg_temp.expect_count('ai_usage: non-member sees no usage at all',    'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from ai_usage$$, 0);

-- Write: the ledger is append-only, and only through the RPC.
select pg_temp.expect_dml('ai_usage: member cannot INSERT directly',        'aaaa0000-0000-0000-0000-000000000002', false, $$insert into ai_usage(trip_id, feature) values('bbbb0000-0000-0000-0000-000000000001','forged')$$, -1);
-- UPDATE/DELETE carry no policy at all, so RLS makes the row invisible to the
-- statement rather than raising: 0 rows affected, per this file's header note.
select pg_temp.expect_dml('ai_usage: member cannot UPDATE a row',           'aaaa0000-0000-0000-0000-000000000002', false, $$update ai_usage set feature='tampered' where id='fada0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('ai_usage: member cannot DELETE to reset quota',  'aaaa0000-0000-0000-0000-000000000002', false, $$delete from ai_usage where id='fada0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('ai_usage: owner cannot DELETE either',           'aaaa0000-0000-0000-0000-000000000001', false, $$delete from ai_usage where id='fada0000-0000-0000-0000-000000000001'$$, 0);

-- record_ai_usage: the only write path, gated on membership.
select pg_temp.expect_dml('record_ai_usage: member may append to own trip', 'aaaa0000-0000-0000-0000-000000000002', false, $$select record_ai_usage('bbbb0000-0000-0000-0000-000000000001','parse_booking')$$, 1);
select pg_temp.expect_dml('record_ai_usage: non-member is rejected',        'aaaa0000-0000-0000-0000-000000000005', false, $$select record_ai_usage('bbbb0000-0000-0000-0000-000000000001','parse_booking')$$, -1);
select pg_temp.expect_dml('record_ai_usage: cross-trip write is rejected',  'aaaa0000-0000-0000-0000-000000000002', false, $$select record_ai_usage('bbbb0000-0000-0000-0000-000000000002','parse_booking')$$, -1);
select pg_temp.expect_dml('record_ai_usage: a bad outcome is rejected',     'aaaa0000-0000-0000-0000-000000000002', false, $$select record_ai_usage('bbbb0000-0000-0000-0000-000000000001','parse_booking','not-an-outcome')$$, -1);

-- Attribution is derived inside the function, never accepted from the caller,
-- so a member cannot log spend against somebody else.
select pg_temp.expect_count('record_ai_usage: row is attributed to the caller', 'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from ai_usage where feature='parse_booking' and member_id='cccc0000-0000-0000-0000-000000000002'$$, 1);

-- An invite-link friend holds an ANONYMOUS session and is an ordinary member,
-- so the grant to `authenticated` must cover them. If this ever regresses,
-- every friend loses AI while the owner keeps it — the exact asymmetry
-- guardrail #3 exists to prevent. Member F, impersonated with an anonymous JWT.
select pg_temp.expect_dml('record_ai_usage: anonymous member may append',   'aaaa0000-0000-0000-0000-000000000002', true, $$select record_ai_usage('bbbb0000-0000-0000-0000-000000000001','parse_booking')$$, 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- get_ai_day_context — the AI read path (#213)
--
-- The contrast with record_ai_usage above is the whole point. That one is
-- SECURITY DEFINER because appending an audit row genuinely needs privilege;
-- this one is SECURITY INVOKER because reading your own trip does not. The
-- consequence is what these checks assert: the Pages Function can be handed any
-- trip id at all and still cannot read a day it has no business seeing, because
-- the caller's own policies decide, not the function's.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.itinerary_items (id, trip_id, title, category, day, start_time, end_time, created_by) values
  ('dddd0000-0000-0000-0000-0000000000a1', 'bbbb0000-0000-0000-0000-000000000001', 'Louvre',   'activity', '2026-09-04', '09:00', '11:00', 'cccc0000-0000-0000-0000-000000000002'),
  ('dddd0000-0000-0000-0000-0000000000a2', 'bbbb0000-0000-0000-0000-000000000001', 'Orsay',    'activity', '2026-09-04', '14:00', '16:00', 'cccc0000-0000-0000-0000-000000000002'),
  -- A stay spanning the day, to prove the span branch is reached (#166).
  ('dddd0000-0000-0000-0000-0000000000a3', 'bbbb0000-0000-0000-0000-000000000001', 'Hotel',    'hotel',    '2026-09-02', '15:00', null, 'cccc0000-0000-0000-0000-000000000002'),
  ('dddd0000-0000-0000-0000-0000000000a4', 'bbbb0000-0000-0000-0000-000000000001', 'Other day','activity', '2026-09-05', '09:00', '10:00', 'cccc0000-0000-0000-0000-000000000002');
update public.itinerary_items set end_day = '2026-09-06' where id = 'dddd0000-0000-0000-0000-0000000000a3';

-- A member gets the day: two dated items plus the stay that covers it, and
-- nothing from the day after.
select pg_temp.expect_count('get_ai_day_context: member sees the day',        'aaaa0000-0000-0000-0000-000000000002', false, $$select jsonb_array_length(get_ai_day_context('bbbb0000-0000-0000-0000-000000000001','2026-09-04')->'items')$$, 3);

-- The isolation check. A non-member calling with a real trip id gets an empty
-- day rather than someone else's — RLS, not an argument check, is what stops it.
select pg_temp.expect_count('get_ai_day_context: non-member gets an empty day','aaaa0000-0000-0000-0000-000000000005', false, $$select jsonb_array_length(get_ai_day_context('bbbb0000-0000-0000-0000-000000000001','2026-09-04')->'items')$$, 0);
select pg_temp.expect_count('get_ai_day_context: A-member cannot read B',      'aaaa0000-0000-0000-0000-000000000002', false, $$select jsonb_array_length(get_ai_day_context('bbbb0000-0000-0000-0000-000000000002','2026-09-04')->'items')$$, 0);

-- An invite-link friend holds an anonymous session and must be able to use the
-- feature, exactly as with record_ai_usage.
select pg_temp.expect_count('get_ai_day_context: anonymous member may read',   'aaaa0000-0000-0000-0000-000000000002', true,  $$select jsonb_array_length(get_ai_day_context('bbbb0000-0000-0000-0000-000000000001','2026-09-04')->'items')$$, 3);

-- Never put a person in the context (docs/AI-ARCHITECTURE.md §6). This is the
-- enforcement point: a field that is never selected cannot be forgotten later,
-- so assert the shape carries no attribution and no free text.
select pg_temp.expect_count('get_ai_day_context: carries no person or notes',  'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from jsonb_array_elements(get_ai_day_context('bbbb0000-0000-0000-0000-000000000001','2026-09-04')->'items') e where e ?| array['created_by','notes','createdBy','paidBy']$$, 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- POST-INIT TABLES (#300) — the eight RLS-protected tables shipped after
-- *_init.sql that had no regression assertion until now:
--   availability_polls · availability_candidates · availability_responses ·
--   destinations · repayments · trip_preferences · notifications · error_reports
--
-- Each block asserts the same three properties the init-era tables above prove,
-- against each table's own policy shape:
--   • member-allowed / non-member-denied — a trip member may do what the policy
--     grants; a signed-in outsider (uX) may do nothing
--   • the table's SPECIFIC asymmetry — self-attributed authorship can't be
--     forged, owner/creator-only writes reject a plain member, per-recipient
--     reads don't leak across members
--   • cross-trip isolation — an attacker holding a VALID session for another
--     trip (uB, owner/member of trip B) can neither read nor write trip A's rows
--
-- Fixtures are seeded here as the superuser (RLS bypassed for seeding only,
-- exactly like the init-era fixtures at the top of this file). uuids use the
-- ab1x prefix to stay clear of the dddd/eeee/fada content ids above. The trip A
-- roster at this point is owner uA, member F (cccc..02), member G (cccc..03),
-- and the invite-joined uJ; trip A's date window is 2026-09-01…2026-09-10.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── availability_polls / _candidates / _responses (#176) ─────────────────────
-- Owner runs the poll: owner-only create/update/delete of polls and candidates,
-- candidates immutable (no update path); every member reads; a member writes
-- ONLY their own response (member_id = my_member_id), one row per candidate.
insert into public.availability_polls (id, trip_id, created_by, title) values
  ('ab110000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', (select id from public.members where trip_id='bbbb0000-0000-0000-0000-000000000001' and role='owner'), 'When can we go?'),
  ('ab110000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', (select id from public.members where trip_id='bbbb0000-0000-0000-0000-000000000001' and role='owner'), 'Throwaway poll');
insert into public.availability_candidates (id, trip_id, poll_id, start_date, end_date, position) values
  ('ab120000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'ab110000-0000-4000-8000-000000000001', '2026-09-02', '2026-09-05', 0),
  ('ab120000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'ab110000-0000-4000-8000-000000000001', '2026-09-06', '2026-09-09', 1),
  ('ab120000-0000-4000-8000-000000000003', 'bbbb0000-0000-0000-0000-000000000001', 'ab110000-0000-4000-8000-000000000001', '2026-09-03', '2026-09-07', 2);
insert into public.availability_responses (id, trip_id, poll_id, candidate_id, member_id, status) values
  ('ab130000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'ab110000-0000-4000-8000-000000000001', 'ab120000-0000-4000-8000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'yes');

-- polls: reads
select pg_temp.expect_count('availability_polls: member sees the poll',        'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from availability_polls where id='ab110000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('availability_polls: outsider sees none',          'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from availability_polls where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('availability_polls: cross-trip attacker sees none','aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from availability_polls where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
-- polls: writes are owner-only, and the owner cannot forge created_by
select pg_temp.expect_dml('availability_polls: outsider cannot insert',        'aaaa0000-0000-0000-0000-000000000005', false, $$insert into availability_polls(trip_id, created_by, title) values('bbbb0000-0000-0000-0000-000000000001', null, 'x')$$, -1);
select pg_temp.expect_dml('availability_polls: plain member cannot insert',    'aaaa0000-0000-0000-0000-000000000002', false, $$insert into availability_polls(trip_id, created_by, title) values('bbbb0000-0000-0000-0000-000000000001', my_member_id('bbbb0000-0000-0000-0000-000000000001'), 'x')$$, -1);
select pg_temp.expect_dml('availability_polls: cross-trip attacker cannot insert','aaaa0000-0000-0000-0000-000000000004', false, $$insert into availability_polls(trip_id, created_by, title) values('bbbb0000-0000-0000-0000-000000000001', null, 'x')$$, -1);
select pg_temp.expect_dml('availability_polls: owner cannot forge created_by',  'aaaa0000-0000-0000-0000-000000000001', false, $$insert into availability_polls(trip_id, created_by, title) values('bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'forged')$$, -1);
select pg_temp.expect_dml('availability_polls: owner can create',              'aaaa0000-0000-0000-0000-000000000001', false, $$insert into availability_polls(trip_id, created_by, title) values('bbbb0000-0000-0000-0000-000000000001', my_member_id('bbbb0000-0000-0000-0000-000000000001'), 'owner poll')$$, 1);
select pg_temp.expect_dml('availability_polls: plain member cannot update',    'aaaa0000-0000-0000-0000-000000000002', false, $$update availability_polls set title='hijack' where id='ab110000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('availability_polls: owner can update',              'aaaa0000-0000-0000-0000-000000000001', false, $$update availability_polls set closed=true where id='ab110000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_dml('availability_polls: plain member cannot delete',    'aaaa0000-0000-0000-0000-000000000002', false, $$delete from availability_polls where id='ab110000-0000-4000-8000-000000000002'$$, 0);
select pg_temp.expect_dml('availability_polls: owner can delete',              'aaaa0000-0000-0000-0000-000000000001', false, $$delete from availability_polls where id='ab110000-0000-4000-8000-000000000002'$$, 1);

-- candidates: reads, owner-only writes, and NO update path (immutable once proposed)
select pg_temp.expect_count('availability_candidates: member sees candidate',  'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from availability_candidates where id='ab120000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('availability_candidates: outsider sees none',     'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from availability_candidates where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('availability_candidates: cross-trip sees none',   'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from availability_candidates where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('availability_candidates: plain member cannot insert','aaaa0000-0000-0000-0000-000000000002', false, $$insert into availability_candidates(trip_id, poll_id, start_date, end_date) values('bbbb0000-0000-0000-0000-000000000001','ab110000-0000-4000-8000-000000000001','2026-09-04','2026-09-06')$$, -1);
select pg_temp.expect_dml('availability_candidates: owner can insert',         'aaaa0000-0000-0000-0000-000000000001', false, $$insert into availability_candidates(trip_id, poll_id, start_date, end_date) values('bbbb0000-0000-0000-0000-000000000001','ab110000-0000-4000-8000-000000000001','2026-09-04','2026-09-06')$$, 1);
select pg_temp.expect_dml('availability_candidates: no update path even for owner','aaaa0000-0000-0000-0000-000000000001', false, $$update availability_candidates set position=9 where id='ab120000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('availability_candidates: plain member cannot delete','aaaa0000-0000-0000-0000-000000000002', false, $$delete from availability_candidates where id='ab120000-0000-4000-8000-000000000003'$$, 0);
select pg_temp.expect_dml('availability_candidates: owner can delete',         'aaaa0000-0000-0000-0000-000000000001', false, $$delete from availability_candidates where id='ab120000-0000-4000-8000-000000000003'$$, 1);

-- responses: every member reads; a member writes ONLY their own (self-attributed)
select pg_temp.expect_count('availability_responses: member sees a response',  'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from availability_responses where id='ab130000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('availability_responses: other member sees it too', 'aaaa0000-0000-0000-0000-000000000003', false, $$select count(*) from availability_responses where id='ab130000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('availability_responses: outsider sees none',      'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from availability_responses where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('availability_responses: cross-trip sees none',    'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from availability_responses where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('availability_responses: member can respond as self', 'aaaa0000-0000-0000-0000-000000000003', false, $$insert into availability_responses(trip_id, poll_id, candidate_id, member_id, status) values('bbbb0000-0000-0000-0000-000000000001','ab110000-0000-4000-8000-000000000001','ab120000-0000-4000-8000-000000000002','cccc0000-0000-0000-0000-000000000003','maybe')$$, 1);
select pg_temp.expect_dml('availability_responses: member cannot forge another''s', 'aaaa0000-0000-0000-0000-000000000003', false, $$insert into availability_responses(trip_id, poll_id, candidate_id, member_id, status) values('bbbb0000-0000-0000-0000-000000000001','ab110000-0000-4000-8000-000000000001','ab120000-0000-4000-8000-000000000002','cccc0000-0000-0000-0000-000000000002','no')$$, -1);
select pg_temp.expect_dml('availability_responses: outsider cannot insert',    'aaaa0000-0000-0000-0000-000000000005', false, $$insert into availability_responses(trip_id, poll_id, candidate_id, member_id, status) values('bbbb0000-0000-0000-0000-000000000001','ab110000-0000-4000-8000-000000000001','ab120000-0000-4000-8000-000000000002','cccc0000-0000-0000-0000-000000000002','yes')$$, -1);
select pg_temp.expect_dml('availability_responses: member cannot edit another''s', 'aaaa0000-0000-0000-0000-000000000003', false, $$update availability_responses set status='no' where id='ab130000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('availability_responses: member can edit own',       'aaaa0000-0000-0000-0000-000000000002', false, $$update availability_responses set status='maybe' where id='ab130000-0000-4000-8000-000000000001'$$, 1);

-- ── destinations (#197) — owner-only trip structure ──────────────────────────
insert into public.destinations (id, trip_id, name, position) values
  ('ab140000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'Kyoto', 0),
  ('ab140000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'Osaka', 1);
select pg_temp.expect_count('destinations: member sees the leg',               'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from destinations where id='ab140000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('destinations: outsider sees none',                'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from destinations where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('destinations: cross-trip attacker sees none',     'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from destinations where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('destinations: plain member cannot insert',          'aaaa0000-0000-0000-0000-000000000002', false, $$insert into destinations(trip_id, name) values('bbbb0000-0000-0000-0000-000000000001','Nara')$$, -1);
select pg_temp.expect_dml('destinations: outsider cannot insert',              'aaaa0000-0000-0000-0000-000000000005', false, $$insert into destinations(trip_id, name) values('bbbb0000-0000-0000-0000-000000000001','Nara')$$, -1);
select pg_temp.expect_dml('destinations: cross-trip attacker cannot insert',   'aaaa0000-0000-0000-0000-000000000004', false, $$insert into destinations(trip_id, name) values('bbbb0000-0000-0000-0000-000000000001','Nara')$$, -1);
select pg_temp.expect_dml('destinations: owner can insert',                    'aaaa0000-0000-0000-0000-000000000001', false, $$insert into destinations(trip_id, name) values('bbbb0000-0000-0000-0000-000000000001','Nara')$$, 1);
select pg_temp.expect_dml('destinations: plain member cannot update',          'aaaa0000-0000-0000-0000-000000000002', false, $$update destinations set name='hijack' where id='ab140000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('destinations: owner can update',                    'aaaa0000-0000-0000-0000-000000000001', false, $$update destinations set name='Kyoto ✔' where id='ab140000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_dml('destinations: plain member cannot delete',          'aaaa0000-0000-0000-0000-000000000002', false, $$delete from destinations where id='ab140000-0000-4000-8000-000000000002'$$, 0);
select pg_temp.expect_dml('destinations: owner can delete',                    'aaaa0000-0000-0000-0000-000000000001', false, $$delete from destinations where id='ab140000-0000-4000-8000-000000000002'$$, 1);

-- ── repayments (#125) — any member records as self; creator-or-owner delete;
--    NO update path (an immutable record of a payment that happened) ──────────
insert into public.repayments (id, trip_id, from_member, to_member, amount, created_by) values
  ('ab150000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'cccc0000-0000-0000-0000-000000000003', 20.00, 'cccc0000-0000-0000-0000-000000000002');
select pg_temp.expect_count('repayments: member sees the repayment',           'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from repayments where id='ab150000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('repayments: outsider sees none',                  'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from repayments where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('repayments: cross-trip attacker sees none',       'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from repayments where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('repayments: member can record as self',             'aaaa0000-0000-0000-0000-000000000003', false, $$insert into repayments(trip_id, from_member, to_member, amount, created_by) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-000000000002',5.00,'cccc0000-0000-0000-0000-000000000003')$$, 1);
select pg_temp.expect_dml('repayments: member cannot forge created_by',        'aaaa0000-0000-0000-0000-000000000003', false, $$insert into repayments(trip_id, from_member, to_member, amount, created_by) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-000000000002',5.00,'cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('repayments: outsider cannot insert',                'aaaa0000-0000-0000-0000-000000000005', false, $$insert into repayments(trip_id, from_member, to_member, amount, created_by) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-000000000003',5.00,'cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('repayments: cross-trip attacker cannot insert',     'aaaa0000-0000-0000-0000-000000000004', false, $$insert into repayments(trip_id, from_member, to_member, amount, created_by) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-000000000003',5.00,'cccc0000-0000-0000-0000-000000000002')$$, -1);
select pg_temp.expect_dml('repayments: no update path even for owner',         'aaaa0000-0000-0000-0000-000000000001', false, $$update repayments set amount=999 where id='ab150000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('repayments: non-creator member cannot delete',      'aaaa0000-0000-0000-0000-000000000003', false, $$delete from repayments where id='ab150000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('repayments: creator can delete own',                'aaaa0000-0000-0000-0000-000000000002', false, $$delete from repayments where id='ab150000-0000-4000-8000-000000000001'$$, 1);

-- ── trip_preferences (#268) — group-owned, one row per trip, editable by any
--    member, self-attributed via updated_by; NO delete path ─────────────────
select pg_temp.expect_dml('trip_preferences: outsider cannot insert',          'aaaa0000-0000-0000-0000-000000000005', false, $$insert into trip_preferences(trip_id, pace) values('bbbb0000-0000-0000-0000-000000000001','relaxed')$$, -1);
select pg_temp.expect_dml('trip_preferences: cross-trip attacker cannot insert','aaaa0000-0000-0000-0000-000000000004', false, $$insert into trip_preferences(trip_id, pace) values('bbbb0000-0000-0000-0000-000000000001','relaxed')$$, -1);
select pg_temp.expect_dml('trip_preferences: member cannot forge updated_by',  'aaaa0000-0000-0000-0000-000000000002', false, $$insert into trip_preferences(trip_id, pace, updated_by) values('bbbb0000-0000-0000-0000-000000000001','relaxed','cccc0000-0000-0000-0000-000000000003')$$, -1);
select pg_temp.expect_dml('trip_preferences: member can create as self',       'aaaa0000-0000-0000-0000-000000000002', false, $$insert into trip_preferences(trip_id, pace, updated_by) values('bbbb0000-0000-0000-0000-000000000001','relaxed', my_member_id('bbbb0000-0000-0000-0000-000000000001'))$$, 1);
select pg_temp.expect_count('trip_preferences: member sees the row',           'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from trip_preferences where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_count('trip_preferences: outsider sees none',            'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from trip_preferences where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('trip_preferences: cross-trip attacker sees none', 'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from trip_preferences where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('trip_preferences: another member can edit as self', 'aaaa0000-0000-0000-0000-000000000003', false, $$update trip_preferences set pace='packed', updated_by=my_member_id('bbbb0000-0000-0000-0000-000000000001') where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 1);
select pg_temp.expect_dml('trip_preferences: member cannot forge editor',      'aaaa0000-0000-0000-0000-000000000003', false, $$update trip_preferences set pace='balanced', updated_by='cccc0000-0000-0000-0000-000000000002' where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, -1);
select pg_temp.expect_dml('trip_preferences: no delete path',                  'aaaa0000-0000-0000-0000-000000000002', false, $$delete from trip_preferences where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);

-- ── notifications (#182/#193) — a PER-RECIPIENT inbox: a member reads only
--    their own rows, inserts are self-attributed (actor = self), and the only
--    field a recipient may change is read_at (column grant) ──────────────────
insert into public.notifications (id, trip_id, recipient_id, actor_id, type, title) values
  ('ab170000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'cccc0000-0000-0000-0000-000000000003', 'poll_opened', 'For F'),
  ('ab170000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000003', 'cccc0000-0000-0000-0000-000000000002', 'poll_opened', 'For G');
select pg_temp.expect_count('notifications: recipient sees own row',           'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from notifications where id='ab170000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('notifications: a member cannot read another''s',   'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from notifications where id='ab170000-0000-4000-8000-000000000002'$$, 0);
select pg_temp.expect_count('notifications: the other recipient sees theirs',  'aaaa0000-0000-0000-0000-000000000003', false, $$select count(*) from notifications where id='ab170000-0000-4000-8000-000000000002'$$, 1);
select pg_temp.expect_count('notifications: outsider sees none',               'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from notifications where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('notifications: cross-trip attacker sees none',    'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from notifications where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('notifications: member can notify as self',          'aaaa0000-0000-0000-0000-000000000002', false, $$insert into notifications(trip_id, recipient_id, actor_id, type, title) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-000000000002','mention','hi')$$, 1);
select pg_temp.expect_dml('notifications: member cannot forge the actor',      'aaaa0000-0000-0000-0000-000000000002', false, $$insert into notifications(trip_id, recipient_id, actor_id, type, title) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','cccc0000-0000-0000-0000-000000000003','mention','forged')$$, -1);
select pg_temp.expect_dml('notifications: outsider cannot insert',             'aaaa0000-0000-0000-0000-000000000005', false, $$insert into notifications(trip_id, recipient_id, actor_id, type, title) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-000000000002','mention','x')$$, -1);
select pg_temp.expect_dml('notifications: cross-trip attacker cannot insert',  'aaaa0000-0000-0000-0000-000000000004', false, $$insert into notifications(trip_id, recipient_id, actor_id, type, title) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-000000000002','mention','x')$$, -1);
select pg_temp.expect_dml('notifications: recipient can mark own read',        'aaaa0000-0000-0000-0000-000000000002', false, $$update notifications set read_at=now() where id='ab170000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_dml('notifications: non-recipient cannot mark read',     'aaaa0000-0000-0000-0000-000000000003', false, $$update notifications set read_at=now() where id='ab170000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('notifications: recipient cannot rewrite title',     'aaaa0000-0000-0000-0000-000000000002', false, $$update notifications set title='tampered' where id='ab170000-0000-4000-8000-000000000001'$$, -1);
select pg_temp.expect_dml('notifications: non-recipient member cannot delete', 'aaaa0000-0000-0000-0000-000000000003', false, $$delete from notifications where id='ab170000-0000-4000-8000-000000000001'$$, 0);
-- The delete policy also names the owner (`... or is_trip_owner`), but the
-- recipient-only SELECT policy is applied to the DELETE's row lookup too
-- (Postgres ANDs SELECT quals into UPDATE/DELETE), so the owner can only ever
-- remove notifications addressed to them — a row for another member is invisible
-- to the delete and matches zero rows. This pins that interaction: broadening
-- the SELECT policy would flip this to 1 and this assertion would catch it.
select pg_temp.expect_dml('notifications: owner cannot delete another''s (SELECT-narrowed)', 'aaaa0000-0000-0000-0000-000000000001', false, $$delete from notifications where id='ab170000-0000-4000-8000-000000000002'$$, 0);
select pg_temp.expect_dml('notifications: recipient can delete own',           'aaaa0000-0000-0000-0000-000000000002', false, $$delete from notifications where id='ab170000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_dml('notifications: the other recipient can delete own', 'aaaa0000-0000-0000-0000-000000000003', false, $$delete from notifications where id='ab170000-0000-4000-8000-000000000002'$$, 1);

-- ── push_subscriptions (#267, epic #181 closed-app slice) — device-private
--    opt-in store: a member reads/writes ONLY their own rows, and only in a
--    trip they belong to. No member (owner included) can enumerate another
--    member's devices, and no one can plant a subscription as someone else. ──
insert into public.push_subscriptions (id, trip_id, member_id, endpoint, p256dh, auth) values
  ('ab200000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'https://push.test/f', 'p256dh-f', 'auth-f'),
  ('ab200000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000003', 'https://push.test/g', 'p256dh-g', 'auth-g');
select pg_temp.expect_count('push_subscriptions: member sees own device',       'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from push_subscriptions where id='ab200000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('push_subscriptions: member cannot see another''s',  'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from push_subscriptions where id='ab200000-0000-4000-8000-000000000002'$$, 0);
select pg_temp.expect_count('push_subscriptions: owner cannot see a member''s',  'aaaa0000-0000-0000-0000-000000000001', false, $$select count(*) from push_subscriptions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('push_subscriptions: outsider sees none',            'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from push_subscriptions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('push_subscriptions: cross-trip attacker sees none', 'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from push_subscriptions where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_dml('push_subscriptions: member can opt in as self',       'aaaa0000-0000-0000-0000-000000000002', false, $$insert into push_subscriptions(trip_id, member_id, endpoint, p256dh, auth) values('bbbb0000-0000-0000-0000-000000000001', my_member_id('bbbb0000-0000-0000-0000-000000000001'), 'https://push.test/f2', 'k', 'a')$$, 1);
select pg_temp.expect_dml('push_subscriptions: member cannot plant on another',  'aaaa0000-0000-0000-0000-000000000002', false, $$insert into push_subscriptions(trip_id, member_id, endpoint, p256dh, auth) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003', 'https://push.test/x', 'k', 'a')$$, -1);
select pg_temp.expect_dml('push_subscriptions: outsider cannot insert',          'aaaa0000-0000-0000-0000-000000000005', false, $$insert into push_subscriptions(trip_id, member_id, endpoint, p256dh, auth) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002', 'https://push.test/x', 'k', 'a')$$, -1);
select pg_temp.expect_dml('push_subscriptions: cross-trip attacker cannot insert','aaaa0000-0000-0000-0000-000000000004', false, $$insert into push_subscriptions(trip_id, member_id, endpoint, p256dh, auth) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002', 'https://push.test/x', 'k', 'a')$$, -1);
select pg_temp.expect_dml('push_subscriptions: member can refresh own',          'aaaa0000-0000-0000-0000-000000000002', false, $$update push_subscriptions set updated_at=now() where id='ab200000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_dml('push_subscriptions: member cannot touch another''s',  'aaaa0000-0000-0000-0000-000000000002', false, $$update push_subscriptions set updated_at=now() where id='ab200000-0000-4000-8000-000000000002'$$, 0);
select pg_temp.expect_dml('push_subscriptions: non-owner cannot delete another''s','aaaa0000-0000-0000-0000-000000000003', false, $$delete from push_subscriptions where id='ab200000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('push_subscriptions: member can opt out (delete own)', 'aaaa0000-0000-0000-0000-000000000002', false, $$delete from push_subscriptions where id='ab200000-0000-4000-8000-000000000001'$$, 1);

-- ── error_reports (#57/#170) — write-only telemetry: OWNER-only read of
--    trip-scoped rows, deploy-level (trip_id NULL) rows readable by no one via
--    RLS; self-attributed insert; append-only (no update/delete) ────────────
insert into public.error_reports (id, user_id, trip_id, message) values
  ('ab190000-0000-4000-8000-000000000001', 'aaaa0000-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'boom'),
  ('ab190000-0000-4000-8000-000000000002', 'aaaa0000-0000-0000-0000-000000000002', null, 'deploy-level boom');
select pg_temp.expect_count('error_reports: owner reads own trip errors',      'aaaa0000-0000-0000-0000-000000000001', false, $$select count(*) from error_reports where id='ab190000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_count('error_reports: plain member cannot read',         'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from error_reports where id='ab190000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_count('error_reports: outsider cannot read',             'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from error_reports where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('error_reports: cross-trip attacker cannot read',  'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from error_reports where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('error_reports: deploy-level rows read by no one',  'aaaa0000-0000-0000-0000-000000000001', false, $$select count(*) from error_reports where trip_id is null$$, 0);
select pg_temp.expect_dml('error_reports: member can log as self',             'aaaa0000-0000-0000-0000-000000000002', false, $$insert into error_reports(trip_id, message) values('bbbb0000-0000-0000-0000-000000000001','crash')$$, 1);
select pg_temp.expect_dml('error_reports: member cannot forge user_id',        'aaaa0000-0000-0000-0000-000000000002', false, $$insert into error_reports(user_id, trip_id, message) values('aaaa0000-0000-0000-0000-000000000003','bbbb0000-0000-0000-0000-000000000001','crash')$$, -1);
select pg_temp.expect_dml('error_reports: member cannot attribute to other trip','aaaa0000-0000-0000-0000-000000000002', false, $$insert into error_reports(trip_id, message) values('bbbb0000-0000-0000-0000-000000000002','crash')$$, -1);
select pg_temp.expect_dml('error_reports: outsider cannot log to a trip',      'aaaa0000-0000-0000-0000-000000000005', false, $$insert into error_reports(trip_id, message) values('bbbb0000-0000-0000-0000-000000000001','crash')$$, -1);
select pg_temp.expect_dml('error_reports: append-only (owner cannot update)',  'aaaa0000-0000-0000-0000-000000000001', false, $$update error_reports set message='x' where id='ab190000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('error_reports: append-only (owner cannot delete)',  'aaaa0000-0000-0000-0000-000000000001', false, $$delete from error_reports where id='ab190000-0000-4000-8000-000000000001'$$, 0);

-- ── comments (#314, epic #313 slice 1) — discussion pinned to an itinerary
--    item. Trust shape COPIED from `messages`: member-read, self-attributed
--    insert, author-or-owner delete, and NO update path. entity_id is a soft
--    pointer (no FK to itinerary_items), so these assertions gate the same
--    authorship + cross-trip properties the chat table proves, on the new
--    table. Seeded on item dddd..0a ("Itinerary by F"): one comment by F, one
--    by G. ──────────────────────────────────────────────────────────────────
insert into public.comments (id, trip_id, entity_type, entity_id, member_id, body) values
  ('ab210000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'itinerary_item', 'dddd0000-0000-0000-0000-00000000000a', 'cccc0000-0000-0000-0000-000000000002', 'Comment by F'),
  ('ab210000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'itinerary_item', 'dddd0000-0000-0000-0000-00000000000a', 'cccc0000-0000-0000-0000-000000000003', 'Comment by G');
-- reads: member sees the item's thread; outsider and cross-trip attacker see none
select pg_temp.expect_count('comments: member sees the item thread',           'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from comments where entity_type='itinerary_item' and entity_id='dddd0000-0000-0000-0000-00000000000a'$$, 2);
select pg_temp.expect_count('comments: outsider sees none',                    'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from comments where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('comments: cross-trip attacker sees none',         'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from comments where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
-- inserts: self-attributed only — no forged authorship, no outsider, no cross-trip
select pg_temp.expect_dml('comments: member can comment as self',              'aaaa0000-0000-0000-0000-000000000002', false, $$insert into comments(trip_id, entity_type, entity_id, member_id, body) values('bbbb0000-0000-0000-0000-000000000001','itinerary_item','dddd0000-0000-0000-0000-00000000000a','cccc0000-0000-0000-0000-000000000002','mine')$$, 1);
select pg_temp.expect_dml('comments: member cannot forge another''s authorship','aaaa0000-0000-0000-0000-000000000002', false, $$insert into comments(trip_id, entity_type, entity_id, member_id, body) values('bbbb0000-0000-0000-0000-000000000001','itinerary_item','dddd0000-0000-0000-0000-00000000000a','cccc0000-0000-0000-0000-000000000003','forged')$$, -1);
select pg_temp.expect_dml('comments: outsider cannot insert',                  'aaaa0000-0000-0000-0000-000000000005', false, $$insert into comments(trip_id, entity_type, entity_id, member_id, body) values('bbbb0000-0000-0000-0000-000000000001','itinerary_item','dddd0000-0000-0000-0000-00000000000a','cccc0000-0000-0000-0000-000000000002','x')$$, -1);
select pg_temp.expect_dml('comments: cross-trip attacker cannot insert',       'aaaa0000-0000-0000-0000-000000000004', false, $$insert into comments(trip_id, entity_type, entity_id, member_id, body) values('bbbb0000-0000-0000-0000-000000000001','itinerary_item','dddd0000-0000-0000-0000-00000000000a','cccc0000-0000-0000-0000-000000000002','x')$$, -1);
-- no update path — even the author cannot rewrite a comment (immutable this slice)
select pg_temp.expect_dml('comments: no update path even for the author',      'aaaa0000-0000-0000-0000-000000000002', false, $$update comments set body='edited' where id='ab210000-0000-4000-8000-000000000001'$$, 0);
-- delete asymmetry: a third member cannot delete another's; author and owner can
select pg_temp.expect_dml('comments: non-author member cannot delete another''s','aaaa0000-0000-0000-0000-000000000003', false, $$delete from comments where id='ab210000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('comments: author can delete own',                   'aaaa0000-0000-0000-0000-000000000003', false, $$delete from comments where id='ab210000-0000-4000-8000-000000000002'$$, 1);
select pg_temp.expect_dml('comments: owner can delete a member comment',       'aaaa0000-0000-0000-0000-000000000001', false, $$delete from comments where id='ab210000-0000-4000-8000-000000000001'$$, 1);

-- ── trip_photos (#294, epic #205 slice 4) — direct-upload gallery pointer into
--    the private chat-images bucket. Trust shape (20260825142200_trip_photos.sql):
--    member-read, self-attributed insert (member_id = my_member_id), uploader-OR-
--    OWNER delete, and NO update policy (a photo pointer is immutable — Postgres
--    denies every UPDATE by default, so no member can re-point another's photo via
--    a direct PostgREST call). This is the one content table that shipped without a
--    regression assertion (#321): trip_photos landed Aug 25, the #300 post-init
--    extension merged Aug 29 without it. Seeded on trip A: one photo by F, one by
--    G, so the delete asymmetry has concrete targets. ─────────────────────────
insert into public.trip_photos (id, trip_id, member_id, image_path) values
  ('ab220000-0000-4000-8000-000000000001', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000002', 'bbbb0000-0000-0000-0000-000000000001/photo-f.jpg'),
  ('ab220000-0000-4000-8000-000000000002', 'bbbb0000-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-000000000003', 'bbbb0000-0000-0000-0000-000000000001/photo-g.jpg');
-- reads: any member sees the trip's photos; outsider and cross-trip attacker see none
select pg_temp.expect_count('trip_photos: member sees the trip gallery',        'aaaa0000-0000-0000-0000-000000000002', false, $$select count(*) from trip_photos where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 2);
select pg_temp.expect_count('trip_photos: outsider sees none',                  'aaaa0000-0000-0000-0000-000000000005', false, $$select count(*) from trip_photos where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
select pg_temp.expect_count('trip_photos: cross-trip attacker sees none',       'aaaa0000-0000-0000-0000-000000000004', false, $$select count(*) from trip_photos where trip_id='bbbb0000-0000-0000-0000-000000000001'$$, 0);
-- inserts: self-attributed only — no forged authorship, no outsider, no cross-trip
select pg_temp.expect_dml('trip_photos: member can add a photo as self',        'aaaa0000-0000-0000-0000-000000000002', false, $$insert into trip_photos(trip_id, member_id, image_path) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','bbbb0000-0000-0000-0000-000000000001/mine.jpg')$$, 1);
select pg_temp.expect_dml('trip_photos: member cannot forge another''s authorship','aaaa0000-0000-0000-0000-000000000002', false, $$insert into trip_photos(trip_id, member_id, image_path) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000003','bbbb0000-0000-0000-0000-000000000001/forged.jpg')$$, -1);
select pg_temp.expect_dml('trip_photos: outsider cannot insert',                'aaaa0000-0000-0000-0000-000000000005', false, $$insert into trip_photos(trip_id, member_id, image_path) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','bbbb0000-0000-0000-0000-000000000001/x.jpg')$$, -1);
select pg_temp.expect_dml('trip_photos: cross-trip attacker cannot insert',     'aaaa0000-0000-0000-0000-000000000004', false, $$insert into trip_photos(trip_id, member_id, image_path) values('bbbb0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000002','bbbb0000-0000-0000-0000-000000000001/x.jpg')$$, -1);
-- no update path — even the uploader cannot re-point their own photo (immutable)
select pg_temp.expect_dml('trip_photos: no update path even for the uploader',  'aaaa0000-0000-0000-0000-000000000002', false, $$update trip_photos set image_path='bbbb0000-0000-0000-0000-000000000001/swapped.jpg' where id='ab220000-0000-4000-8000-000000000001'$$, 0);
-- delete asymmetry: a third member cannot delete a photo they didn't upload;
-- the uploader and the trip owner can (the highest-value assertion for this table)
select pg_temp.expect_dml('trip_photos: non-uploader member cannot delete another''s','aaaa0000-0000-0000-0000-000000000003', false, $$delete from trip_photos where id='ab220000-0000-4000-8000-000000000001'$$, 0);
select pg_temp.expect_dml('trip_photos: uploader can delete own',               'aaaa0000-0000-0000-0000-000000000002', false, $$delete from trip_photos where id='ab220000-0000-4000-8000-000000000001'$$, 1);
select pg_temp.expect_dml('trip_photos: owner can delete a member photo',       'aaaa0000-0000-0000-0000-000000000001', false, $$delete from trip_photos where id='ab220000-0000-4000-8000-000000000002'$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- Finalize — print a summary row (always visible), then RAISE (non-zero exit)
-- if anything regressed.
-- ═════════════════════════════════════════════════════════════════════════════
select format('RLS regression suite: %s/%s passed',
              count(*) filter (where passed), count(*)) as summary
from _rls_results;

do $$
declare
  v_total  int;
  v_failed int;
  r        record;
begin
  select count(*), count(*) filter (where not passed) into v_total, v_failed from _rls_results;
  if v_failed > 0 then
    raise warning '─── FAILED RLS CHECKS ───';
    for r in select name, got, want from _rls_results where not passed order by id loop
      raise warning 'FAIL: %  (got %, want %)', r.name, r.got, r.want;
    end loop;
    raise exception 'RLS regression suite: %/% checks FAILED', v_failed, v_total;
  end if;
  raise notice 'RLS regression suite: %/% passed', v_total, v_total;
end $$;

rollback;
