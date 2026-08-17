# Wander — AI architecture

How AI fits into Wander, what it is deliberately *not* allowed to do, and the
order the pieces get built in.

This document sits alongside `ARCHITECTURE.md`, which describes the app as it
exists today. Everything here is additive: no existing feature changes shape,
no existing `api.ts` is rewritten, and the security model does not move.

---

## 1. The governing principle

> **The LLM is the final reasoning layer, not the database.**

If a question can be answered by SQL, a rule, or arithmetic, it is answered that
way and no model is called. The model is reserved for outputs that are a
*judgement* — where there is no correct answer to compute, only a better or
worse suggestion.

This is not primarily a cost decision, though it is what makes the cost
negligible. It is a correctness decision: a `sum()` is right every time, and a
model asked to add numbers is right most of the time. "Most of the time" is not
a standard shared trip finances should be held to.

Three rules follow, and they are load-bearing:

1. **Deterministic first.** Every feature leads with what can be computed. The
   model handles the residue, and is *told* what was already computed so it
   doesn't spend output tokens rediscovering it.
2. **The model proposes, existing APIs dispose.** An AI response is a list of
   *proposed actions*, schema-validated, authorized, previewed, and applied by
   the same mutation a human tap would use. The model never writes to a table.
3. **Retrieve better instead of sending more.** Context is assembled to a hard
   token budget per feature. A retrieval failure narrows the prompt; it must
   never widen it.

---

## 2. What already exists (and must not be rebuilt)

Wander already has a substantial deterministic layer. Several features that look
like obvious "AI features" are shipped rules engines, and proposing them again
would be duplicated work:

| Capability | Where | Shipped in |
|---|---|---|
| Same-day time-conflict detection, surfaced as an inline badge | `src/features/itinerary/overlap.ts` → `ItineraryPage.tsx` | #81 |
| Straight-line distance + rough travel time between consecutive stops | `src/lib/geo.ts`, `itinerary/directions.ts` → `LegHint` | #123 |
| Whole-day route hand-off to Google/Apple Maps | `itinerary/directions.ts` → `DayDirectionsAction` | epic #60 |
| Weather-aware packing suggestions | `src/features/packing/suggestions.ts` | #178 |
| Booking-text → itinerary fields (title, category, day, times, location) | `src/features/itinerary/parse.ts` | #77, #103 |
| Geocoding a typed address on save, so items pin themselves | `src/lib/geocode.ts` → `ItineraryPage.tsx` | #201 |
| Multi-city legs with date ranges | `destinations` table | #197 |

**The practical consequence:** the deterministic pre-pass that this design calls
for is largely already built and already visible in the UI. That is good news —
it means the model's job is narrow and well-defined from day one — but it also
means "surface the conflicts we already compute" is *not* available as an easy
first win. It is done.

The genuine remaining gaps are the ones below.

---

## 3. Constraints from Wander as it actually is

Three facts about the current codebase constrain any AI design. Each one
invalidates an otherwise reasonable plan.

### 3.1 Destinations exist — use them, don't re-model them

As of #197 (`20260810062600_destinations.sql`) a trip is an **ordered list of
legs**: `destinations` rows carrying `name`, optional geocoded `latitude` /
`longitude`, an optional `start_date`–`end_date` range, and a float `position`.
Members read them; **writes are owner-only** (`is_trip_owner`), because the route
is trip structure, like the dates.

Two consequences for AI context:

- **Destination-scoped retrieval is now writable.** A day can be resolved to the
  leg containing it, so context can say *"day 4 of 6 in Kyoto"* rather than
  quoting the whole trip. That is materially better grounding for the same
  token count — a model reasoning about a day in Kyoto should not be told about
  the Tokyo hotel.
- **Do not let an AI slice extend this model.** The legs are owner-controlled
  trip structure. If a suggestion would move a leg boundary, that is a
  destination-editing feature and belongs in its own issue, not smuggled in
  behind an AI preview.

Note the legacy column: `trips.destination` (free text) still exists alongside
the table. Context builders should prefer the `destinations` rows and fall back
to the text column only when a trip has no legs.

### 3.2 Anonymous sessions make per-user quotas meaningless

`src/hooks/useAuth.tsx` calls `signInAnonymously()` for anyone arriving through
an invite link. Anyone holding a link can mint unlimited distinct `auth.uid()`
values on demand.

**Therefore AI quotas are enforced per *trip*, never per user.** Trip creation
is already restricted to non-anonymous users by the `trips_insert` policy, which
makes a trip the only identity in the system that costs something to create. A
leaked invite link should cost one trip's daily allowance, not an open tab.

