-- #95: harden the multi-currency budget columns added in #79 with a structural
-- CHECK constraint. Those columns (`currency`, `estimated_converted`,
-- `actual_converted`, `exchange_rate`) are all nullable and their consistency
-- was enforced only in the client (`BudgetPage.tsx` onSubmit). But per
-- guardrail #1 RLS is the security boundary and any trip member writes straight
-- to Postgres with the anon key — so a hand-crafted "half-populated foreign
-- row" (e.g. `currency` set but no `exchange_rate`, or a `*_converted` value
-- with no `currency`) could slip past the UI. Roll-ups read `converted ?? raw`
-- (`amounts.ts`), so such a row would be silently mis-counted in the trip
-- currency, corrupting totals and the settle-up card.
--
-- The rule enforced is deliberately *structural* — "either fully trip-currency,
-- or a well-formed foreign row":
--   • trip-currency row: all four columns null (every pre-existing row), or
--   • foreign row: a 3-letter ISO `currency` and a positive `exchange_rate`.
--
-- The foreign branch guards `currency`/`exchange_rate` with explicit
-- `is not null` checks: a CHECK constraint rejects a row only when the predicate
-- is FALSE, and passes it when the predicate is NULL (SQL three-valued logic).
-- Without the guards, a half-populated foreign row (`currency='EUR'` with a null
-- `exchange_rate`) makes `exchange_rate > 0` evaluate to NULL, so
-- `FALSE or NULL = NULL` and the malformed row would be accepted — exactly the
-- corruption this constraint exists to reject.
--
-- It intentionally does NOT assert `estimated_converted = round(estimated *
-- exchange_rate, 2)`: that equality can't see the trip currency (it lives on
-- `trips`, not this table) and would reject legitimate client writes on
-- JS<->Postgres rounding differences. The `*_converted` columns stay
-- unconstrained in the foreign branch on purpose — a foreign entry with only an
-- estimated (or only an actual) amount legitimately leaves the other converted
-- value null (see onSubmit: `foreign && estimated != null ? ... : null`).
--
-- All existing rows are trip-currency (all four columns null) so they satisfy
-- the first branch — safe to add without a backfill. Guarded in a DO block so
-- the migration stays idempotent: Postgres has no ADD CONSTRAINT IF NOT EXISTS.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'budget_entries_currency_consistency'
      and conrelid = 'public.budget_entries'::regclass
  ) then
    alter table public.budget_entries
      add constraint budget_entries_currency_consistency check (
        (currency is null and exchange_rate is null
           and estimated_converted is null and actual_converted is null)
        or (currency is not null and currency ~ '^[A-Z]{3}$'
            and exchange_rate is not null and exchange_rate > 0)
      );
  end if;
end $$;
