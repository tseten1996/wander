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
  -- The caller's real identity from the request JWT. auth.uid() is readable
  -- inside a SECURITY DEFINER function (it reads the request claim, not the
  -- function's role) and cannot be forged, unlike new.user_id.
  caller uuid := auth.uid();
  recent_count int;
begin
  -- Pin created_at server-side. The trailing-window count below keys on it, so
  -- a hostile caller who supplies a backdated created_at could otherwise place
  -- every row outside the window (recent_count stays 0) and never be throttled
  -- — the exact abuse vector this migration exists to close. The honest client
  -- omits created_at (DEFAULT now()); forcing it here makes now() the only
  -- possible value for everyone, not just the well-behaved.
  new.created_at := now();

  -- Serialize this caller's concurrent inserts. Without it a simultaneous burst
  -- could each read the same pre-insert count and collectively overshoot the
  -- cap (a count-then-insert TOCTOU). The advisory lock is keyed per caller and
  -- released at transaction end, so distinct callers never contend. coalesce
  -- guards the unauthenticated / service_role path (auth.uid() IS NULL), which
  -- RLS handles on its own.
  perform pg_advisory_xact_lock(
    hashtext('error_reports_rate_limit'),
    hashtext(coalesce(caller::text, ''))
  );

  -- Count by auth.uid(), not new.user_id. The BEFORE INSERT trigger runs before
  -- the RLS WITH CHECK that pins user_id = auth.uid(), so counting new.user_id
  -- would let a forged user_id probe another caller's throttle state (a rate
  -- oracle) before RLS rejects the row. Counting the real caller closes that.
  -- SECURITY DEFINER still lets the count see the caller's full footprint,
  -- including the trip_id IS NULL rows the SELECT policy hides.
  select count(*)
    into recent_count
    from public.error_reports
   where user_id = caller
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
