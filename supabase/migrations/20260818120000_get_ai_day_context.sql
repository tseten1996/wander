-- One read for everything "Improve this day" needs — epic #209, slice 3 (#213).
--
-- SECURITY INVOKER is the important word, and it is a deliberate contrast with
-- record_ai_usage's SECURITY DEFINER. This function inherits the caller's row
-- policies, so it cannot leak across trips even if the Pages Function is handed
-- a trip id its caller has no business seeing: a non-member gets a shape full
-- of nulls and an empty items array, not another group's day.
--
-- Reserve SECURITY DEFINER for operations that genuinely need to exceed the
-- caller's rights. On the read path that is none of them — appending an audit
-- row needs privilege, reading your own trip does not.
--
-- WHY AN RPC AT ALL, rather than four selects from the function: one round trip
-- instead of four from an edge runtime that pays latency on each, and — more
-- importantly — the *shape* of the AI context is defined here, in one place,
-- next to the schema it reads. A context that drifts from the schema is how a
-- model ends up reasoning about a column that no longer means what it did.
--
-- NOTE WHAT IS ABSENT: no member names, no created_by, no paid_by, no notes.
-- docs/AI-ARCHITECTURE.md §6 makes it a rule of the *builder* rather than of
-- each call site — "never put a person in the context" — and this is where that
-- rule is actually enforced, because a field that is never selected cannot be
-- forgotten about later. `notes` is out for the same reason: it is free text a
-- member typed, so it is the most likely place for a name or a booking
-- reference to be hiding.
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
      from budget_entries b where b.trip_id = p_trip_id and b.entry_date = p_day)
  );
$$;

-- Anonymous invite-link friends are ordinary trip members, so `authenticated`
-- (which covers anonymous sessions) is the grant. A caller with no session has
-- no trip to read and RLS would return nothing anyway; revoking is belt and
-- braces on a function that is cheap to call.
revoke execute on function public.get_ai_day_context(uuid, date) from public, anon;
grant execute on function public.get_ai_day_context(uuid, date) to authenticated;
