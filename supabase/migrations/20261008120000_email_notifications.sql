-- Wander: email as a notification channel — epic #181, the last closed-app slice
--
-- Slice 1 (#182) shipped the inbox, #193 added chat @-mentions, and #267/#309
-- added Web Push. Each of those reaches a member who has the app installed and
-- has granted notification permission. Email is the channel for everyone else:
-- the friend on desktop Safari, the member who declined the push prompt, the
-- person who will not see a badge until next Tuesday. It is also the only
-- channel that still works when the device is wiped — which matters here,
-- because an invited friend's session is anonymous and Local Storage is all
-- that holds it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NOT SHAPED LIKE THE PUSH SEND PATH
--
-- `push_targets_for_notifications` (20260831120000) hands the caller's own
-- Pages Function a recipient's push endpoint, under proof that the caller
-- authored the notification. That is safe because a push endpoint is INERT
-- without this deployment's VAPID private key: leaking one leaks no fact about
-- a person.
--
-- An email address is not inert. It is the single most portable piece of PII a
-- member has, it is valuable on its own, and `members` deliberately does not
-- store one — addresses live in `auth.users`, which no client may read for
-- another person. So the push shape, applied here, would create exactly the
-- leak this schema has avoided for 50 migrations: any member could call the
-- definer RPC straight from the browser with ids they authored and harvest
-- their group's inboxes.
--
-- Therefore the flow is INVERTED. The member-invoked RPC resolves addresses
-- server-side, writes them into an outbox, and returns ONLY A COUNT. Nothing a
-- member credential can call ever returns an address. The outbox itself has
-- RLS on with **no policies at all**, so `anon` and `authenticated` are denied
-- by default-deny rather than by our remembering to write the right predicate.
-- Draining it requires the service role, which lives in a scheduled function's
-- secret store and never in a browser.
--
-- The outbox is not incidental plumbing — email genuinely needs what it
-- provides and push does not: dedupe (one row per notification, enforced by a
-- unique index, so a retried request cannot double-send), retry with a bounded
-- attempt count, a per-recipient daily cap, and a delay window. The delay buys
-- the best quality feature here: an event the recipient has already READ in the
-- app by the time the drain runs is never emailed at all.

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-member opt-in
-- ─────────────────────────────────────────────────────────────────────────────

-- Opt-in is per member per trip, and OFF by default. Email is the most
-- intrusive channel we have and the one a member cannot silence from their OS,
-- so it is never on because someone else acted — only because this member
-- turned it on for this trip.
create table public.email_prefs (
  -- One row per membership: the member *is* the primary key. Cascades so
  -- leaving a trip takes the preference with it.
  member_id uuid primary key references public.members(id) on delete cascade,
  -- Denormalised so every policy and the enqueue join can be trip-scoped
  -- without a round trip through `members`.
  trip_id uuid not null references public.trips(id) on delete cascade,

  -- The master switch. False means this member is never emailed for this trip,
  -- regardless of `types`.
  enabled boolean not null default false,

  -- Which event types to email, as a subset of the `notifications` type CHECK.
  -- Per-type rather than all-or-nothing because the useful setting is usually
  -- "mention me in chat, but do not mail me every expense". Bounded so one row
  -- can never carry an unbounded array.
  types text[] not null default '{checklist_assigned,poll_opened,expense_owed,mention}'
    check (coalesce(array_length(types, 1), 0) <= 16),

  updated_at timestamptz not null default now()
);

alter table public.email_prefs enable row level security;

-- A member reads and writes only their own preference, in a trip they belong
-- to. `my_member_id` returns the caller's member row for the trip, so this is
-- "me, here" in both directions — a member cannot enrol anyone else in email.
create policy email_prefs_select on public.email_prefs for select
  using (member_id = my_member_id(trip_id));

create policy email_prefs_insert on public.email_prefs for insert
  with check (member_id = my_member_id(trip_id));

create policy email_prefs_update on public.email_prefs for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));

create policy email_prefs_delete on public.email_prefs for delete
  using (member_id = my_member_id(trip_id));

-- Server-side `updated_at`, same shared trigger every other table uses, so the
-- client never sets it and it cannot be back-dated.
create trigger email_prefs_touch_updated_at
  before update on public.email_prefs
  for each row execute function public.touch_updated_at();

-- Realtime publication decision: NO. This is one row describing the caller's
-- own setting, read when the settings surface opens and written by the same
-- device. There is nothing for another member to observe and no second device
-- that needs the change pushed, so publishing it would add subscriber work for
-- zero behaviour.

