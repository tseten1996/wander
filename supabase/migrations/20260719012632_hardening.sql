-- Hardening pass driven by Supabase security advisors.

-- Pin search_path on the remaining functions
alter function public.touch_updated_at() set search_path = public;
alter function public.generate_invite_code() set search_path = public;

-- Trigger functions are fired by triggers (no caller EXECUTE check needed) —
-- remove them from the exposed RPC surface entirely.
revoke execute on function public.handle_new_trip() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

-- Helpers and RPCs are only meaningful for signed-in users (owner or the
-- invisible anonymous session created on the join page). The `anon` role —
-- requests with no session at all — gets nothing.
-- NOTE: is_trip_member / is_trip_owner / my_member_id MUST stay executable by
-- `authenticated`: RLS policy expressions run with the caller's privileges.
revoke execute on function public.is_trip_member(uuid) from public, anon;
revoke execute on function public.is_trip_owner(uuid) from public, anon;
revoke execute on function public.my_member_id(uuid) from public, anon;
revoke execute on function public.join_trip(text, text, text) from public, anon;
revoke execute on function public.get_invite_preview(text) from public, anon;
-- generate_invite_code runs as the inserting user (column default), so it
-- stays executable by `authenticated` but not by `anon`.
revoke execute on function public.generate_invite_code() from public, anon;
