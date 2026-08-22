-- Fold stated trip preferences into the AI day context — epic #209, slice 4 (#268).
--
-- get_ai_day_context is the single retrieval path for "improve this day" (#213):
-- one read that defines the SHAPE of the AI context next to the schema it reads
-- (see 20260818120000_get_ai_day_context.sql). This slice adds the group's
-- stated preferences to that shape so the model, when it chooses between the
-- server's plans, can pick the one that fits how this group actually travels.
--
-- STILL SECURITY INVOKER: the added read of trip_preferences inherits the
-- caller's RLS, so a non-member gets `preferences: null` here for the same
-- reason they get an empty day — the function cannot exceed the caller's rights.
--
-- ON THE "NEVER PUT A PERSON IN THE CONTEXT" RULE (§6): the original function
-- deliberately omits member names, created_by, paid_by and itinerary `notes`,
-- because those carry member identity or are where a name might hide. The
-- preferences row is different in kind: it is GROUP-authored, group-owned
-- content with no member identity on it (the `updated_by` audit column is not
-- selected here), and it is the very thing this slice exists to send. It is
-- returned as data the caller stated, and the prompt builder fences it as data
-- and never as instructions.

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
      from trip_preferences p where p.trip_id = p_trip_id)
  );
$$;

-- Grants are unchanged from the original definition, but `create or replace`
-- preserves them, so nothing to re-grant. Kept SECURITY INVOKER on purpose.