This is the single most important cost control in this document.

### 3.3 Cmd-K search is client-side only

`src/features/search/useTripSearch.ts` searches the **TanStack Query cache
only** — no network — across five kinds (polls, messages, checklist, notes,
ideas), and only for sections whose page has been opened this session. It does
not cover the itinerary or the budget.

So a natural-language "Ask Wander" is not an evolution of the existing search;
it is a new server-side retrieval path that happens to share a keyboard
shortcut. Sharing the entry point is still the right product call — one place to
ask things beats a chat bubble on every page — but it must be budgeted as new
work, not as an extension.

### 3.4 Two smaller ones

- The RLS helpers take a trip id: `is_trip_member(t)`, `is_trip_owner(t)`,
  `my_member_id(t)`.
- `itinerary_items.latitude` / `.longitude` are nullable. Coverage improved with
  #201, which geocodes a typed address on save, but it is still not guaranteed:
  items saved before that shipped, items with no location, and addresses the
  geocoder cannot resolve all have null coordinates. **Anything reasoning about
  proximity must treat missing coordinates as an ordinary case** and say what it
  could not evaluate, rather than silently reasoning over the located subset —
  the same honesty `DayDirectionsAction` already applies when it reports "3 of 5
  stops".

---

## 4. Credentials and the provider

### 4.1 This is Wander's first true secret

`#191` establishes the distinction that resolves most credential questions: a
**public credential with scoped authority** (the Supabase anon key, a
referrer-locked geocoding key) is safe to ship because its blast radius is bounded
by something other than secrecy. A **true secret** must never reach the client.

Its top recommendation — *prefer having no secret at all* — has worked every time
so far, and **it does not survive contact with this case.** There is no
referrer-locked public LLM key; these credentials are bearer tokens carrying
billing authority. AI is the first feature that genuinely needs somewhere to put
a secret, which is why it depends on #191 rather than merely relating to it.

### 4.2 Where the key lives

The runtime is a **Cloudflare Pages Function** (see the decision record in §5.1),
so the key is a Pages secret, bound **per environment**:

```bash
# Production only, deliberately. See below.
npx wrangler pages secret put OPENROUTER_API_KEY --project-name wander
```

Read it from the request's `env` binding. Rotation is the same command plus a
redeploy.

**Bind it to production only.** Preview deployments get their own environment,
and a preview with a working AI endpoint is a live endpoint spending real money
on every pull request. Previews should get the endpoint and a clean "AI is
disabled in previews" refusal — the §10 kill switch applied per-environment.
Costs nothing to do at the start; expensive to discover after a busy PR day.

Three places it must never go:

