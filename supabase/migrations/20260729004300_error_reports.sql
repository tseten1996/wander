-- #57: client-side error telemetry so a broken deploy surfaces to the
-- maintainer without waiting for a user to notice and report it.
--
-- Today there is NO error signal: if a deploy ships a runtime crash, the only
-- feedback loop is a friend giving up and (maybe) messaging the trip owner.
-- This adds a write-only telemetry sink — the client's global window.onerror /
-- unhandledrejection handlers (src/lib/errorReporting.ts) fire-and-forget an
-- `error_reports` row when an uncaught error or promise rejection occurs.
--
-- Security model — this is UX-grade telemetry, never a trust path:
--   * RLS is the boundary (guardrail #1). The public anon key can INSERT, but
--     the rows are NOT world-readable. SELECT is scoped to the trip owner for
--     rows that carry a trip_id; deploy-level errors (trip_id IS NULL — a crash
--     on the home/join screen or before routing) are readable only via the
--     service_role (the Supabase dashboard), which is how the maintainer triages
--     a broken deploy. There is deliberately no global "app owner" row in this
--     schema, so "only the owner can read it" is realised as: the trip's owner
--     for scoped errors, the project maintainer (dashboard) for unscoped ones.
--   * INSERT is self-attributed: a caller may only write a row as themselves
--     (user_id = auth.uid()) and only attribute it to a trip they belong to
--     (trip_id IS NULL OR is_trip_member(trip_id)) — so no member can forge
--     another member's error or spam a trip they are not in.
--   * No UPDATE / DELETE policies -> Postgres denies both by default. Rows are an
--     immutable append-only log; pruning is a maintainer / dashboard job.
--
-- Not a content table: deliberately NOT added to the supabase_realtime
-- publication. No client subscribes to error rows; broadcasting them would be
-- pure free-tier overhead with no reader.
create table if not exists public.error_reports (
  id uuid primary key default gen_random_uuid(),
  -- Who hit the error. Defaulted to the caller so the client never has to send
  -- it; the INSERT policy pins it to auth.uid() regardless. Anonymous friends
  -- have a real auth.uid() too, so their crashes are captured as well.
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- The trip the user was viewing when it broke, or NULL for an error outside a
  -- trip (home, join, or a boot-time crash). ON DELETE SET NULL: a deleted trip
  -- must not drop its error history — the deploy signal outlives the trip.
  trip_id uuid references public.trips(id) on delete set null,
  message text not null,
  stack text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Triage indexes: newest-first overall, and by trip for an owner reading their
-- own trip's errors.
create index if not exists error_reports_created_idx
  on public.error_reports (created_at desc);
create index if not exists error_reports_trip_idx
  on public.error_reports (trip_id, created_at desc);

alter table public.error_reports enable row level security;

-- SELECT: the trip owner may read errors scoped to their trip. Unscoped
-- (trip_id IS NULL) rows are intentionally readable by no one through RLS — the
-- maintainer reads them via the dashboard, where service_role bypasses RLS.
create policy error_report_select on public.error_reports for select
  using (trip_id is not null and is_trip_owner(trip_id));

-- INSERT: any authenticated caller (owner or anonymous friend) may log an error
-- as themselves, attributed either to no trip or to a trip they belong to.
create policy error_report_insert on public.error_reports for insert
  with check (
    user_id = (select auth.uid())
    and (trip_id is null or is_trip_member(trip_id))
  );
