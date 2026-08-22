-- Stated trip preferences — epic #209, slice 4 (issue #268).
--
-- The AI "improve this day" slice (#213) reasons about a day BLIND to who the
-- group is: it cannot know they travel slow, that someone is vegetarian, or
-- that this is a tight-budget trip. So its suggestions are generically
-- plausible rather than *theirs*. This slice adds a place for the group to
-- *state* how it likes to travel, so that context can fold into the model call.
--
-- STATED, NOT MINED. docs/AI-ARCHITECTURE.md §8.1 forbids auto-extracting
-- preferences from chat: trip-scoped RLS would publish an inferred trait about
-- a person to the whole group without their ever seeing the sentence. This
-- table only holds what a member deliberately typed — the member wrote it, so
-- it is accurate; they know it exists; they can edit it.
--
-- GROUP-OWNED, ONE ROW PER TRIP. These are the *group's* preferences ("how this
-- group travels"), not per-member private ones (that, and the consent flow it
-- would need, are the epic's gated future work). One row keyed by trip_id, read
-- and written by every member — matching the collaborative nature of the data
-- and keeping any member identity out of it by construction (no member_id on
-- the content, only an `updated_by` audit stamp).
--
-- SIZING (§8.3): a trip's stated preferences are a handful of short strings,
-- well under the per-call token budget, so no table-per-item and no pgvector —
-- a single structured row is enough and is strictly cheaper to read whole.

create table public.trip_preferences (
  -- One row per trip: the trip *is* the primary key. on delete cascade so a
  -- deleted trip takes its preferences with it.
  trip_id uuid primary key references public.trips(id) on delete cascade,

  -- Structured single-selects. A closed CHECK set rather than free text: these
  -- are stable, conceptually closed dimensions, and a clean value is what lets
  -- the context builder fold them in without guessing. NULL = "not stated",
  -- which the builder treats as absent (the feature degrades to today's
  -- behaviour when a field is unset).
  pace text check (pace in ('relaxed', 'balanced', 'packed')),
  budget_style text check (budget_style in ('budget', 'moderate', 'comfortable', 'luxury')),

  -- Multi-select chips. Bounded cardinality so a single row cannot balloon the
  -- prompt; the context builder narrows further per call. Default empty (never
  -- null) so array reads never branch on null.
  interests text[] not null default '{}' check (coalesce(array_length(interests, 1), 0) <= 24),
  dietary text[] not null default '{}' check (coalesce(array_length(dietary, 1), 0) <= 24),

  -- The "anything else" free text (dietary details, accessibility needs, the
  -- one-line trip intent). Length-capped as a hard ceiling on what one field
  -- can cost; the context builder additionally sanitises and fences it as data.
  notes text check (notes is null or length(notes) <= 500),

  -- Audit stamp of who last edited. set null (not cascade) so a member leaving
  -- does not erase the group's preferences. NOT part of the content sent to the
  -- model — the row that reaches the prompt carries no member identity.
  updated_by uuid references public.members(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Reuse the shared trigger (init.sql) so an edit bumps updated_at server-side;
-- the client never has to set it, and it cannot be back-dated.
create trigger trip_preferences_touch_updated_at
  before update on public.trip_preferences
  for each row execute function public.touch_updated_at();

alter table public.trip_preferences enable row level security;

-- Reads: any trip member. Writes: any trip member (owner is a member too) —
-- these are group-owned preferences every member contributes to, matching the
-- "readable and editable by every member" reality guardrail #1 allows for
-- genuinely shared content. The write policies additionally pin `updated_by` to
-- the caller's own member id, so a member cannot forge someone else as the
-- editor (the same self-attribution the notifications/actor pattern uses).
--
-- There is deliberately NO delete policy: clearing a preference is an UPDATE to
-- null/empty, and the row is trip-scoped exhaust that cascades with the trip.
-- Omitting delete keeps the write surface to exactly what the panel needs.
create policy trip_preferences_select on public.trip_preferences for select
  using (is_trip_member(trip_id));
create policy trip_preferences_insert on public.trip_preferences for insert
  with check (
    is_trip_member(trip_id)
    and (updated_by is null or updated_by = my_member_id(trip_id))
  );
create policy trip_preferences_update on public.trip_preferences for update
  using (is_trip_member(trip_id))
  with check (
    is_trip_member(trip_id)
    and (updated_by is null or updated_by = my_member_id(trip_id))
  );

-- Realtime publication decision: YES. This is shared group content edited on a
-- collaborative Settings panel — when one member states how the group travels,
-- another member with the panel open should see it update, exactly like the
-- other content tables (destinations, notes). RLS still applies per subscriber.
-- The traffic is negligible: the row is edited rarely and read on demand.
alter publication supabase_realtime add table public.trip_preferences;
