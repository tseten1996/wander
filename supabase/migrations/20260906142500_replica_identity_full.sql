-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: make DELETE events pass the trip_id filter (#326)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `useTripRealtime` (src/hooks/useRealtime.ts) subscribes to every content
-- table with `filter: trip_id=eq.<id>`. For a Postgres DELETE, the realtime
-- `old` record only carries the columns in the table's REPLICA IDENTITY, which
-- defaults to the primary key (`id`). `trip_id` is therefore absent from the
-- delete payload, the server-side filter can't match, and the DELETE event is
-- dropped before it reaches any subscriber — so a deleted item lingers on other
-- members' screens until they refetch (reload / refocus / reconnect).
--
-- REPLICA IDENTITY FULL widens the WAL row image to include every column, so
-- `trip_id` is present on DELETE and the existing filter matches. This is a
-- pure replication-config change: it touches no RLS policy, no column, and no
-- row data, and it is idempotent (re-running it is a no-op). INSERT/UPDATE
-- realtime behaviour is unchanged — those events already carry the full `new`
-- row.
--
-- Scope: exactly the tables `useTripRealtime` filters by `trip_id` (all already
-- in the `supabase_realtime` publication). `trips` is intentionally excluded —
-- it is filtered by `id=eq.<id>`, which is its primary key and thus already in
-- the default replica identity, so its DELETE events already pass the filter.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.members replica identity full;
alter table public.polls replica identity full;
alter table public.poll_options replica identity full;
alter table public.votes replica identity full;
alter table public.messages replica identity full;
alter table public.message_reactions replica identity full;
alter table public.questions replica identity full;
alter table public.checklist_items replica identity full;
alter table public.itinerary_items replica identity full;
alter table public.budget_entries replica identity full;
alter table public.repayments replica identity full;
alter table public.packing_items replica identity full;
alter table public.notes replica identity full;
alter table public.inspiration_items replica identity full;
alter table public.activity replica identity full;
alter table public.notifications replica identity full;
alter table public.availability_polls replica identity full;
alter table public.availability_candidates replica identity full;
alter table public.availability_responses replica identity full;
alter table public.destinations replica identity full;
alter table public.trip_preferences replica identity full;
alter table public.trip_photos replica identity full;
alter table public.comments replica identity full;
