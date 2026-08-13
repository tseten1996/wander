-- #170: throttle error_reports inserts per caller so a client crash-loop or a
-- scripted anon session can't exhaust the Supabase free-tier row/storage quota.
--
-- error_reports is a write-only telemetry sink (20260729004300_error_reports.sql):
-- any authenticated caller — including every anonymous friend — may INSERT, and
-- the rows are read by almost no one (owner-scoped SELECT for trip rows,
-- dashboard-only for trip_id IS NULL rows). That makes it the one table where a
-- misbehaving client (the fire-and-forget window.onerror handler in
-- src/lib/errorReporting.ts firing on every re-render throw) or a malicious anon
-- session can write thousands of rows a minute into a table nobody reads — a
-- self-inflicted or hostile free-tier exhaustion vector against guardrail #5
-- (zero-cost stack). The client cap is UX; nothing enforced the boundary in
-- Postgres. This adds that enforcement.
--
-- Boundary: a BEFORE INSERT trigger rejects a write once the caller already has
-- more than MAX rows in the trailing WINDOW. RLS stays the security boundary
-- (guardrail #1); this is a rate boundary that lives alongside it in Postgres,
-- not in the client. SELECT, insert-attribution, and append-only semantics are
-- all unchanged.

-- Per-caller lookup index for the trailing-window count below (and for a
-- maintainer auditing one user's error volume). Complements the existing
-- created_at and trip_id indexes.
create index if not exists error_reports_user_created_idx
  on public.error_reports (user_id, created_at desc);

-- security definer so the count sees every row for the caller regardless of the
-- SELECT policy (which only exposes trip-owner-scoped rows) — the throttle must
-- count the caller's *actual* footprint, including trip_id IS NULL rows. Owned
-- by the migration role, so it bypasses RLS for the count; search_path pinned
-- per the hardening convention.
create or replace function public.enforce_error_report_rate_limit()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  -- ~20 rows/hour/caller: a couple of orders of magnitude above legitimate
  -- reporting (a handful of genuine errors), far below any exhaustion rate.
  -- The client already dedupes identical errors and caps per session, so a
  -- well-behaved caller never approaches this; it only bites a crash-loop or
  -- abuse.
  max_per_window constant int := 20;
  window_length constant interval := interval '1 hour';
  recent_count int;
begin
  -- Count by the row's user_id: the INSERT policy pins user_id = auth.uid(),
  -- so a forged user_id is rejected by RLS afterward regardless, and a
  -- legitimate caller is counted against their own footprint.
  select count(*)
    into recent_count
    from public.error_reports
   where user_id = new.user_id
     and created_at > now() - window_length;

  if recent_count >= max_per_window then
    -- Client swallows this (fire-and-forget); no user-facing error, no
    -- recursion back into the error pipeline.
    raise exception 'ERROR_REPORT_RATE_LIMIT'
      using hint = 'Too many error reports from this caller in the trailing window.';
  end if;

  return new;
end;
$$;

create trigger error_reports_rate_limit
  before insert on public.error_reports
  for each row execute function public.enforce_error_report_rate_limit();
