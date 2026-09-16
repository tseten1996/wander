-- Member payment link (#347, settle-up "Pay" affordance)
--
-- Settle-up (#125) gets the math right and lets a member log a repayment, but
-- the actual paying is an out-of-app detour: recall the creditor's Venmo/PayPal
-- handle from memory, retype the amount, pay, come back, remember to log it.
-- This lets each member optionally store a payment link on their own profile so
-- the "you owe X" rows can open X's link with the owed amount prefilled.
--
-- A single nullable column on `members`, written through the *existing*
-- self-edit path — exactly as member dates (#286) were added. No new policy, no
-- new trust boundary.
--
-- Guardrail notes:
--   • RLS is untouched. `members_update` (init) already permits a member to
--     write their own row and the owner to write any member's row. The only
--     widening is at the COLUMN grant level (init revoked blanket UPDATE and
--     re-granted a named column list; #286 extended it with the two date
--     columns) — `payment_link` must join that grant or the policy would allow
--     the row but the grant would still reject writing the column.
--   • The value is member-supplied and rendered as a link, so it is normalized
--     to an `https:` URL client-side (src/features/budget/paymentLink.ts) and
--     RE-validated at render time before it ever becomes an `href`. A CHECK here
--     backs that at the DB boundary: a hand-crafted PostgREST write can only
--     store an `https://` string, never a `javascript:`/`data:` script sink.
--   • `members` is already in the `supabase_realtime` publication (init) — the
--     deliberate decision here is to leave it published, so a member setting or
--     clearing their link surfaces the Pay button on other members' devices
--     live, with no publication change required.
--   • Member reads are already trip-member scoped, so the link is visible to
--     members only. The public itinerary/recap projections (#127, #238) whitelist
--     trip + itinerary columns and never select from `members`, so this column
--     is not reachable through any public token — no projection change needed.

alter table public.members
  add column payment_link text
  constraint members_payment_link_https
  check (
    payment_link is null
    or (payment_link ~ '^https://' and char_length(payment_link) <= 2000)
  );

comment on column public.members.payment_link is
  'Optional member-set payment link (PayPal.me / Venmo / Revolut / any https URL) opened from settle-up with the owed amount prefilled. Normalized to https client-side and re-sanitized at render. Member-visible only; never in a public projection.';

-- Extend the column-level UPDATE grant. init revoked blanket UPDATE and
-- re-granted a named list; #286 added the date columns. Without adding
-- payment_link here, `members_update` would allow the row but the grant would
-- still reject writing the column.
grant update (display_name, color, arrives_on, departs_on, payment_link)
  on public.members to authenticated;
