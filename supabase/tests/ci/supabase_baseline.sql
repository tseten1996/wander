-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase baseline shim — CI ONLY. NOT a migration; never applied to the app.
--
-- The RLS suite (../rls_policies_test.sql) and every migration in
-- supabase/migrations/ assume the role/schema baseline a real Supabase project
-- is provisioned with: the `anon` / `authenticated` / `service_role` roles, the
-- `auth` schema with auth.uid()/auth.jwt() and an auth.users table, a minimal
-- `storage` schema (buckets/objects + storage.foldername), the `supabase_realtime`
-- publication, and default privileges that grant new public objects to those
-- roles. `supabase start` provisions all of this before it applies the
-- migrations; a stock Postgres does not.
--
-- This file reproduces exactly that baseline so the suite can run against a
-- throwaway `postgres` container in CI — no live project, no secret, no Docker
-- stack. It is deliberately faithful to the parts the migrations and the suite
-- actually touch, and nothing more:
--   • roles: anon / authenticated / service_role (unprivileged, RLS-enforced —
--     authenticated must NOT bypass RLS, that is the whole point of the suite)
--   • default privileges: public objects created after this file (i.e. every
--     migration) are granted to the three roles, so a policy helper like
--     is_trip_member() is executable by `authenticated` and a migration's
--     `revoke ... from authenticated` has something to revoke — mirroring the
--     real project, where the suite's assertions are calibrated
--   • auth.uid()/auth.jwt(): read the synthetic `request.jwt.claims` the suite
--     sets per impersonated user, identical to the live definitions
--   • storage: only what the chat-images migration needs to apply cleanly
--
-- Run order (see scripts/run-rls-tests.sh): this file → every migration in
-- timestamp order → rls_policies_test.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Roles ────────────────────────────────────────────────────────────────────
-- NOLOGIN, and crucially NOT superuser / NOBYPASSRLS: `authenticated` is the
-- unprivileged role the suite switches into so RLS is actually enforced.
do $$ begin
  create role anon          nologin noinherit;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin noinherit;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role   nologin noinherit bypassrls;
exception when duplicate_object then null; end $$;

-- ── Schema usage + default privileges ────────────────────────────────────────
-- In a real project the migrations run as an owner whose default privileges
-- grant every new public table/sequence/function to these roles. We set the
-- same default privileges for the current (superuser) role BEFORE the
-- migrations run, so their objects are granted identically.
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- Anything that already exists in public (none of ours, but be exact).
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

-- ── auth schema ──────────────────────────────────────────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Minimal auth.users: the columns the suite seeds and the migrations read
-- (handle_new_trip reads `email`; trips/members/error_reports FK `id`).
create table if not exists auth.users (
  id                 uuid primary key,
  instance_id        uuid,
  aud                text,
  role               text,
  email              text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);

-- auth.uid() / auth.jwt() — identical semantics to the live Supabase helpers:
-- read the request.jwt.claims GUC the suite sets with set_config(...).
create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

create or replace function auth.jwt() returns jsonb
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim',  true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;

create or replace function auth.role() returns text
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
  $$;

grant execute on function auth.uid(), auth.jwt(), auth.role()
  to anon, authenticated, service_role;

-- ── storage schema ───────────────────────────────────────────────────────────
-- Only what supabase/migrations/*_chat_images.sql needs to apply: the two
-- tables it writes/policies, and storage.foldername (path → folder segments).
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;

grant all on storage.buckets, storage.objects
  to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
  language plpgsql stable
  as $$
  declare _parts text[];
  begin
    select string_to_array(name, '/') into _parts;
    return _parts[1 : array_length(_parts, 1) - 1];
  end
  $$;

grant execute on function storage.foldername(text)
  to anon, authenticated, service_role;

-- ── Realtime publication ─────────────────────────────────────────────────────
-- Migrations do `alter publication supabase_realtime add table ...`; it must
-- already exist (empty), exactly as a fresh Supabase project ships it.
do $$ begin
  create publication supabase_realtime;
exception when duplicate_object then null; end $$;
