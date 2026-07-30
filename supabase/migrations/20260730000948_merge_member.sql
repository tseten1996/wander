-- #124 (epic #97, slice 2): owner-side duplicate-member cleanup.
--
-- When iOS Safari evicts a friend's localStorage after ~7 days, that friend
-- returns with a fresh anonymous uid, sees the name form again, and re-joins —
-- minting a SECOND members row for one real person. Their old messages, votes,
-- checklist/itinerary/budget attributions stay bound to the dead uid and are
-- orphaned; to the group the old rows look like a stranger. Removing the empty
-- duplicate is already possible (the owner can delete a member row directly —
-- the members_delete policy allows it), but there was no way to *merge*: to
-- reassign the stale row's authored history onto the surviving row before
-- dropping it.
--
-- This adds `merge_member`, a SECURITY DEFINER RPC that does exactly that in one
-- transaction, mirroring the join_trip / duplicate_trip pattern:
--   • the client is UX, Postgres is the boundary (guardrail #1) — the RPC runs
--     server-side so the reassignment can't be driven or forged from an
--     untrusted client;
--   • owner-only (guardrail #4) — gated on is_trip_owner, re-checked here
--     because SECURITY DEFINER bypasses the row-level policies below it;
--   • no new tables, no new join path, no client-writable capability, so RLS,
--     the realtime publication, and the invite/join flow are all untouched.
--     Every row it rewrites lives in an already-published, already-policied
--     content table, so members subscribed to the trip see the merge live.
--
-- The duplicate's id appears as a foreign key across most content tables. Two
-- classes of reference need care, because a blind reassignment would violate a
-- constraint:
--   • UNIQUE constraints (votes: one per member per poll; message_reactions:
--     one emoji per member per message) — if the survivor already has the row,
--     drop the duplicate's rather than collide. The survivor's choice wins.
--   • uniqueness *within* a row (budget_entries.participants is a uuid[] with a
--     "distinct, non-null" CHECK; repayments has a from_member <> to_member
--     CHECK) — dedupe the array after substitution; drop a repayment that would
--     become a self-payment (a transfer between the two merged identities is,
--     once merged, one person paying themselves — it nets to nothing).
-- Every other reference is a plain attribution column and is reassigned as-is.

create or replace function public.merge_member(
  p_trip_id uuid,
  p_duplicate uuid,
  p_survivor uuid
)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_dup members%rowtype;
  v_surv members%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Owner-only (guardrail #4). SECURITY DEFINER bypasses RLS, so the ownership
  -- check that the UI shows is *enforced* here, not merely displayed.
  if not is_trip_owner(p_trip_id) then
    raise exception 'NOT_ALLOWED';
  end if;

  if p_duplicate = p_survivor then
    raise exception 'SAME_MEMBER';
  end if;

  -- Both rows must belong to THIS trip — never reassign history across trips.
  select * into v_dup from members where id = p_duplicate and trip_id = p_trip_id;
  if not found then
    raise exception 'DUPLICATE_NOT_FOUND';
  end if;

  select * into v_surv from members where id = p_survivor and trip_id = p_trip_id;
  if not found then
    raise exception 'SURVIVOR_NOT_FOUND';
  end if;

  -- The owner's row is undeletable (members_delete restricts to role='member')
  -- and the owner uses a magic link, so is never the evicted duplicate. Refuse
  -- to remove it as the duplicate, matching that invariant.
  if v_dup.role = 'owner' then
    raise exception 'CANNOT_MERGE_OWNER';
  end if;

  -- ── Plain attribution columns (all ON DELETE SET NULL) ─────────────────────
  update polls            set created_by  = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;
  update messages         set member_id   = p_survivor where trip_id = p_trip_id and member_id   = p_duplicate;
  update questions        set member_id   = p_survivor where trip_id = p_trip_id and member_id   = p_duplicate;
  update checklist_items  set assignee_id = p_survivor where trip_id = p_trip_id and assignee_id = p_duplicate;
  update checklist_items  set created_by  = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;
  update itinerary_items  set created_by  = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;
  update budget_entries   set paid_by     = p_survivor where trip_id = p_trip_id and paid_by     = p_duplicate;
  update budget_entries   set created_by  = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;
  update packing_items    set added_by    = p_survivor where trip_id = p_trip_id and added_by    = p_duplicate;
  update notes            set created_by  = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;
  update inspiration_items set created_by = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;
  update activity         set member_id   = p_survivor where trip_id = p_trip_id and member_id   = p_duplicate;

  -- ── Votes: UNIQUE (poll_id, member_id) — one vote per member per poll. ─────
  -- Drop the duplicate's vote on any poll the survivor already voted in (keep
  -- the survivor's), then reassign whatever remains. Delete-before-update so
  -- the reassignment can never hit the unique index.
  delete from votes v
  where v.trip_id = p_trip_id
    and v.member_id = p_duplicate
    and exists (
      select 1 from votes s
      where s.poll_id = v.poll_id and s.member_id = p_survivor
    );
  update votes set member_id = p_survivor
  where trip_id = p_trip_id and member_id = p_duplicate;

  -- ── Reactions: UNIQUE (message_id, member_id, emoji) — same dedupe shape. ──
  delete from message_reactions r
  where r.trip_id = p_trip_id
    and r.member_id = p_duplicate
    and exists (
      select 1 from message_reactions s
      where s.message_id = r.message_id
        and s.member_id = p_survivor
        and s.emoji = r.emoji
    );
  update message_reactions set member_id = p_survivor
  where trip_id = p_trip_id and member_id = p_duplicate;

  -- ── Repayments: from_member / to_member with CHECK from_member <> to_member.
  -- A repayment between the two merged identities becomes a payment from a
  -- person to themselves — meaningless, and it would trip the check — so drop
  -- it, then reassign the rest (including the created_by attribution).
  delete from repayments
  where trip_id = p_trip_id
    and (
      (from_member = p_duplicate and to_member = p_survivor) or
      (from_member = p_survivor and to_member = p_duplicate)
    );
  update repayments set from_member = p_survivor where trip_id = p_trip_id and from_member = p_duplicate;
  update repayments set to_member   = p_survivor where trip_id = p_trip_id and to_member   = p_duplicate;
  update repayments set created_by  = p_survivor where trip_id = p_trip_id and created_by  = p_duplicate;

  -- ── Budget split participants (uuid[], CHECK: distinct + non-null). ────────
  -- Substitute the duplicate's id with the survivor's, then collapse to a
  -- distinct set so an entry that already listed both stays clean (and doesn't
  -- hand the survivor a double share). array_agg(distinct) drops the duplicate
  -- element; the CHECK's non-null requirement already held before and holds now.
  update budget_entries be
  set participants = (
    select array_agg(distinct elem)
    from unnest(array_replace(be.participants, p_duplicate, p_survivor)) as elem
  )
  where be.trip_id = p_trip_id
    and be.participants is not null
    and p_duplicate = any(be.participants);

  -- ── Record the merge in the activity feed, attributed to the owner. ───────
  insert into activity (trip_id, member_id, verb, subject)
  values (p_trip_id, my_member_id(p_trip_id), 'merged a duplicate member into', v_surv.display_name);

  -- ── Finally, drop the now-orphaned duplicate row. ─────────────────────────
  delete from members where id = p_duplicate and trip_id = p_trip_id;
end;
$$;

-- Keep the RPC surface minimal (mirrors the hardening pass): Supabase
-- auto-grants EXECUTE on every new function to public/anon/authenticated. Strip
-- public + anon so a request with no session at all can't reach this SECURITY
-- DEFINER function; `authenticated` keeps execute (the owner-guard inside does
-- the real gating), so the Settings members flow is unaffected.
revoke execute on function public.merge_member(uuid, uuid, uuid) from public, anon;
