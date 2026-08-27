-- Member arrival & departure dates (#286, epic #285 slice 1)
--
-- A friend who arrives Thursday on a trip that started Tuesday has no way to
-- say so today, so the calendar and presence surfaces treat them as present for
-- the whole week. This adds two nullable dates to `members` — `arrives_on` /
-- `departs_on` — both null meaning "here for the whole trip" (so a trip that
-- never sets a date behaves exactly as before). This slice only *displays* the
-- dates; it changes no permission.
--
-- Guardrail notes:
--   • RLS is untouched. `members_update` (init) already permits a member to
--     write their own row and the owner to write any member's row — the exact
--     two cases this feature needs. The only widening is at the COLUMN grant
--     level (init revoked blanket UPDATE and re-granted just display_name/color,
--     lines 442–443 of the init migration); the two new columns must join that
--     grant or the policy would allow a write the grant still blocks.
--   • `members` is already in the `supabase_realtime` publication (init), which
--     is the deliberate decision here: presence dates are a live surface (the
--     calendar and the "who's here today" header update as members set them), so
--     the table stays published — no publication change is required.

alter table public.members
  add column arrives_on date,
  add column departs_on date;

comment on column public.members.arrives_on is
  'Optional day this member arrives; null = present from the trip start. Constrained to the trip''s date range.';
comment on column public.members.departs_on is
  'Optional day this member departs; null = present to the trip end. Must be on or after arrives_on and within the trip''s date range.';

-- Same-row ordering: a departure is never before an arrival. A cross-table
-- CHECK is impossible (a CHECK cannot read `trips`), so the trip-range bound is
-- enforced by the trigger below; this half is a plain CHECK per the issue.
alter table public.members
  add constraint members_dates_order
  check (arrives_on is null or departs_on is null or departs_on >= arrives_on);

-- Trip-range bound: each set date must fall inside the trip's own
-- [start_date, end_date] when those are set. Enforced server-side (not only in
-- the client) via a validate-only trigger, since a CHECK cannot reference the
-- parent `trips` row. SECURITY DEFINER so the lookup never depends on the
-- caller's RLS view of `trips`; it only ever raises, never writes.
create or replace function public.members_validate_trip_dates()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
  v_end   date;
begin
  -- No dates set → "here the whole trip", nothing to validate.
  if new.arrives_on is null and new.departs_on is null then
    return new;
  end if;

  select start_date, end_date into v_start, v_end
  from public.trips
  where id = new.trip_id;

  if new.arrives_on is not null then
    if v_start is not null and new.arrives_on < v_start then
      raise exception 'arrives_on % is before the trip start %', new.arrives_on, v_start
        using errcode = 'check_violation';
    end if;
    if v_end is not null and new.arrives_on > v_end then
      raise exception 'arrives_on % is after the trip end %', new.arrives_on, v_end
        using errcode = 'check_violation';
    end if;
  end if;

  if new.departs_on is not null then
    if v_start is not null and new.departs_on < v_start then
      raise exception 'departs_on % is before the trip start %', new.departs_on, v_start
        using errcode = 'check_violation';
    end if;
    if v_end is not null and new.departs_on > v_end then
      raise exception 'departs_on % is after the trip end %', new.departs_on, v_end
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

-- Fires only when a presence date is actually written, so ordinary
-- name/colour edits (and the null-dated join/owner-row inserts) skip it.
create trigger members_validate_trip_dates
  before insert or update of arrives_on, departs_on on public.members
  for each row execute function public.members_validate_trip_dates();

-- Extend the column-level UPDATE grant. init (lines 442–443) revoked blanket
-- UPDATE and re-granted only (display_name, color); without adding the two new
-- columns here, `members_update` would allow the row but the grant would still
-- reject writing the dates.
grant update (display_name, color, arrives_on, departs_on)
  on public.members to authenticated;
