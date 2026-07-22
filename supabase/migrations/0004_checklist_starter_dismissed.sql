-- #42: empty-trip onboarding — a one-tap starter-pack offer on a brand-new,
-- empty checklist. We persist a per-trip "dismissed" flag so that once anyone
-- seeds the starter tasks or waves the offer away, it never nags again for
-- that trip. Accepting the offer just creates ordinary checklist_items (which
-- makes the list non-empty and hides the offer on its own); the flag exists
-- only to remember an explicit dismissal while the list is still empty.

alter table public.trips
  add column if not exists checklist_starter_dismissed boolean not null default false;

-- Any trip member can dismiss the offer, but trips_update is owner-only (the
-- owner controls trip settings). A SECURITY DEFINER RPC — mirroring join_trip —
-- lets a member flip just this one flag without widening the update policy.
create or replace function public.dismiss_checklist_starter(p_trip_id uuid)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if not public.is_trip_member(p_trip_id) then
    raise exception 'NOT_A_MEMBER';
  end if;
  update trips set checklist_starter_dismissed = true where id = p_trip_id;
end;
$$;

-- Only signed-in members (owner or the anonymous join session) may call it;
-- `anon` (no session at all) gets nothing, matching the other RPCs.
revoke execute on function public.dismiss_checklist_starter(uuid) from public, anon;