-- ─────────────────────────────────────────────────────────────────────────────
-- The outbox
-- ─────────────────────────────────────────────────────────────────────────────

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),

  -- The inbox row this email is about. UNIQUE is the dedupe guarantee: the
  -- enqueue path is best-effort and may be retried (a flaky network, a double
  -- mutation), and this makes a second attempt a no-op instead of a second
  -- email. Cascades, so clearing a notification cancels an unsent email.
  notification_id uuid not null unique
    references public.notifications(id) on delete cascade,

  trip_id uuid not null references public.trips(id) on delete cascade,
  recipient_id uuid not null references public.members(id) on delete cascade,

  -- The resolved destination. This column is the reason this table is
  -- unreachable from any browser credential (see the header). Snapshotted at
  -- enqueue time so a later address change cannot redirect a queued email.
  to_email text not null,

  -- Everything the renderer needs, captured at enqueue time so the drain never
  -- joins back to member-scoped tables (it runs as the service role, where RLS
  -- would not protect us) and so the email still renders correctly if the
  -- subject row is edited or deleted before sending.
  type text not null
    check (type in ('checklist_assigned', 'poll_opened', 'expense_owed', 'mention')),
  subject_title text,
  trip_name text not null,
  actor_name text,
  deep_link text not null,

  state text not null default 'pending'
    check (state in ('pending', 'sent', 'failed')),
  -- Bounded retries. A permanently bad address must not be retried forever;
  -- `claim_email_batch` stops handing out a row once this hits the cap.
  attempts int not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  -- Deliberately in the future (see `enqueue_emails_for_notifications`). The
  -- gap is what lets the drain skip events the recipient has since read.
  send_after timestamptz not null default now(),
  sent_at timestamptz
);

-- The drain's only access pattern: oldest due pending row first.
create index email_outbox_due_idx
  on public.email_outbox (send_after)
  where state = 'pending';

-- Backs the per-recipient daily cap check in the enqueue function.
create index email_outbox_recipient_idx
  on public.email_outbox (recipient_id, created_at desc);

-- RLS ON, AND THE ONLY POLICY IS AN EXPLICIT DENIAL.
--
-- Postgres already default-denies a table with RLS enabled and no matching
-- policy, so the policy below changes no behaviour whatsoever. It is here to
-- say so out loud. "No policies" and "I forgot to write the policies" look
-- identical in a diff, and this is the one table in the schema where that
-- ambiguity would be expensive — so the intent is written down as code, and
-- scripts/check-invariants.mjs (which requires every new table to declare a
-- policy) gets a real answer rather than an exception.
--
-- The only ways in are the SECURITY DEFINER functions below — the enqueue one
-- never returns an address, and the three drain ones are granted to
-- `service_role` alone — plus the service role itself, which bypasses RLS and
-- lives only in the drain's secret store.
alter table public.email_outbox enable row level security;

create policy email_outbox_no_member_access on public.email_outbox
  for all
  using (false)
  with check (false);

-- Belt and braces alongside RLS: even the table-level grants PostgREST relies
-- on are withdrawn, so a future policy added by accident still has no
-- privilege to act on.
revoke all on public.email_outbox from anon, authenticated;

-- Realtime publication decision: NO, emphatically. Publishing this table would
-- stream `to_email` to subscribers and undo everything above.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enqueue: the one path a member credential may invoke
-- ─────────────────────────────────────────────────────────────────────────────

-- How long an event waits before it may be emailed. Long enough that someone
-- actively using the app reads the notification first (and is then never
-- emailed), short enough that email still arrives while the event matters.
-- Also coalesces an edit-right-after-create into a single send.
create or replace function public.email_send_delay()
returns interval language sql immutable
as $$ select interval '2 minutes' $$;

-- How long a claimed row stays invisible before another drain may retry it.
-- Comfortably longer than a send takes, so an in-flight email is never sent
-- twice, and short enough that a genuinely dropped run is picked up soon.
create or replace function public.email_retry_delay()
returns interval language sql immutable
as $$ select interval '5 minutes' $$;

-- Per-recipient emails allowed in a trailing 24 hours, across all trips.
-- This bounds what one member can cost another: without it, someone assigning
-- forty checklist items sends forty emails, and a leaked invite link becomes a
-- mail bomb aimed at the group. Low on purpose — the in-app inbox and push have
-- no such cap because they cannot be used this way.
create or replace function public.email_daily_cap()
returns int language sql immutable
as $$ select 12 $$;

