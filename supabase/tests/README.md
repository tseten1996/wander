# RLS regression tests

Row Level Security **is** Wander's authorization layer — the client is never
trusted (ARCHITECTURE.md §2, guardrail #1). These policies live in
`supabase/migrations/` and are easy to weaken by accident: a later migration
that drops-and-recreates a policy, a `USING (true)` typo, a forgotten
`with check`. Nothing else would notice.

`rls_policies_test.sql` is the automated signal. It asserts the permission
matrix from `ARCHITECTURE.md`, table by table, and **exits non-zero on any
regression** so it can gate a merge or a deploy.

## What it covers

Every content table created in `*_init.sql` (trips, members, polls,
poll_options, votes, messages, message_reactions, questions, checklist_items,
itinerary_items, budget_entries, packing_items, notes, inspiration_items,
activity), across these properties:

- **Trip isolation** — a signed-in non-member sees zero rows and can write
  nothing, on every table.
- **Membership gate** — a member sees the trip's rows and can create content.
- **Cross-trip isolation** — a member of trip A cannot see trip B.
- **The invite capability** — the invite code is unreadable to non-members;
  `join_trip` is the only join path; `get_invite_preview` honours
  `invite_enabled` / `archived`.
- **Owner-only powers** — edit/delete the trip, remove members, delete
  activity rows.
- **Role immutability** — a member cannot escalate themselves to `owner`.
- **Creator-or-owner delete vs any-member update** — the deliberate asymmetry
  on collaborative content.
- **Authorship pinning** — votes/messages/reactions/activity are pinned to the
  caller's own member id; you cannot forge another member's authorship.

## How it works

The whole file runs in one transaction that **rolls back** at the end, so it
leaves no residue and is safe to run repeatedly against any project. It seeds
its own `auth.users` and trip fixtures as the `postgres` role, then exercises
each policy while impersonating each test user — `set role authenticated` plus a
synthetic `request.jwt.claims`, which is exactly what `auth.uid()` / `auth.jwt()`
read at runtime. Each assertion records a pass/fail row; the final block prints a
`N/N passed` summary and `RAISE`s (aborting with a non-zero exit) if any check
failed.

It assumes the standard Supabase role baseline (the `authenticated` role holds
the default table/function grants Supabase provisions). Any Supabase project —
the local stack or a scratch/staging project — has this out of the box.

## Running it

### Against the local Supabase stack (recommended)

```bash
supabase start                     # boots Postgres + applies supabase/migrations
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
     -v ON_ERROR_STOP=1 -f supabase/tests/rls_policies_test.sql
```

### Against any Supabase project by connection string

Use a **scratch or staging** project — never production. The suite rolls back,
but connect with the direct Postgres connection string (the `postgres` role) so
it can seed `auth.users`:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_policies_test.sql
```

A clean run ends with:

```
 RLS regression suite: 94/94 passed
```

and exit code `0`. On a regression it prints the failing checks (`FAIL: <name>
(got …, want …)`) and exits non-zero — suitable as a CI or pre-deploy gate.

`-v ON_ERROR_STOP=1` is required: it makes `psql` propagate the final
`RAISE exception` as a non-zero exit.

## Extending it

When you add a table or change a policy, add matching assertions here in the
same change. The helpers keep each case to one line:

```sql
-- read as a user: expect a row count
select pg_temp.expect_count('<name>', '<user-uuid>', <is_anon>, $$select count(*) from <table> where …$$, <want>);

-- write as a user: expect an affected-row count.
--   allowed write → 1 · denied INSERT (with-check) → -1 · denied UPDATE/DELETE (no matching row) → 0
select pg_temp.expect_dml('<name>', '<user-uuid>', <is_anon>, $$insert into <table> …$$, <want>);
```
