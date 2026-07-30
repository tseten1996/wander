-- #147: re-denominate existing entries, repayments and the total budget when
-- the trip currency changes.
--
-- #146 stopped a currency change from *silently* relabelling every stored
-- amount (a USD 500 expense becoming "JPY 500"), but the change itself still
-- corrupted the trip's money — it only warned first. This RPC makes the
-- operation correct: on a confirmed change the trip's money is converted in
-- one server-side transaction at a single old→new rate captured at switch
-- time, so totals, category bars, the budget bar and settle-up keep their real
-- value across the switch.
--
-- SECURITY DEFINER, mirroring join_trip / duplicate_trip / merge_member: the
-- client is UX, Postgres is the boundary (guardrail #1), and the whole
-- re-denomination is atomic — a failure (constraint violation, overflow)
-- rolls back everything and leaves the trip untouched. Owner-only, matching
-- the `trips` RLS update policy that gates the currency field itself.
--
-- The rate is supplied by the client (from the same ECB/Frankfurter table the
-- Budget form already uses to seed foreign entries — rates.ts): Postgres
-- cannot fetch it, and the owner could equally write any amounts directly, so
-- a client-supplied positive rate widens nothing. It is recorded in the
-- activity feed so the conversion is auditable.
--
-- Multi-currency invariant (#79/#111): an entry's ORIGINAL amount and its
-- original rate are never rewritten by later events — only the derived
-- trip-currency projection (`*_converted`) moves. Concretely, per row class:
--   • trip-currency rows (currency null): the original figures are preserved
--     by becoming an ordinary foreign entry denominated in the OLD trip
--     currency — `currency` := old code, `exchange_rate` := old→new rate,
--     `*_converted` := raw × rate.
--   • foreign rows in some third currency: keep `currency`, the raw amounts
--     and their original→old history; the chained original→new rate is
--     `(original→old) × (old→new)` and `*_converted` is recomputed from the
--     RAW amount at the chained rate (not from the old converted value, which
--     would compound its cent rounding).
--   • foreign rows already denominated in the NEW trip currency: collapse to
--     native trip-currency rows (all four currency columns null). The person
--     paid exactly `raw` in what is now the trip currency, so the original
--     amount — not a round-tripped conversion of it — becomes the canonical
--     figure. This is the one case where a frozen rate is dropped, precisely
--     because it no longer projects into anything.
-- The single-UPDATE-with-CASE shape matters: every right-hand side reads the
-- row's OLD values, so the three classes can't contaminate each other (a
-- sequential version that relabelled trip-currency rows first would then
-- chain-convert them a second time).
--
-- Repayments get the identical treatment. Their table deliberately has no
-- UPDATE policy ("a repayment is an immutable record" — repayments.sql); that
-- immutability targets members rewriting history via PostgREST, not this
-- controlled, value-preserving projection change, which SECURITY DEFINER
-- performs below RLS.
create or replace function public.redenominate_trip(
  p_trip_id uuid,
  p_new_currency text,
  -- old→new multiplier: an amount in the old trip currency × p_rate = the same
  -- value in the new trip currency.
  p_rate numeric,
  -- The new total budget, already in the NEW currency, when the owner edited
  -- the figure in the same save; null means "convert the stored budget".
  p_estimated_budget numeric default null
)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_old text;
  v_new text := upper(btrim(p_new_currency));
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Access boundary: only the trip owner may re-denominate. Re-checked here
  -- because SECURITY DEFINER bypasses the row-level policies.
  if not is_trip_owner(p_trip_id) then
    raise exception 'NOT_ALLOWED';
  end if;

  if v_new !~ '^[A-Z]{3}$' then
    raise exception 'BAD_CURRENCY';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'BAD_RATE';
  end if;

  select upper(currency) into v_old from trips where id = p_trip_id;

  -- Idempotent replay (double-submit, retried request): nothing to convert.
  if v_old = v_new then
    return;
  end if;

  update budget_entries set
    estimated_converted = case
      when currency is null
        then round(estimated * p_rate, 2)
      when upper(currency) = v_new
        then null
      else round(estimated * exchange_rate * p_rate, 2)
    end,
    actual_converted = case
      when currency is null
        then round(actual * p_rate, 2)
      when upper(currency) = v_new
        then null
      else round(actual * exchange_rate * p_rate, 2)
    end,
    exchange_rate = case
      when currency is null then p_rate
      when upper(currency) = v_new then null
      else exchange_rate * p_rate
    end,
    currency = case
      when currency is null then v_old
      when upper(currency) = v_new then null
      else currency
    end
  where trip_id = p_trip_id;

  update repayments set
    amount_converted = case
      when currency is null
        then round(amount * p_rate, 2)
      when upper(currency) = v_new
        then null
      else round(amount * exchange_rate * p_rate, 2)
    end,
    exchange_rate = case
      when currency is null then p_rate
      when upper(currency) = v_new then null
      else exchange_rate * p_rate
    end,
    currency = case
      when currency is null then v_old
      when upper(currency) = v_new then null
      else currency
    end
  where trip_id = p_trip_id;

  update trips set
    currency = v_new,
    estimated_budget = coalesce(p_estimated_budget, round(estimated_budget * p_rate, 2))
  where id = p_trip_id;

  -- Audit trail (#147 AC): the rate used is recorded in the activity feed.
  -- trim_scale keeps "0.00680000" from reading as noise in the dashboard feed.
  insert into activity (trip_id, member_id, verb, subject)
  values (
    p_trip_id,
    my_member_id(p_trip_id),
    'changed the trip currency',
    v_old || ' → ' || v_new || ' at 1 ' || v_old || ' = '
      || trim_scale(round(p_rate, 8))::text || ' ' || v_new
  );
end;
$$;

-- Keep the RPC surface minimal (mirrors 20260719012632_hardening.sql): strip
-- the auto-granted EXECUTE from public + anon so a session-less request can
-- never reach this SECURITY DEFINER function; `authenticated` retains it.
revoke execute on function public.redenominate_trip(uuid, text, numeric, numeric)
  from public, anon;