-- Queue emails for notifications the CALLER just authored. Returns the number
-- of rows queued — never an address, never a row id that could be correlated
-- back to one.
--
-- Authorization is the same two-part proof the push send path uses, and for the
-- same reason: `n.actor_id = my_member_id(n.trip_id)` means you may only queue
-- mail for people you legitimately just notified, and the `created_at` window
-- makes this a send helper for a live event rather than a way to mail the group
-- about something from last week.
--
-- Everything else here is a reason NOT to send, and each one is a deliberate
-- line of defence:
--   * `u.email_confirmed_at is not null` — we only ever mail an address its
--     owner has proven they control. Without this, a member could link an
--     unverified address and have Wander deliver to a stranger, making us the
--     spam vector. This is the single most important predicate in the function.
--   * the recipient's own `email_prefs` must be enabled AND include this type.
--   * the daily cap, counted per recipient over a trailing window.
--   * `on conflict do nothing` — dedupe, so retrying is free.
create or replace function public.enqueue_emails_for_notifications(p_ids uuid[])
returns int
language plpgsql volatile security definer
set search_path = public
as $$
declare
  queued int;
begin
  -- A bounded input; the client sends one batch per mutation.
  if p_ids is null or array_length(p_ids, 1) is null or array_length(p_ids, 1) > 100 then
    return 0;
  end if;

  insert into email_outbox (
    notification_id, trip_id, recipient_id, to_email,
    type, subject_title, trip_name, actor_name, deep_link, send_after
  )
  with candidate as (
  select
    n.id, n.trip_id, n.recipient_id, u.email,
    n.type, n.title, t.name as trip_name, actor.display_name as actor_name,
    -- The same hash route the inbox and the push payload use, built here so
    -- the drain needs no knowledge of the app's routing. Kept in step with
    -- src/features/notifications/route.ts — a drift shows up as a link to the
    -- wrong tab, which is visible and harmless, never a failed send.
    '#/trip/' || n.trip_id::text || '/' ||
      case n.type
        when 'checklist_assigned' then 'checklist'
        when 'poll_opened' then 'polls'
        when 'expense_owed' then 'budget'
        when 'mention' then 'chat'
        else 'checklist'
      end || '?n=' || n.id::text as deep_link,
    now() + email_send_delay() as send_after,
    -- Position within this call, per recipient. Combined with their prior
    -- count below, this is what makes the cap hold for a BATCH and not just
    -- across calls: the trailing count is evaluated once against the
    -- statement's snapshot, so without this a single request carrying 100
    -- notifications aimed at one person would queue all 100 — each row
    -- individually "under" a cap that none of them could see the others
    -- consuming.
    row_number() over (partition by n.recipient_id order by n.created_at, n.id) as seq,
    (
      select count(*) from email_outbox prior
      where prior.recipient_id = n.recipient_id
        and prior.created_at > now() - interval '24 hours'
    ) as prior_count
  from notifications n
  join trips t on t.id = n.trip_id
  join members recipient on recipient.id = n.recipient_id
  join auth.users u on u.id = recipient.user_id
  join email_prefs p on p.member_id = n.recipient_id
  left join members actor on actor.id = n.actor_id
  where n.id = any(p_ids)
    -- The caller authored it, recently. Identical to the push proof.
    and n.actor_id = my_member_id(n.trip_id)
    and n.created_at > now() - interval '5 minutes'
    -- A verified address, and only a verified address.
    and u.email is not null
    and u.email_confirmed_at is not null
    -- This member asked for email, for this kind of event.
    and p.enabled
    and n.type = any(p.types)
  )
  select id, trip_id, recipient_id, email,
         type, title, trip_name, actor_name, deep_link, send_after
  from candidate
  -- The cap, applied to this call's rows and the recipient's recent history
  -- together. Oldest events win the remaining headroom, so when a member is
  -- over budget they still hear about the first thing that happened rather
  -- than an arbitrary slice.
  where prior_count + seq <= email_daily_cap()
  on conflict (notification_id) do nothing;

  get diagnostics queued = row_count;
  return queued;
end;
$$;

-- Callable by a signed-in member (that is the point — it runs under their
-- authorship proof), but never by `anon`, which holds no membership and so
-- could only ever get 0 back anyway.
revoke all on function public.enqueue_emails_for_notifications(uuid[]) from public, anon;
grant execute on function public.enqueue_emails_for_notifications(uuid[]) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Drain: service role only
-- ─────────────────────────────────────────────────────────────────────────────

