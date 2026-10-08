-- Wander: email digest of new chat messages — epic #181, the email channel
--
-- The previous migration (20261008120000) made email a delivery channel for the
-- notification inbox. That covers the chat case that is *addressed to you* — an
-- @-mention — but not the ordinary one: the group had a conversation while you
-- were away, and nothing tells you.
--
-- WHY A DIGEST AND NOT AN EMAIL PER MESSAGE. One email per chat message is the
-- single fastest way to get a domain muted, and the daily cap in the previous
-- migration exists precisely to stop that shape of mistake. A group planning a
-- trip sends bursts: forty messages in an evening is normal, and forty emails
-- is not. So this sends at most one email per trip per interval, saying how many
-- messages are waiting, and lets the app itself show them.
--
-- WHAT WAS MISSING BEFORE THIS. A digest needs to know what you have already
-- read, and until now Wander did not: the per-tab "new since last visit" dots
-- (#43, src/hooks/useUnreadDots.ts) keep last-seen in **localStorage**, keyed by
-- trip and member. That is the right design for a dot — it means "new since
-- *you* last looked *here*, on this device" — but it is invisible to the
-- server, so no server-side process could ever tell whether you were behind.
-- `chat_reads` adds that missing fact. It does NOT replace the localStorage
-- mechanism, which keeps working exactly as before for the dots.
--
-- A DIGEST HAS NO ACTOR, which is why it cannot be a `notifications` row: that
-- table's insert policy requires `actor_id = my_member_id(trip_id)`, and
-- "twelve people said things" has no single author. It is the same reason the
-- time-based reminders (#195) are derived on the client and never stored. So a
-- digest is a *second kind* of outbox row rather than a notification that
-- happens to be emailed — see the `kind` column below.

-- ─────────────────────────────────────────────────────────────────────────────
-- Server-side chat read state
-- ─────────────────────────────────────────────────────────────────────────────

create table public.chat_reads (
  -- One row per membership: the member *is* the key, like email_prefs.
  member_id uuid primary key references public.members(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- How far through the chat this member has read. Advanced by the chat page.
  last_read_at timestamptz not null default now()
);

create index chat_reads_trip_idx on public.chat_reads (trip_id);

alter table public.chat_reads enable row level security;

-- Self-owned in both directions: a member may only ever read or move their own
-- marker. Note this is deliberately NOT visible to other members — "how far
-- Priya has read" is a read receipt, and read receipts are a feature nobody
-- asked for with privacy consequences nobody wanted. The digest reads these
-- rows through a SECURITY DEFINER function instead.
create policy chat_reads_select on public.chat_reads for select
  using (member_id = my_member_id(trip_id));

create policy chat_reads_insert on public.chat_reads for insert
  with check (member_id = my_member_id(trip_id));

create policy chat_reads_update on public.chat_reads for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));

create policy chat_reads_delete on public.chat_reads for delete
  using (member_id = my_member_id(trip_id));

-- Realtime publication decision: NO. A member's own marker is written by the
-- device that is already looking at the chat; there is nothing to observe and
-- no other member may see it anyway.

-- ─────────────────────────────────────────────────────────────────────────────
-- Opting in
-- ─────────────────────────────────────────────────────────────────────────────

-- A separate column rather than another value in `email_prefs.types`, because
-- `types` enumerates *notification* types and a digest is not one. Overloading
-- it would mean every reader of that array has to know which values are real
-- notification types and which are not.
--
-- Default FALSE, and deliberately not added to the `types` default either: a
-- member who already turned email on for mentions did not ask for a digest, and
-- a migration must not enrol them in a new kind of email.
alter table public.email_prefs
  add column chat_digest boolean not null default false;

-- Throttle state. Kept here rather than on the outbox because the question the
-- enqueue asks is "when did I last digest *this member*", which outlives any
-- single row (the outbox is pruned).
alter table public.email_prefs
  add column last_digest_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- A second kind of outbox row
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.email_outbox
  add column kind text not null default 'notification'
    check (kind in ('notification', 'chat_digest'));

-- A digest row has no notification and no event type. Both columns become
-- nullable, and the CHECK below is what keeps the two shapes honest — it is
-- impossible to store a notification row without its notification, or a digest
-- row that pretends to have one.
alter table public.email_outbox alter column notification_id drop not null;
alter table public.email_outbox alter column type drop not null;

alter table public.email_outbox
  add constraint email_outbox_shape_check check (
    case kind
      when 'notification' then notification_id is not null and type is not null
      when 'chat_digest'  then notification_id is null and type is null
    end
  );

-- How many messages the digest is about. Null for notification rows.
alter table public.email_outbox add column digest_count int
  check (digest_count is null or digest_count > 0);

-- The existing unique index on notification_id still does its job: Postgres
-- treats NULLs as distinct, so many digest rows coexist while notification rows
-- stay deduped one-per-event.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enqueueing digests
-- ─────────────────────────────────────────────────────────────────────────────

-- At most one digest per member per trip per interval. Six hours means a group
-- talking all day generates four emails at worst, and someone away for a
-- weekend gets a handful rather than a feed.
create or replace function public.email_digest_interval()
returns interval language sql immutable
as $$ select interval '6 hours' $$;

-- Queue a chat digest for every member who is behind and asked to be told.
--
-- SERVICE ROLE ONLY, like the drain functions, and for the same reason: it
-- reads `auth.users.email`. There is no member-invoked path to this at all —
-- unlike `enqueue_emails_for_notifications`, which a member calls for an event
-- they just caused, a digest has no triggering action and no author, so the
-- scheduled drain is its only caller.
--
-- Returns the number of digests queued; never an address.
create or replace function public.enqueue_chat_digests()
returns int
language plpgsql volatile security definer
set search_path = public
as $$
declare
  queued int;
begin
  with candidate as (
    select
      m.id as member_id,
      m.trip_id,
      u.email,
      t.name as trip_name,
      -- The baseline for "unread": where this member has read to, or — if they
      -- have never opened the chat on any device — the moment they turned the
      -- digest on. Never the beginning of time, which would mail someone a
      -- count of the entire trip's history the first time this runs.
      coalesce(cr.last_read_at, p.updated_at) as since
    from email_prefs p
    join members m on m.id = p.member_id
    join trips t on t.id = m.trip_id
    join auth.users u on u.id = m.user_id
    left join chat_reads cr on cr.member_id = m.id
    where p.enabled
      and p.chat_digest
      -- Same non-negotiable rule as the notification path: a verified address
      -- only, so Wander can never be used to mail a stranger.
      and u.email is not null
      and u.email_confirmed_at is not null
      -- Not digested too recently.
      and (p.last_digest_at is null or p.last_digest_at < now() - email_digest_interval())
  ),
  counted as (
    select c.*,
      (
        select count(*) from messages msg
        where msg.trip_id = c.trip_id
          and msg.created_at > c.since
          -- Your own messages are not news to you.
          and (msg.member_id is null or msg.member_id <> c.member_id)
      ) as unread
    from candidate c
  ),
  eligible as (
    select * from counted
    where unread > 0
      -- The same trailing per-recipient cap the notification path enforces, so
      -- digests and event emails share one budget rather than each having their
      -- own.
      and (
        select count(*) from email_outbox prior
        where prior.recipient_id = counted.member_id
          and prior.created_at > now() - interval '24 hours'
      ) < email_daily_cap()
  ),
  inserted as (
    insert into email_outbox (
      kind, trip_id, recipient_id, to_email, trip_name, deep_link,
      digest_count, send_after
    )
    select 'chat_digest', e.trip_id, e.member_id, e.email, e.trip_name,
           '#/trip/' || e.trip_id::text || '/chat',
           e.unread,
           -- Due immediately: the digest interval has already provided all the
           -- delay this needs, and the "did they read it meanwhile" check runs
           -- at claim time regardless.
           now()
    from eligible e
    returning recipient_id
  )
  -- Stamp the throttle for exactly the members we queued, so a member we
  -- skipped (nothing unread, over cap) stays eligible for the next run.
  update email_prefs p
  set last_digest_at = now()
  where p.member_id in (select recipient_id from inserted);

  get diagnostics queued = row_count;
  return queued;
end;
$$;

revoke all on function public.enqueue_chat_digests() from public, anon, authenticated;
grant execute on function public.enqueue_chat_digests() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Teaching the drain about the second kind
-- ─────────────────────────────────────────────────────────────────────────────

-- Postgres will not let `create or replace` change a function's return type,
-- and this one gains two output columns — so the old signature is dropped
-- first. Safe because nothing holds a reference to it: the only caller is the
-- drain, which looks it up by name at call time over PostgREST.
drop function if exists public.claim_email_batch(int);

-- Replaces the version in 20261008120000. Two changes:
--   * returns `kind` and `digest_count`, so the renderer can tell the shapes
--     apart;
--   * the "already read it" withdrawal now covers digests too — for a
--     notification it is `read_at`, for a digest it is the member having caught
--     up in the chat since the row was queued. Same principle either way:
--     nobody is emailed about something they have already seen.
create or replace function public.claim_email_batch(p_limit int default 50)
returns table (
  id uuid,
  to_email text,
  kind text,
  type text,
  subject_title text,
  trip_name text,
  actor_name text,
  deep_link text,
  digest_count int,
  attempts int
)
language plpgsql volatile security definer
set search_path = public
as $$
begin
  -- Retire anything the recipient has already caught up on. Marked 'sent'
  -- rather than deleted so the row still counts against the daily cap and the
  -- outbox remains an audit trail of what we decided, not just what we posted.
  update email_outbox o
  set state = 'sent', sent_at = now(), last_error = 'skipped: read in app'
  where o.state = 'pending'
    and o.send_after <= now()
    and (
      -- An event notification the recipient has opened.
      exists (
        select 1 from notifications n
        where n.id = o.notification_id and n.read_at is not null
      )
      -- Or a digest whose reader has since reached the chat. `created_at` is
      -- the right comparison point: it is when we counted the unread
      -- messages, so a marker moved after that means they have seen them.
      or (
        o.kind = 'chat_digest'
        and exists (
          select 1 from chat_reads cr
          where cr.member_id = o.recipient_id and cr.last_read_at >= o.created_at
        )
      )
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
  -- send the email twice.
  set attempts = o.attempts + 1,
      send_after = now() + email_retry_delay()
  from due
  where o.id = due.id
  returning o.id, o.to_email, o.kind, o.type, o.subject_title,
            o.trip_name, o.actor_name, o.deep_link, o.digest_count, o.attempts;
end;
$$;

-- The grant does not survive a signature change, so restate it. This function
-- returns addresses: service role only, never a member credential.
revoke all on function public.claim_email_batch(int) from public, anon, authenticated;
grant execute on function public.claim_email_batch(int) to service_role;
