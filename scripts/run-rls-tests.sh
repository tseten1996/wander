#!/usr/bin/env bash
# Run the RLS regression suite against a disposable Postgres.
#
# Applies, in order, against the database in $DATABASE_URL (or the standard
# libpq PG* env vars if unset):
#   1. supabase/tests/ci/supabase_baseline.sql  — the Supabase role/schema baseline
#   2. every supabase/migrations/*.sql           — in timestamp (filename) order
#   3. supabase/tests/rls_policies_test.sql      — the suite (rolls back its own txn)
#
# The suite exits non-zero on any failing assertion, so this script does too.
# Used by .github/workflows/rls-tests.yml and runnable locally against a
# throwaway Postgres (or the Supabase local stack's DB) — no live project, no
# secret. See supabase/tests/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc)
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL+=("$DATABASE_URL")
fi

echo "▸ Applying Supabase baseline shim"
"${PSQL[@]}" -f "$ROOT/supabase/tests/ci/supabase_baseline.sql" >/dev/null

echo "▸ Applying migrations"
shopt -s nullglob
migrations=("$ROOT"/supabase/migrations/*.sql)
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "no migrations found under supabase/migrations/" >&2
  exit 1
fi
# Filenames are UTC timestamps, so lexical order is chronological order.
IFS=$'\n' migrations=($(printf '%s\n' "${migrations[@]}" | sort)); unset IFS
for m in "${migrations[@]}"; do
  echo "  - $(basename "$m")"
  "${PSQL[@]}" -f "$m" >/dev/null
done

echo "▸ Running RLS regression suite"
# Each assertion is a `select pg_temp.expect_*()` that echoes an empty result
# row on stdout; the meaningful output — the "N/N passed" summary, every
# "FAIL: ..." line, and the aborting RAISE — is emitted on stderr as
# NOTICE/WARNING/ERROR. Drop stdout to keep the log to the signal; psql's exit
# code (non-zero on any failing assertion, via ON_ERROR_STOP=1) still governs.
"${PSQL[@]}" -f "$ROOT/supabase/tests/rls_policies_test.sql" >/dev/null