-- Claim a batch of due emails, atomically, and return what the renderer needs.
--
-- `for update skip locked` is what makes overlapping drains safe: two
-- concurrent runs take disjoint rows instead of both sending the same email.
-- The attempt counter is incremented AS PART OF THE CLAIM, so a run that dies
-- mid-send cannot leave a row to be retried forever — it has already been
-- charged for the try.
--
-- The `read_at is null` join is the quality feature this whole design exists
-- for: if the recipient opened the app and saw the notification during the
-- delay window, the row is marked 'sent' without an email ever being sent.
-- Nobody gets mailed about something they have already read.
create or replace function public.claim_email_batch(p_limit int default 50)
returns table (
  id uuid,
  to_email text,
  type text,
  subject_title text,
  trip_name text,
  actor_name text,
  deep_link text,
  attempts int
)
language plpgsql volatile security definer
set search_path = public
as $$
begin
  -- Retire anything the recipient has already read in the app. Marked 'sent'
  -- rather than deleted so the row still counts against the daily cap and the
  -- outbox remains an audit trail of what we decided, not just what we posted.
  update email_outbox o
  set state = 'sent', sent_at = now(), last_error = 'skipped: read in app'
  where o.state = 'pending'
    and o.send_after <= now()
    and exists (
      select 1 from notifications n
      where n.id = o.notification_id and n.read_at is not null
    );

  return query
  with due as (
    select o.id
    from email_outbox o
    where o.state = 'pending'
      and o.send_after <= now()
      and o.attempts < 5
    order by o.send_after
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  )
  update email_outbox o
  -- Charge the attempt and push the row out of sight for a while: a
  -- visibility timeout, exactly as a queue would. `skip locked` only protects
  -- two drains running *concurrently*; without this, a drain starting while a
  -- previous one is still waiting on the provider would claim the same row and
  -- send the email twice. Pushing `send_after` forward means a row is retried
  -- only if nothing marked a result within the window.
  set attempts = o.attempts + 1,
      send_after = now() + email_retry_delay()
  from due
  where o.id = due.id
  returning o.id, o.to_email, o.type, o.subject_title,
            o.trip_name, o.actor_name, o.deep_link, o.attempts;
end;
$$;

-- The hard line. This function returns addresses, so no member-held credential
-- may ever execute it — only the service role, which exists solely in the
-- drain's secret store.
revoke all on function public.claim_email_batch(int) from public, anon, authenticated;
grant execute on function public.claim_email_batch(int) to service_role;

-- Record the outcome of a send. Separate from the claim so a crash between the
-- two leaves a row that is retried (bounded by `attempts`), never one silently
-- dropped.
-- `p_terminal` is the important parameter. Without it the only way to stop
-- retrying is to exhaust `attempts`, which means a malformed address — one
-- that will be rejected identically forever — costs five sends, five slots of
-- provider quota, and five retry windows of delay for everything behind it.
-- The drain knows the difference (a 422 is permanent, a 429 is timing) and
-- says so here.
create or replace function public.mark_email_result(
  p_id uuid,
  p_sent boolean,
  p_error text default null,
  p_terminal boolean default false
)
returns void
language sql volatile security definer
set search_path = public
as $$
  update email_outbox
  set state = case
                when p_sent then 'sent'
                -- A failure the drain has judged permanent, or one that has
                -- run out of attempts. Either way: stop.
                when coalesce(p_terminal, false) then 'failed'
                when attempts >= 5 then 'failed'
                -- Otherwise leave it pending; `send_after` (pushed forward by
                -- the claim) decides when the next drain may retry it.
                else 'pending'
              end,
      sent_at = case when p_sent then now() else sent_at end,
      last_error = case when p_sent then null else left(coalesce(p_error, 'unknown'), 500) end
  where id = p_id;
$$;

revoke all on function public.mark_email_result(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.mark_email_result(uuid, boolean, text, boolean) to service_role;

-- Housekeeping: drop long-settled rows. Kept long enough to debug a complaint
-- ("I never got the email") and no longer, because every row holds an address.
create or replace function public.prune_email_outbox(p_days int default 30)
returns int
language plpgsql volatile security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from email_outbox
  where state in ('sent', 'failed')
    and coalesce(sent_at, created_at) < now() - (greatest(1, coalesce(p_days, 30)) || ' days')::interval;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_email_outbox(int) from public, anon, authenticated;
grant execute on function public.prune_email_outbox(int) to service_role;
