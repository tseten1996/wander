-- Replace the AI function's service-role write with a SECURITY DEFINER RPC.
--
-- 20260817090000_ai_usage.sql gave ai_usage no insert policy on purpose, which
-- meant the only way to write the ledger was the service-role key — a
-- credential that bypasses RLS on EVERY table. Holding that in a Pages Function
-- to append one row is wildly disproportionate: the blast radius of a mistake
-- is the entire database, and the job is "insert an audit row".
--
-- This is the pattern the rest of the repo already uses for a privileged
-- operation — join_trip, duplicate_trip, apply_availability_dates are all
-- SECURITY DEFINER functions that validate their own inputs. Following it here
-- means the AI runtime holds no database credential beyond the public anon key.
--
-- HONEST TRADE-OFF. The original migration claimed "no client can forge a usage
-- row, and that unforgeability is why the quota can be trusted." That is now
-- weaker: a member can call this RPC directly and inflate their own trip's
-- counter. Weigh what that actually buys an attacker — they can spend their own
-- trip's daily allowance faster, which they could equally do by using the
-- feature. They still cannot erase or backdate a row (there is deliberately no
-- update or delete policy), so the quota can be exhausted but never evaded.
-- Trading "a member can waste their own quota" for "no god-mode credential in a
-- new runtime" is a clear win.
create or replace function public.record_ai_usage(
  p_trip_id uuid,
  p_feature text,
  p_outcome text default 'ok',
  p_model text default '',
  p_input_tokens int default 0,
  p_output_tokens int default 0,
  p_estimated_cost_usd numeric default 0
)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- The access check. SECURITY DEFINER bypasses the row policies below it, so
  -- this is the only thing standing between a caller and another trip's ledger.
  if not is_trip_member(p_trip_id) then
    raise exception 'NO_ACCESS';
  end if;

  -- Validated here rather than trusted from the caller: outcome feeds the
  -- CHECK constraint, and the counters must not go negative or a caller could
  -- write rows that make usage reporting nonsense.
  if p_outcome not in ('ok', 'refused', 'failed') then
    raise exception 'BAD_OUTCOME';
  end if;

  insert into ai_usage (
    trip_id, member_id, feature, model,
    input_tokens, output_tokens, estimated_cost_usd, outcome
  )
  values (
    p_trip_id,
    -- Attribution is derived, never accepted from the caller: a member cannot
    -- log spend against someone else.
    my_member_id(p_trip_id),
    p_feature,
    coalesce(p_model, ''),
    greatest(coalesce(p_input_tokens, 0), 0),
    greatest(coalesce(p_output_tokens, 0), 0),
    greatest(coalesce(p_estimated_cost_usd, 0), 0),
    p_outcome
  );
end;
$$;

-- Anonymous friends are ordinary trip members and must be able to use AI, so
-- `authenticated` (which covers anonymous sessions) is the right grant. `public`
-- and `anon` are revoked: a caller with no session at all has no trip to write
-- against, and the body would reject them anyway.
revoke execute on function public.record_ai_usage(uuid, text, text, text, int, int, numeric) from public, anon;
grant execute on function public.record_ai_usage(uuid, text, text, text, int, int, numeric) to authenticated;
