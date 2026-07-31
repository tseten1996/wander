-- #161: tighten budget_update RLS to creator-or-owner, matching budget_delete.
--
-- The policies on budget_entries were asymmetric. `budget_delete` restricts to
--   created_by = my_member_id(trip_id) or is_trip_owner(trip_id)
-- but `budget_update` (init.sql:542) only checked is_trip_member(trip_id). So
-- any trip member could PATCH a budget row directly through PostgREST —
-- changing paid_by / amount / participants and silently shifting settle-up
-- balances — even though after #138 the UI only offers Edit to the entry's
-- creator or the trip owner.
--
-- Per the Wander invariant "RLS is enforcement, the client is UX," the database
-- boundary must match the UI gate, not sit only in the client. Budget entries
-- are financial data that drive settle-up; unlike collaborative content
-- (checklist/itinerary/notes, where any-member update is the intended
-- shared-editing behaviour), an expense is owned by whoever logged it. Its
-- update policy therefore mirrors its delete policy exactly.
--
-- Both USING (the pre-image row must belong to the caller or the caller is
-- owner) and WITH CHECK (the post-image must too, so a creator cannot reassign
-- created_by to someone else) carry the same predicate.
--
-- Bulk updates that legitimately touch other members' rows — merge_member and
-- redenominate_trip — run SECURITY DEFINER and bypass RLS entirely, so they are
-- unaffected by this tightening.
drop policy if exists budget_update on public.budget_entries;
create policy budget_update on public.budget_entries for update
  using (created_by = my_member_id(trip_id) or is_trip_owner(trip_id))
  with check (created_by = my_member_id(trip_id) or is_trip_owner(trip_id));