| Never | Why |
|---|---|
| `VITE_*` at build time | Ships inside the JS bundle, readable in devtools. #191 calls this *laundering a secret into a public artifact* — it looks legitimate because CI is involved and is exactly as exposed as hardcoding it. |
| GitHub Secrets | Unnecessary: `wrangler pages secret put` writes straight to the Pages project, so the key never enters a workflow environment and can never be caught by a `set -x` or a debug print. The repo already holds `SUPABASE_ACCESS_TOKEN`, the DB password and the Cloudflare token; another credential in a system that does not need it is pure downside. Fewer copies, fewer leaks. |
| Supabase Vault | Trust-domain separation (#191). A Vault secret decrypts inside Postgres, which already holds trip data, member identities and invite codes — one Postgres compromise would take both the data and the credential. Cloudflare puts the key one domain further out still. |

### 4.3 Choosing a provider — the criteria that actually matter here

Not "which model is best". This architecture caps context at ~1,000 tokens and
gives the model a narrow job, which makes model quality far less decisive than
the four properties below.

1. **Does it hard-stop, or does it bill you?** The same question #191 asks of a
   geocoding key, and it matters more here. Because invite links mint anonymous
   sessions (§3.2), the realistic incident is not a stolen key — it is volume. A
   **prepaid credit balance that fails when exhausted** is structurally safer
   than postpaid billing with alerts, because a burst cannot outrun it.
2. **Native structured output, reliably.** The whole safety argument — propose,
   validate, preview, approve — rests on schema-valid JSON. A provider where that
   is best-effort turns a guarantee into a retry loop, and retries double the bill
   exactly where value is least likely.
3. **Data retention defaults.** See §4.5.
4. **Two tiers from one account** — a cheap model for extraction (#212) and a
   stronger one for judgement (#213), without two billing relationships.

### 4.4 Recommendation: an aggregator for the pilot, direct once settled

**Use OpenRouter (or an equivalent aggregator) for phases 1–3.** It scores well
on criteria 1 and 4, which are the two that bite first: prepaid credits are a hard
cap *by construction*, and one key reaching many models is worth real money while
it is still unknown which model does "Improve this day" well.

Three conditions:

- **Turn prompt logging and training off explicitly** (§4.5).
- **Keep it behind the `ModelProvider` interface** (§5.4) so switching to a direct
  provider is a one-file change, not a refactor.
- **Verify structured-output behaviour on the specific model chosen**, not in
  general — support varies by underlying provider through a proxy, and that is
  precisely where an aggregator's abstraction leaks.

**Switch to direct once a model is settled.** At that point the aggregator's main
benefit is spent and it costs a markup plus an extra network hop and one more
party in the trust chain.

*Pricing, retention defaults and structured-output support in this space change
monthly. Re-check all three against current provider documentation before
committing — do not trust the state of the world described here.*

### 4.5 Retention, and the thing Wander has not decided

Some model routes are cheaper **because the underlying provider retains prompts
or trains on them.** Wander's prompts carry itinerary items, place names and
budget figures for someone's actual holiday. Configure retention off at the
account level and restrict to routes that honour it; do not assume the default is
acceptable.

Two things follow that are worth stating plainly:

- **Wander has no privacy policy.** Today that is defensible — every service it
  calls is keyless and receives almost nothing. The AI feature is the **first time
  user content leaves Wander's infrastructure**, and because of guardrail #3
  friends never signed up for anything or agreed to terms. Not a blocker and not a
  legal opinion, but the UI should say what is sent and to whom at the point AI is
  invoked.
- This is a second, independent reason to keep context minimal — beyond token
  cost — and to keep member names out of it entirely, which §6 already does.

---

## 5. The service boundary

The API key cannot live in the bundle, so AI requests go through a server-side
function. **This is the first server-side code in Wander** — it brings a secret
store, a second runtime, and a new failure mode (function down / cold /
rate-limited) that the PWA has never had to render. Plan it as "Wander gets a
backend", not "we add an endpoint".

### 5.1 Decision record: the runtime is a Cloudflare Pages Function

*Decided 2026-08-17, after #246 put the app on Cloudflare Pages. Recorded because
the reasoning is not obvious from the outcome, and because an earlier draft of
this document specified Supabase Edge Functions.*

**Context.** Wander's server-side logic today is entirely `SECURITY DEFINER` RPCs
in Supabase. #246 added Cloudflare Pages as a second static origin, which made
Pages Functions available at no additional infrastructure cost and reopened a
question that had already been answered the other way.

| Dimension | Cloudflare Pages Functions | Supabase Edge Functions | Edge |
|---|---|---|---|
| Deploy pipeline | Ships with the `wrangler pages deploy` already running | New workflow + `supabase functions deploy` | **CF** |
| CORS | Same origin as the app — none needed | Cross-origin: preflight, headers, a browser-only bug class | **CF** |
| PR previews | Each PR gets its own function build | One shared function across all previews | **CF** |
| Local dev | `wrangler pages dev` | `supabase functions serve` — wants Docker | **CF** |
| Secret scoping | Per environment (preview vs production) | Project-wide | **CF** |
| Trust domain (#191) | Key sits in a third provider, furthest from trip data | Key sits with the same vendor as the data | **CF** |
| Free tier | 100,000 requests/day, shared with Workers | Not stated in public docs; #191 recorded 500K/month | **CF** |
| JWT verification | Manual — but unnecessary, see below | `verify_jwt` at the platform level | *Supabase* |
| Latency to Postgres | Edge → the project's region | Same provider, likely closer | *Supabase* |
| Invocable from the DB | Awkward | Natural (`pg_cron`, triggers) | *Supabase* |
| Fits repo conventions | First server logic outside Supabase | Matches "server-side = Supabase" | *Supabase* |
| RLS read pattern | supabase-js runs on Workers | Native | Tie |

**Decision: Cloudflare Pages Functions.**

The tally (6–4) is not the argument; the *character* of each side is. Every
Supabase advantage is marginal or hypothetical — latency is tens of milliseconds
against an LLM call measured in seconds, and DB-invocation matters only if the
design changes to something nothing here proposes. Every Cloudflare advantage is
felt weekly: no CORS layer, one pipeline, a working endpoint on every preview.

**Two things that look decisive and are not:**

- *`verify_jwt`.* The RLS read **is** the verification. A forged or expired token
  is rejected by PostgREST and returns zero rows, and the membership check that
  decides which trip to bill is itself RLS-enforced — so identity is established
  by Postgres as a side effect of a read we were doing anyway. No separate
  verification step and no second secret.
- *"Fits repo conventions".* The real objection, and the one a good reviewer
  raises. It loses because this function **enforces nothing**: Postgres keeps
  doing all authorization. It is a credential holder, not business logic, so the
  authorization model does not fragment.

**On the free tier** — Cloudflare's 100K/day is a *daily* cap that resets at
midnight UTC, where a monthly quota, once drained, stays drained for the rest of
the month. Given the abuse vector in §3.2 is a leaked invite link, a cap that
resets daily fails better than one that does not. Static Pages requests do not
count toward it; only Function invocations do.

**What would flip this:**

1. AI needs invoking from inside the database (`pg_cron`, a trigger, an RPC
   calling out) → Supabase becomes obviously right.
2. More than one server-side function appears and the split starts costing real
   cognitive overhead → consolidate on Supabase.
3. Cloudflare's limits tighten materially below Supabase's.

**Make being wrong cheap.** The runtime-specific part is the request handler —
roughly 30 lines. The context builder, schema validation, quota logic and
`ModelProvider` are plain TypeScript that runs on either platform. Hold that
boundary and reversing this decision is an afternoon, not a rewrite. That
insurance is worth more than getting the choice right first time.

### 5.2 Which client reads the data

The critical decision. Get it wrong and the security boundary quietly moves from
Postgres into TypeScript.

```ts
// functions/api/ai.ts — a Cloudflare Pages Function
const authHeader = req.headers.get('Authorization') ?? ''

// READS: the caller's own JWT. RLS applies exactly as it does in the browser.
// A non-member gets zero rows — isolation is enforced by Postgres, not by
// remembering to add `.eq('trip_id', tripId)` to every query.
const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: authHeader } },
})

// PRIVILEGED: quota reads and usage writes only. Never touches trip content.
const asService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
```

Two rules, and they are the whole model:

- **The service-role client never reads or writes a content table.** Its entire
  surface is `ai_usage`. Reaching for it to fetch itinerary items is an
  authorization bug.
- **The `trip_id` in the request body is untrusted, and that is fine.** Every
  read runs as the caller, so a forged id returns nothing. Add an explicit
  membership check anyway, so the caller gets a clean `403` rather than a
  confusing empty result.

### 5.3 Contract

`zod` is already a dependency, so the contract costs no bundle weight. The
function runs on Deno and the app on Vite, so rather than fight cross-runtime
imports, **duplicate the schema and add a unit test asserting the two agree**.

```ts
export const AiRequest = z.object({
  intent: z.enum(['PARSE_BOOKING', 'IMPROVE_DAY']),
  tripId: z.string().uuid(),
  payload: z.record(z.unknown()),
})

export const AiResponse = z.object({
  summary: z.string().max(280),
  suggestions: z.array(Suggestion).max(5),  // hard cap bounds output tokens
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
})
```

Cap the suggestion array **in the schema**, not just in the prompt. A prompt
instruction is a request; a schema constraint is a guarantee — and output tokens
are the expensive side, at roughly 8× input.

Use the provider's native structured-output mode rather than parsing free text.
It removes an entire failure class; the one it doesn't remove (a well-formed
object that is semantically wrong) is caught by zod plus the approval UI.

### 5.4 Model abstraction

One interface, one implementation. Do not build a provider registry for a single
provider — the point of the interface is that §4.4's "aggregator now, direct
later" is a one-file change, not that several providers coexist.

```ts
export interface ModelProvider {
  complete(args: {
    system: string
    user: string
    schema: JsonSchema        // native structured output, not "please reply in JSON"
    maxOutputTokens: number   // bounded in code, not only in the schema
    tier: 'cheap' | 'reasoning'
  }): Promise<{ json: unknown; inputTokens: number; outputTokens: number }>
}
```

`tier` rather than a model name, so the choice of model lives in one place and
the call sites stay honest about *why* they want a given tier (§9).

---

## 6. Context builder

The abstraction worth building carefully, because it is where cost is actually
decided. Everything else is plumbing.

```ts
export interface ContextRequest {
  tripId: string
  memberId: string
  intent: Intent
  focus?: { day?: string; itemId?: string }
  budgetTokens: number
}

export interface BuiltContext {
  facts: Record<string, unknown>
  estimatedTokens: number
  dropped: string[]   // what did not fit — for observability
}
```

Responsibilities: **retrieve** the minimum set of facts for the intent,
**rank** by value-per-token, **fit** to budget, **report** what was dropped so a
bad answer can be diagnosed as a retrieval failure rather than a model failure.

**Never put a person in the context.** No `display_name`, no `member_id`, no
"paid by" attribution, no chat authorship — refer to people positionally
("someone in the group") when a suggestion needs to mention them at all. Two
reasons, and the second is the one that lasts: the model does not need identities
to reorder a day, and every prompt leaves Wander's infrastructure (§4.5), so the
cheapest way to keep a friend group's names out of a third party's logs is never
to send them. This is a rule about the *builder*, not about each call site
remembering — a context field carrying a name is a bug in this module.

Two rules:

- **Compress by dropping whole fields, never by truncating.** A half-serialized
  object is worse than an absent one: the model cannot tell it is incomplete, so
  it fills the gap by inventing.
- **A retrieval failure must never widen the prompt.** If the resulting context
  falls below a minimum usefulness threshold — a day with one item cannot be
  improved — return a deterministic "not enough to work with" and *never call
  the model*.

Token estimation is `Math.ceil(chars / 4)` with headroom in the budgets. A real
tokenizer is a dependency and a cold-start cost buying precision we don't need;
the decision is whether to include a field, not how to pack to the byte.

---

## 7. Relational retrieval — Postgres as the graph

Wander's traversals are shallow and fixed-depth (trip → day → item → linked
budget entry), every edge is a foreign key, and every traversal is a join
written once. A graph database earns its place when traversal depth is
*variable and data-dependent*; Wander's never will be. **This is the correct end
state, not a compromise to revisit.**

```sql
create or replace function public.get_ai_day_context(p_trip_id uuid, p_day date)
returns jsonb
language sql stable security invoker      -- INVOKER: the caller's RLS applies
set search_path = public
as $$
  select jsonb_build_object(
    'trip', (select jsonb_build_object('currency', t.currency)
      from trips t where t.id = p_trip_id),
    -- The leg this day falls in (#197). Grounds the model in one city instead
    -- of the whole trip; falls back to trips.destination for legless trips.
    'leg', coalesce((
      select jsonb_build_object('name', d.name, 'startDate', d.start_date, 'endDate', d.end_date)
      from destinations d
      where d.trip_id = p_trip_id
        and d.start_date <= p_day and coalesce(d.end_date, d.start_date) >= p_day
      order by d.position limit 1),
      (select jsonb_build_object('name', t.destination) from trips t where t.id = p_trip_id)),
    'day', p_day,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'title', i.title, 'category', i.category,
        'startTime', i.start_time, 'endTime', i.end_time,
        'location', i.location, 'lat', i.latitude, 'lng', i.longitude,
        'cost', i.cost)
        order by i.start_time nulls last, i.position)
      from itinerary_items i
      where i.trip_id = p_trip_id
        and (i.day = p_day or (i.day <= p_day and i.end_day >= p_day))
    ), '[]'::jsonb),
    'daySpend', (select coalesce(sum(coalesce(b.actual_converted, b.actual, 0)), 0)
      from budget_entries b where b.trip_id = p_trip_id and b.entry_date = p_day)
  );
$$;
```

`security invoker` is the important word: the function inherits the caller's
row-level policies, so it cannot leak across trips even if the edge function
passes a trip id the caller has no business seeing. **Reserve `security definer`
for operations that genuinely need to exceed the caller's rights — on the read
path, that is none of them.**

### When SQL beats a model

| Question | Tool | Cost |
|---|---|---|
| How much are we spending? | `sum()` | $0 |
| Which day is busiest? | `count() … group by day` | $0 |
| What's on Friday after dinner? | indexed filter + sort | $0 |
| What's near the hotel? | bounding box + `haversineKm` | $0 |
| What would this group enjoy? | send all stated preferences | ~400 tok |
| How should we reorder Friday? | RPC context → small model | ~$0.001 |

Rule of thumb: **if the answer is a number, a list, or a sort, it is SQL.** The
model earns its call only when the output is a judgement.

No PostGIS. A bounding-box prefilter plus the existing `haversineKm` over a few
dozen rows is instantaneous, and avoids adding an extension to a database whose
500 MB storage limit is the real constraint.

---

## 8. Memory

### 8.1 Stated, not mined

The tempting design is to extract durable preferences from chat — *"Sarah
prefers moderately priced restaurants."* **Do not build this.** The objection is
not cost.

Wander's RLS is trip-scoped: anything in an AI memory table is readable by
**every member of the trip**. Automatic extraction therefore means a model reads
a person's casual messages, infers a durable characteristic about them, writes
it down as fact, and publishes it to the group — without that person ever seeing
the sentence. That example is a claim about Sarah's finances, inferred from a
throwaway line, now durable and visible to her friends. The failure mode is
social, and the person harmed never opted in.

**Start with stated preferences only:** a short form — "what do you enjoy?
anything to avoid?" — writing rows with `source = 'stated'`. Boring, and it
fixes everything: the member wrote the sentence, so it is accurate; they know it
exists; they can edit it; it costs nothing to produce.

If derived memory is added later, the rules that make it defensible are: the
subject approves it before it persists (not the trip owner, and not silently);
it is attributed and visible to them; it is deletable by them alone; and it is
never derived from chat a member could not reasonably expect to be mined.

| Should be memory | Should not be memory |
|---|---|
| Stated preferences ("we like jazz") | Anything derivable by SQL (totals, counts, dates) |
| Stated constraints ("no nightclubs", dietary needs) | Raw chat messages |
| Group norms the group agreed to | Inferences about a person's money or health |
| Free-form trip intent ("a slow architecture trip") | Anything that changes — budgets, itinerary state |

### 8.2 Schema

```sql
create table public.ai_memories (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid references public.members(id) on delete cascade,
  source text not null check (source in ('stated', 'derived')),
  content text not null check (length(content) <= 280),
  content_hash text not null,      -- re-embed only when this changes
  created_at timestamptz not null default now()
);

alter table public.ai_memories enable row level security;

create policy ai_memories_select on public.ai_memories for select
  using (is_trip_member(trip_id));
create policy ai_memories_insert on public.ai_memories for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy ai_memories_update on public.ai_memories for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));
create policy ai_memories_delete on public.ai_memories for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));
```

Note the absent `embedding` column — see below.

### 8.3 pgvector is deferred, and may never be needed

Do the arithmetic. A single trip's durable preferences are perhaps 10–40 short
strings; at ~12 tokens each that is under 500 tokens — **the entire corpus fits
inside the budget for one call.** Approximate nearest-neighbour search over a
set you could send in full is pure overhead: an embedding API call on write, an
index to maintain, and a similarity threshold to tune, all to avoid sending 400
tokens already budgeted for.

**Build pgvector when either** (a) a single trip's memory corpus routinely
exceeds ~1,500 tokens, so it can no longer be sent whole, **or** (b) memory
becomes cross-trip — a traveller profile persisting between trips. Until then,
`select * from ai_memories where trip_id = $1` is strictly better: cheaper,
simpler, exact, zero embedding spend.

When it does arrive: `content_hash` is the whole cost story — embed on insert,
re-embed only when the hash changes, never on read. **Do not create an HNSW
index initially**; below ~1,000 rows a sequential scan with exact distance beats
an approximate index and has no build cost, memory overhead, or recall tuning.
For storage: a 1536-dimension vector is ~6 KB per row, so 10,000 memories is
~60 MB of the 500 MB free tier — another argument for stated-only memory.

---

## 9. Model routing

Three tiers, and the first has no model in it.

| Tier | Handles | Examples |
|---|---|---|
| **Deterministic** | Anything expressible as a query or rule | Totals, busiest day, conflicts (`overlap.ts`), legs (`directions.ts`), packing (`suggestions.ts`), parsing (`parse.ts`) |
| **Small model** | Extraction, classification, normalization | Unstructured paste → fields; "move dinner to 7" → an action |
| **Reasoning model** | Judgement over retrieved context | Improve this day; what should we do tonight |

**No automatic escalation, initially.** Escalating on low confidence sounds
prudent and is a silent cost multiplier: the calls that escalate are exactly the
ambiguous ones, so you pay twice precisely where you were least likely to get
value. Pick the tier from the intent — a fixed mapping.

**Fallback:** model error, timeout, and schema-validation failure all collapse
to the same outcome — *return no suggestions, with a plain message and a manual
retry affordance.* Do not auto-retry; a retry on a validation failure usually
fails the same way and always doubles the bill. Log the intent and context size
so a systematic problem becomes visible.

Do not build an `AiRouter` with a strategy enum yet. With one or two features
the routing decision is *which button the user pressed* — already unambiguous.
Build it when three or more intents genuinely overlap, which realistically means
when Ask Wander arrives.

---

## 10. Cost and quota

At roughly $0.001 per action, unit cost is not the risk. **The risk is volume
you did not authorize** (§3.2).

```sql
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  feature text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  estimated_cost_usd numeric(10,6) not null default 0,
  created_at timestamptz not null default now()
);

create index ai_usage_trip_day_idx on public.ai_usage (trip_id, created_at desc);

alter table public.ai_usage enable row level security;

-- Members may read their trip's usage (this powers the usage panel).
-- There is deliberately NO insert/update/delete policy: the edge function
-- writes with the service role, which bypasses RLS. No client can forge or
-- erase a usage row, which is what makes the quota trustworthy.
create policy ai_usage_select on public.ai_usage for select
  using (is_trip_member(trip_id));
```

Two repo-specific notes:

- `scripts/check-invariants.mjs` fails CI if a migration creates a table without
  `enable row level security` **and** at least one policy in the same file. The
  select policy satisfies the gate; the *absence* of a write policy is
  deliberate design, so state that in the migration comment.
- **These migrations must reach the database through `supabase db push` on a
  push to main.** Applying schema through the Supabase MCP stamps a different
  version into the remote history, desynchronizing local and remote — the
  failure that silently blocked six migrations for eleven days in August 2026.

### Two controls that live outside the code

**A hard spend cap at the provider, configured before the first line is written.**
This is the most important control in the system and none of it is code. Every
control below is defence in depth *behind* it; if all of them fail, the cap is the
difference between an annoying morning and a four-figure bill. Prefer a prepaid
balance that stops (§4.3) over a limit that alerts. Use a project or account
scoped to Wander alone, so a runaway is bounded by that budget rather than a
personal account's.

**A kill switch — a flag that disables AI without a redeploy.** When something is
going wrong and it is not yet clear what, the useful lever is one that turns the
feature off in a click. A deploy pipeline is not that lever. Check it in the
function before the quota check and fail closed on a read error, the same as the
quota itself.

### Cheap wins, in order of value

1. **Deterministic-first.** Every question answered by SQL is a 100% saving.
2. **Cap output in the schema.** Output is ~8× input; bounding the array bounds
   the bill.
3. **Gate on data density.** A day with one item cannot be improved — refuse
   before calling.
4. **Idempotency key on identical (trip, day, item-state).** Pressing the button
   twice with nothing changed returns the previous result. The one cache worth
   building early, because it is trivially correct.
5. **Embed on write, never on read** — if embeddings ever exist.

---

## 11. Testing

The constraint that shapes everything: **CI must never call a model.**
Non-deterministic, costs money, fails offline.

| Layer | Pins down | Lives in |
|---|---|---|
| Unit | Budget fitting, drop order, token estimation, action authorization | `tests/*.test.mjs` (existing resolve-hook convention) |
| Retrieval | RPC shape and field selection against seeded data | `supabase/tests/` |
| Security | Non-member gets nothing; caller cannot write via the AI path; usage rows unforgeable | `supabase/tests/rls_policies_test.sql` |
| Prompt contract | Recorded model outputs — valid, malformed, adversarial — all handled | Fixtures, no network |
| Eval | ~20 hand-labelled days: does the suggestion make sense? | Manual, run before prompt changes |
| End-to-end | Preview renders, approval applies, **rejection changes nothing** | `tests/smoke.mjs`, function stubbed like Supabase already is |

The highest-value test is the least glamorous: **assert that rejecting a
suggestion mutates nothing.** That is the property the entire propose-then-approve
design exists to guarantee, and the one a refactor is most likely to quietly
break.

The eval set stays manual and small deliberately — twenty examples someone has
actually read beats an automated harness scoring outputs nobody has looked at.

---

## 12. Phases

| Phase | Database | Server | Frontend | Complexity |
|---|---|---|---|---|
| **0 · Foundation** | `ai_usage` + RLS | `/api/ai` Pages Function: auth, per-trip quota, usage log, kill switch, no model call | `src/features/ai/api.ts`, invoke wrapper, error states | Medium |
| **1 · Paste anything** | — | Small model, single-string context | Fallback when `parse.ts` returns `matched: false` | Low |
| **2 · Improve this day** | `get_ai_day_context` | Context builder, reasoning model, action authorization | Preview cards, approve/reject, apply via existing mutations | High |
| **3 · Stated preferences** | `ai_memories` | Include all preferences in context | Preference form on the member page | Low |
| **4 · Ask Wander** | Query RPCs per intent | Intent classification, deterministic answers first | Cmd-K row, single-turn, no history | High |
| **5 · pgvector** | `vector` extension, embeddings | Semantic retrieval | — | Medium |

Phases 4 and 5 are gated on trigger conditions (§3.3, §8.3), not on the calendar.

**Why "Paste anything" is phase 1 rather than "Improve this day":** it needs no
context builder, no RPC, and no retrieval — the entire prompt is the pasted
text. It only runs when the free path already failed (`matched: false`), so the
common case stays free and the deterministic-first principle is enforced
structurally rather than by discipline. The approval UI already exists: the
parser's output opens the create form pre-filled, and the AI path returns the
same `ParsedBooking` shape into that same form. And correctness is obvious — the
user is looking at the email they pasted. It exercises auth, quota, usage
logging, structured output, zod validation and error degradation with a blast
radius of one form.

Note for phase 2: `20260731004000_budget_update_owner_creator.sql` restricts
budget edits to the entry's creator or the trip owner. A suggestion that edits a
budget entry must be authorized against *who is asking* before it is shown, or
the preview will offer an action that then fails at the database.

---

## 13. Folder structure

Four server files, not nine directories. Split when a file becomes
uncomfortable — that is a real signal; anticipating the split is not.

```
functions/                 # Cloudflare Pages Functions — file-routed
  api/
    ai.ts                  # the ONLY runtime-specific file: request in,
                           # Response out. Keep it ~30 lines so §5.1's
                           # "reversing this is an afternoon" stays true.

src/server/ai/             # plain TypeScript — runs on Workers or Deno
  handler.ts               # auth, quota, kill switch, dispatch, usage logging
  context.ts               # context builder + token budgeting
  prompts.ts               # system prompts, one per intent
  provider.ts              # model call + structured output
  schemas.ts               # zod request/response/action contracts

src/features/ai/
  api.ts                   # useImproveDay() etc. — the existing convention
  schemas.ts               # mirrors the server schemas; a test asserts parity
  SuggestionPreview.tsx
  index.ts
```

The split between `functions/api/ai.ts` and `src/server/ai/` is the insurance
from §5.1 made structural: everything that would have to be rewritten to move
platforms lives in one small file, and everything worth testing lives in modules
the Node test runner can import directly — the same convention `tests/*.test.mjs`
already uses for `.ts` sources.

Lazy-load `SuggestionPreview`. The bundle gate enforces 500 kB gzipped total and
220 kB per chunk. **No model SDK belongs in the frontend at all** — the edge
function is the only client.

---

## 14. Core types

```ts
export type Intent = 'PARSE_BOOKING' | 'IMPROVE_DAY'

export interface SuggestionBase {
  id: string
  reason: string           // required, not optional — see below
}

export type Suggestion =
  | (SuggestionBase & { type: 'MOVE_ACTIVITY'; itemId: string; day: string; startTime: string | null })
  | (SuggestionBase & { type: 'REORDER_DAY'; itemIds: string[] })
  | (SuggestionBase & { type: 'ADD_NOTE'; itemId: string; note: string })

export interface AiResult {
  summary: string
  suggestions: Suggestion[]
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  droppedContext: string[]
}

/** Every suggestion is authorized against the caller before it is ever shown. */
export interface ActionAuthorizer {
  canApply(s: Suggestion, ctx: { memberId: string; isOwner: boolean }): boolean
}
```

`reason` is required because a suggestion the model cannot justify is one the
user cannot evaluate, and an unexplained change to a shared trip is worse than
no change.

Keep the action union **small and closed**. Every member is code that must be
written, authorized and tested; a generic `UPDATE_ANY_FIELD` action would
collapse the entire safety argument into "trust the model".

---

## 15. Not building yet

| Thing | Build it when |
|---|---|
| `AiRouter` with a strategy enum | Three or more intents genuinely overlap |
| pgvector, embeddings, HNSW | Memory exceeds the token budget, or goes cross-trip |
| Automatic memory extraction from chat | There is a consent flow for the person being described |
| Multi-turn conversation history | Users actually ask follow-ups — and the cost is measured |
| Prompt versioning / A-B infrastructure | Prompt changes outpace what git can explain |
| Response caching beyond the idempotency key | A hit rate is measurable |
| Model escalation on low confidence | The escalated call provably earns its doubled cost |
| LangChain / LangGraph | Multi-step tool-using agents exist — which this design avoids |
| Neo4j / Pinecone | Genuinely never, on this data model |
| Automated eval harness | The manual set of ~20 becomes the bottleneck |

Each is correct engineering for a system with more traffic, features, or people
than Wander has. Building them early does not just cost the build — it fixes
decisions before the evidence that should inform them exists.

---

## 16. Summary

Build the boring, secure, observable pipe first and put the cheapest possible
feature through it. The deterministic layer is already there and already good;
the model's job is the residue, and the residue is small.

The risk in this plan is not that any single piece is wrong — it is building the
later phases before the earlier ones have taught you which of them you actually
need.
