-- #248 (epic #205, slice 3): a places-visited map + route on the public recap.
--
-- Slice 2 (#238) shipped the token-shared, read-only public recap as text and
-- aggregate counts. This slice draws where the trip actually went — the located
-- itinerary stops as an ordered route on a map — the single most forwardable
-- element of a recap. The map is rendered entirely client-side from the OSM
-- raster tiles already in use (no new outbound service, no key); the only thing
-- the server must add is the per-stop coordinates the map plots.
--
-- This is a pure, additive extension of the ONE existing token-validating
-- SECURITY DEFINER projection (`get_public_recap`). There is NO new public
-- SELECT policy, NO second token, and NO new base-table read — the same
-- whitelisted, owner-minted, revocable share-token surface from #238/#127, with
-- two more fields per already-exposed stop.
--
-- COORDINATE REVIEW (why adding lat/lon holds the #127/#238 privacy line):
--   * A stop's latitude/longitude is the map position of a *place* the recap
--     already names in plain text (`location`). It is the same public
--     information the "Where they went" list already exposes, expressed as a
--     point — not member identity, not a cost, not the invite code.
--   * It is emitted ONLY for stops that already pass the existing whitelist
--     (a trip whose recap_shared is on, that has ended, that is not archived),
--     in the SAME order (day, position). No new row is read; the `places`
--     aggregate simply carries two more columns of the rows it already returns.
--   * Still deliberately EXCLUDED, unchanged from #238: invite_code,
--     share_token, owner_id, description, cover_url; every cost/budget figure;
--     itinerary times, notes, url, created_by; and all member identity (only
--     the aggregate traveler count ever leaves the function).

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
          'location', i.location,
          -- Slice-3 addition: the map position of this already-named stop.
          -- Ordered by (day, position) so the recap map can draw the route in
          -- the same visit order the "Where they went" list reads.
          'latitude', i.latitude,
          'longitude', i.longitude
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

-- Grants are unchanged from #238 (get_public_recap is already granted to anon,
-- authenticated); CREATE OR REPLACE preserves them, restated here for clarity.
grant execute on function public.get_public_recap(text) to anon, authenticated;
