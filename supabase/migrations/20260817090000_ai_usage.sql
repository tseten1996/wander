-- AI usage ledger and per-trip quota — epic #209, slice 1 (issue #211).
--
-- Every invocation of the /api/ai Pages Function writes a row here, including
-- the ones it refuses. Two jobs:
--
--   1. Observability — what was spent, on what feature, for which trip.
--   2. The quota itself. The function counts a trip's rows in the trailing
--      window and refuses past the limit. Counting the ledger rather than
--      keeping a separate counter means the number shown to a member and the
--      number enforced against them can never disagree.
--
-- Refused and failed calls are recorded deliberately. A quota that only counts
-- successes lets a caller retry a failing request forever at full cost, and an
-- abuse pattern that never succeeds would be invisible in the logs.
--
-- WHY PER TRIP, NEVER PER USER: src/hooks/useAuth.tsx signs invite-link friends
-- in with signInAnonymously(), so anyone holding a link can mint unlimited
-- distinct auth.uid() values on demand. A per-user quota is a speed bump. Trip
-- creation is already restricted to non-anonymous users by the trips_insert
-- policy, which makes a trip the only identity in this system that costs
-- something to create — so it is the only one worth rate-limiting.

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- Set null rather than cascade: a member leaving must not erase the spend
  -- their calls caused, or leaving becomes a way to clear the ledger.
  member_id uuid references public.members(id) on delete set null,
  -- The intent that was served ('parse_booking', 'improve_day', …). Free text
  -- rather than a CHECK list: adding an intent should not need a migration,
  -- and an unknown value here is a reporting curiosity, not a data hazard.
  feature text not null,
  -- Empty string while no model is called (this slice), a model id later.
  model text not null default '',
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  estimated_cost_usd numeric(10, 6) not null default 0 check (estimated_cost_usd >= 0),
  -- How the call ended. 'refused' covers quota exhaustion and the kill switch;
  -- 'failed' covers an upstream or validation error. Both still cost a row.
  outcome text not null default 'ok' check (outcome in ('ok', 'refused', 'failed')),
  created_at timestamptz not null default now()
);

-- The quota query is exactly "rows for this trip since T", so the index leads
-- with trip_id and orders by time.
create index ai_usage_trip_recent_idx on public.ai_usage (trip_id, created_at desc);

alter table public.ai_usage enable row level security;

-- Members read their own trip's usage — this is what lets the app show "you've
-- used 3 of 20 today" with the same number the function enforces.
create policy ai_usage_select on public.ai_usage for select
  using (is_trip_member(trip_id));

-- There is deliberately NO insert / update / delete policy.
--
-- The function writes with the service role, which bypasses RLS entirely, so
-- omitting these policies means no client can forge a usage row, erase one to
-- reset its quota, or backdate one. That unforgeability is the whole reason the
-- quota can be trusted, and it is a property of the *absence* of policy — worth
-- stating explicitly so a later reader does not "fix" the omission.
--
-- (The RLS gate in scripts/check-invariants.mjs requires enable-RLS plus at
-- least one policy per created table in the same migration; the select policy
-- above satisfies it.)

-- Realtime publication decision: NO. Usage is a ledger read on demand, not
-- shared content anyone waits on, and publishing it would push a row to every
-- trip member on every AI call for no benefit.
