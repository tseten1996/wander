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
