-- Fold the day's stay + transport into the AI day context — epic #209 (AI),
-- epic #346 (logistics), issue #375.
--
-- get_ai_day_context is the single retrieval path for "improve this day" (#213):
-- one read that defines the SHAPE of the AI context next to the schema it reads
-- (see 20260818120000_get_ai_day_context.sql, extended for preferences in
-- 20260822141700_ai_day_context_preferences.sql). It already folds in the trip
-- currency, the leg the day falls in (#197), the day's itinerary items with
-- coordinates, the day's spend, and the group's stated preferences (#268) — but
-- it was blind to two things the logistics epic shipped after it:
--
--   * the STAY the group is sleeping in that night, and
--   * the TRANSPORT arriving or departing that day.
--
-- So the model planned a day without knowing where the group is based or that a
-- 14:30 train eats half the afternoon, and the "$0 SQL near the hotel" answer
-- (docs/AI-ARCHITECTURE.md §7) had no hotel coordinate to anchor its bounding
-- box. This slice adds those two fields, computed the same deterministic SQL way
-- as the existing ones. Now that Stays (#348) and Transport (#350) have shipped,
-- the AI day-context is the one consumer surface the epic left unwired (#346).
--
-- STILL SECURITY INVOKER. The added reads of `stays` and `transport` inherit the
-- caller's RLS (both tables are member-select trip-scoped — 20260915142000_stays,
-- 20260921143000_transport), so a non-member passing a trip id they can't see
-- gets `stay: null` and `transport: []` here for the same reason they get an
-- empty `items` — the function cannot exceed the caller's rights. Reserve
-- SECURITY DEFINER for operations that genuinely need to; a read is not one.
--
-- ON THE "NEVER PUT A PERSON IN THE CONTEXT" RULE (§6): this stays clean by
-- construction. Stays and transport carry no member name and no display_name;
-- their `member_id` (authorship) is deliberately NOT selected, exactly as the
-- original function omits itinerary `created_by` and `paid_by`. The booking's
-- `confirmation_code` and `booking_url` are also left out — not identity, but not
-- something the planner needs, and a booking URL is the kind of free text a name
-- can hide in. What is returned is logistics only: where you sleep and how you
-- move.
--
-- The two fields reuse the shipped date rules verbatim, so the context matches
-- what the calendar shows the group:
--   * stay: the stay whose HALF-OPEN [check_in, check_out) contains p_day
--     (src/features/stays/dates.ts) — you sleep there on check-in through the
--     night before check-out, not the check-out morning. Earliest check-in wins
--     when hand-entered windows overlap. Null when no dated stay covers the day.
--   * transport: hops whose depart OR arrive DATE PREFIX is p_day
--     (src/features/transport/dates.ts). `depart_at`/`arrive_at` are timestamps
--     WITHOUT time zone (wall-clock), so `::date` is the calendar day with no
--     timezone shift — the same date-prefix the client derives. An overnight hop
--     surfaces on both the day it departs and the day it arrives. Empty when none.
--
-- ADDITIVE JSON: existing callers (src/server/ai/handler.ts reads items/leg/
-- preferences) are untouched; new keys are simply ignored by a caller that does
-- not read them. The fields are short and at most a handful of rows per day, so
-- the assembled context stays well inside the ~1,000-token cap (§3).

create or replace function public.get_ai_day_context(p_trip_id uuid, p_day date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'trip', (select jsonb_build_object('currency', t.currency)
      from trips t where t.id = p_trip_id),
    -- The leg this day falls in (#197), so the model is grounded in one city
    -- rather than the whole trip. Falls back to trips.destination for the
    -- legless trips that are still the common case.
    'leg', coalesce((
      select jsonb_build_object('name', d.name, 'startDate', d.start_date, 'endDate', d.end_date)
      from destinations d
      where d.trip_id = p_trip_id
        and d.start_date <= p_day and coalesce(d.end_date, d.start_date) >= p_day
      order by d.position limit 1),
      (select jsonb_build_object('name', t.destination) from trips t where t.id = p_trip_id)),
    'day', p_day,
    -- Spanning items (#166) are included on every day they cover: a hotel whose
    -- check-in was Tuesday still constrains Thursday, and a generator that
    -- cannot see it will happily schedule an activity over the check-out.
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'title', i.title, 'category', i.category,
        'startTime', i.start_time, 'endTime', i.end_time,
        'day', i.day, 'endDay', i.end_day,
        'location', i.location, 'lat', i.latitude, 'lng', i.longitude,
        'cost', i.cost, 'position', i.position)
        order by i.start_time nulls last, i.position)
      from itinerary_items i
      where i.trip_id = p_trip_id
        and (i.day = p_day or (i.day <= p_day and i.end_day >= p_day))
    ), '[]'::jsonb),
    'daySpend', (select coalesce(sum(coalesce(b.actual_converted, b.actual, 0)), 0)
      from budget_entries b where b.trip_id = p_trip_id and b.entry_date = p_day),
    -- The group's stated preferences (#268). NULL when the group has not stated
    -- any (no row) — the builder treats null as absent and the prompt is
    -- unchanged. camelCase keys match the rest of this object's convention.
    'preferences', (
      select jsonb_build_object(
        'pace', p.pace,
        'budgetStyle', p.budget_style,
        'interests', coalesce(to_jsonb(p.interests), '[]'::jsonb),
        'dietary', coalesce(to_jsonb(p.dietary), '[]'::jsonb),
        'notes', p.notes)
      from trip_preferences p where p.trip_id = p_trip_id),
    -- The stay covering this night (#375, epic #346). Half-open
    -- [check_in, check_out): sleep there on check-in through the night before
    -- check-out, not the check-out morning (stays/dates.ts). Only dated stays can
    -- cover a day; earliest check-in wins if hand-entered windows overlap. The
    -- coordinate is what lets a "what's near the hotel?" follow-up run the
    -- bounding-box + haversineKm path §7 describes. NULL when none. No person:
    -- name + coordinate + window only, never member_id or booking details.
    'stay', (
      select jsonb_build_object(
        'name', s.name,
        'lat', s.latitude,
        'lng', s.longitude,
        'checkIn', s.check_in,
        'checkOut', s.check_out)
      from stays s
      where s.trip_id = p_trip_id
        and s.check_in is not null and s.check_out is not null
        and s.check_in <= p_day and p_day < s.check_out
      order by s.check_in
      limit 1),
    -- The transport hops touching this day (#375, epic #346). A hop is on this
    -- day when its depart OR arrive DATE PREFIX is p_day (transport/dates.ts);
    -- `::date` on a wall-clock `timestamp` is timezone-immune, matching the
    -- client. An overnight hop appears on both its depart and arrive days, like
    -- the calendar. Empty array when none. No person: mode + times + places only.
    'transport', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mode', tr.mode,
        'departAt', tr.depart_at,
        'arriveAt', tr.arrive_at,
        'from', tr.depart_place,
        'to', tr.arrive_place)
        order by tr.depart_at nulls last, tr.arrive_at nulls last)
      from transport tr
      where tr.trip_id = p_trip_id
        and (tr.depart_at::date = p_day or tr.arrive_at::date = p_day)
    ), '[]'::jsonb)
  );
$$;

-- Grants are unchanged from the original definition, and `create or replace`
-- preserves them, so nothing to re-grant. Kept SECURITY INVOKER on purpose.
