-- Extend get_invite_preview to expose the avatar colours already in use on the
-- trip, so the join page can default a joining friend to an *unused* swatch and
-- dim the taken ones (#234). The colours carry no member names or other PII —
-- just the hex strings — and the projection stays a whitelisted, token-guarded
-- SECURITY DEFINER RPC: no new join path, no public SELECT on any base table.
--
-- Adding a return column changes the function's signature, which CREATE OR
-- REPLACE cannot do, so we DROP and recreate. A DROP resets grants to the
-- default (EXECUTE to public), so the hardening revoke (20260719012632) is
-- re-applied here to keep `anon` — and requests with no session — locked out.

drop function if exists public.get_invite_preview(text);

create or replace function public.get_invite_preview(p_invite_code text)
returns table (
  trip_name text,
  destination text,
  cover_url text,
  member_count bigint,
  start_date date,
  end_date date,
  taken_colors text[]
)
language sql stable security definer
set search_path = public
as $$
  select t.name, t.destination, t.cover_url,
         (select count(*) from members m where m.trip_id = t.id),
         t.start_date, t.end_date,
         coalesce(
           (select array_agg(distinct m.color)
              from members m
             where m.trip_id = t.id and m.color is not null),
           '{}'::text[]
         )
  from trips t
  where t.invite_code = p_invite_code
    and t.invite_enabled
    and not t.archived;
$$;

revoke execute on function public.get_invite_preview(text) from public, anon;
