-- #238 (epic #205, slice 2): a token-shared, read-only public post-trip recap.
--
-- Slice 1 (#206) built the private on-dashboard recap card; this slice makes a
-- finished trip into a shareable artifact — the epic's word-of-mouth growth
-- loop. It reuses the proven public-share mechanism from #127 rather than
-- inventing a second one:
--
--   * The capability is the SAME owner-minted, revocable `share_token` on
--     `trips` that #127 mints (via set_trip_share). There is deliberately no
--     second token and no new join path.
--   * The recap is exposed through ONE token-validating SECURITY DEFINER RPC
--     (`get_public_recap`) that hand-picks a whitelisted, read-only projection —
--     exactly the #127 pattern. There is NO public SELECT policy on any base
--     table; the recap page is a one-shot RPC snapshot for someone with no
--     session and no membership.
--   * Sharing a recap is a deliberate, separate opt-in: the new `recap_shared`
--     flag. A trip is publicly shared (#127) without its recap being shared, and
--     the recap projection is gated on this flag PLUS the trip having ended —
--     so a valid link before the trip ends reads "not ready yet", never a leak
--     and never an empty page.
--
-- Consistent with #127, the recap projection carries NO costs and NO member
-- identity: #127 deliberately excluded costs and names from the public
-- itinerary, and the recap holds that line — aggregate counts and the located
-- stops (place names the itinerary share already exposes) only. Nothing
-- per-member, no budget figures, no notes, no invite code.

-- ─────────────────────────────────────────────────────────────────────────────
-- Column: an explicit, separate opt-in for recap sharing, off by default.
-- ─────────────────────────────────────────────────────────────────────────────
-- Governed by the EXISTING trips_select policy (owner-or-member) like every
-- other trips column — a non-member cannot read the row at all. The flag is only
-- ever turned into recap data by the SECURITY DEFINER RPC below, which runs past
-- RLS but returns only the whitelisted projection.
alter table public.trips
  add column if not exists recap_shared boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime decision (required for any column touching shared content):
-- ─────────────────────────────────────────────────────────────────────────────
-- `trips` is already in the supabase_realtime publication; a new column of an
-- already-published table replicates automatically, and realtime still applies
-- RLS per subscriber — so `recap_shared` only ever reaches owner/member
-- subscribers, never an outsider. The public recap page itself does NOT
-- subscribe to realtime: it is a one-shot, RPC-only read-only snapshot for
-- someone with no session. Therefore: NO publication change.

-- ─────────────────────────────────────────────────────────────────────────────
-- Owner-only: opt this trip's recap in / out of public sharing. A server-side
-- capability, so it is a SECURITY DEFINER RPC that validates its inputs — never
-- a client-side write. It sets only the flag; the `share_token` capability is
-- minted / revoked by #127's set_trip_share (the single public-share switch), so
-- the recap link works exactly while public sharing is on.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_trip_recap_share(p_trip_id uuid, p_enabled boolean)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null or not is_trip_owner(p_trip_id) then
    raise exception 'NOT_OWNER';
  end if;

  update trips
    set recap_shared = p_enabled
    where id = p_trip_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public, token-scoped read. SECURITY DEFINER so it can read past RLS, but it
-- returns ONLY the explicitly whitelisted, non-sensitive fields below, and only
-- for a trip whose `share_token` matches, whose `recap_shared` is on, and which
-- is not archived. Three outcomes, distinct on purpose:
--
--   * SQL NULL — an absent / blank / too-short / unknown / revoked token, or a
--     trip whose recap is not shared. The page renders "link unavailable",
--     never partial data.
--   * {"status":"pending"} — a valid, shared link whose trip has NOT ended yet.
--     Gated exactly like the #206 recap card (end date must have passed), so the
--     page shows a friendly "recap not ready yet" rather than an empty page.
--   * {"status":"ready", ...} — the whitelisted recap.
--
-- COLUMN REVIEW (the whitelist — this is the entire public attack surface):
--   trip:   name, destination, start_date, end_date
--   stats:  stops (count of itinerary_items), travelers (count of members)
--   places: id, title, category, location   (located stops only)
-- Deliberately EXCLUDED, mirroring #127: invite_code, share_token, owner_id,
-- description, cover_url; any cost/budget figure (no line items, no totals, no
-- settle-up); itinerary times, notes, url, coordinates, created_by; and any
-- member identity (display_name / email / created_by is never joined in — only
-- the aggregate count leaves the function).
create or replace function public.get_public_recap(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  t public.trips;
  v_meta jsonb;
begin
  if p_token is null or length(p_token) < 16 then
    return null;
  end if;

  select * into t
  from trips
  where share_token = p_token
    and recap_shared
    and not archived
  limit 1;

  if not found then
    return null;
  end if;

  -- Whitelisted trip meta, shared by the pending and ready shapes.
  v_meta := jsonb_build_object(
    'name', t.name,
    'destination', t.destination,
    'start_date', t.start_date,
    'end_date', t.end_date
  );

  -- Gated like the #206 recap card: only once the trip's end date has passed.
  -- A trip with no end date can never "end", so it stays pending — the link is
  -- valid but there is nothing to show yet.
  if t.end_date is null or t.end_date >= current_date then
    return jsonb_build_object('status', 'pending', 'trip', v_meta);
  end if;

  return jsonb_build_object(
    'status', 'ready',
    'trip', v_meta,
    'stats', jsonb_build_object(
      'stops', (select count(*) from itinerary_items i where i.trip_id = t.id),
      'travelers', (select count(*) from members m where m.trip_id = t.id)
    ),
    'places', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'title', i.title,
          'category', i.category,
          'location', i.location
        )
        order by i.day nulls last, i.position
      )
      from itinerary_items i
      where i.trip_id = t.id
        and i.location is not null
        and length(btrim(i.location)) > 0
    ), '[]'::jsonb)
  );
end;
$$;

-- Execution grants. get_public_recap is the intentionally-public surface: an
-- unauthenticated visitor (the `anon` role, no session) must be able to call it.
-- set_trip_recap_share is owner-only management, so anon is revoked (its body
-- also guards with is_trip_owner, this is defence in depth).
grant execute on function public.get_public_recap(text) to anon, authenticated;
revoke execute on function public.set_trip_recap_share(uuid, boolean) from public;
grant execute on function public.set_trip_recap_share(uuid, boolean) to authenticated;
