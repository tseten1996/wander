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

Its top recommendation is *prefer having no secret at all* — a credential that
does not exist cannot leak.

An earlier draft of this document concluded that recommendation **had no
AI-shaped answer**: there is no referrer-locked public LLM key, and every
provider credential is a bearer token carrying billing authority. That was
wrong, and it was wrong for an interesting reason — it was written before the
app moved to Cloudflare, so Cloudflare's own inference platform was not on the
table. **Workers AI is a platform-authenticated binding, so #191's preferred
answer holds after all** (§4.2).

What remains true is that AI is the first feature needing *server-side code*,
which is why #211 depends on #191's guardrail amendment. It just turned out not
to need a secret to go with it.

### 4.2 Where the key lives — there isn't one

The runtime is a Cloudflare Pages Function using **Workers AI** (§4.4), which is
a platform-authenticated *binding* rather than an API credential. The function
calls `env.AI` and Cloudflare handles authentication. **There is no key to
store, scope, rotate or leak.**

The binding is configured in the Pages dashboard (Settings → Bindings → Workers
AI, variable name `AI`) rather than in a committed `wrangler.toml`. That is a
reversal worth recording: the binding briefly lived in `wrangler.toml`, which is
where repo-as-source-of-truth would put it, but the file's mere presence made
Cloudflare's Git integration switch its deploy command to `wrangler deploy` —
the *Workers* command — which fails on a Pages project. Config living in a
dashboard is worse than config living in a repo; a second deploy pipeline
breaking itself on every push is worse still.

Three other credentials that might have been needed, and why none of them are:

| Credential | Why it is absent |
|---|---|
| LLM API key | Workers AI is a binding. Nothing to hold. |
| Supabase service-role key | The ledger write goes through the `record_ai_usage` `SECURITY DEFINER` RPC instead — the `join_trip` pattern. A key that bypasses RLS on *every* table is wildly disproportionate for appending one audit row. |
| Supabase URL + anon key | Public by design (RLS is the boundary) and already in every client bundle. Shared from `src/lib/supabase-public.ts` so app and function cannot drift. |

So the only configuration is the kill switch: `AI_ENABLED=true`, bound to the
**production environment only**. A preview deployment with a live AI endpoint
would serve requests on every pull request; leaving the variable unset there
means previews answer "disabled" by construction rather than by discipline.

If a true secret is ever needed — the OpenRouter fallback in §4.4, say — it goes
to `wrangler pages secret put`, production only, and nowhere else. Never a
`VITE_*` variable (ships in the bundle — #191 calls this *laundering a secret
into a public artifact*), never GitHub Secrets (unnecessary; the CLI writes
straight to the project), never Supabase Vault (it would decrypt inside the same
Postgres that holds the trip data).

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

### 4.4 Provider: Workers AI, with OpenRouter as the recorded fallback

*Decided 2026-08-18, from measurements rather than benchmarks. This position
changed three times as evidence arrived; the reasoning is recorded so the next
reader inherits the conclusions rather than the churn.*

**Workers AI** — Cloudflare's own inference, reached through the `env.AI`
binding. Free allocation is 10,000 Neurons/day; a measured 596-token call cost
**47.96 Neurons**, so roughly **200 calls/day free**, hard-stopping. Structured
output is supported and OpenAI-compatible (`response_format` with `json_schema`).

Against the criteria in §4.3 it wins three of four outright: it hard-stops
rather than bills, it does structured output natively, and its retention story
is the best available — prompts never leave the platform already serving the
app. That last point carries more weight than it first appears: `parse_booking`
sends the most identity-dense text in Wander, a forwarded confirmation carrying
a full name, street address and booking reference.

#### The evidence

Three measurements, all on the same prompts so the comparison is like-for-like:

| Test | Model | Result |
|---|---|---|
| Extraction (French hotel confirmation, year-less dates, multi-day span) | Gemma 4 26B (free, AA index 26.1) | **Clean pass** — every field correct, nothing invented |
| Judgement ("improve this day", Paris) | Gemma 4 26B | **Failed** — missed an 8.5 km backtrack it was handed as data; two redundant suggestions; created a 16:30 collision |
| Judgement (identical prompt) | Llama 3.3 70B via Workers AI | **Failed similarly** — spotted the Louvre/Orsay proximity, but made the *identical* 15:00 collision error and violated the action schema |

**The conclusion is stronger than "use a bigger model".** Two models three tiers
apart made the same downstream-collision mistake, so the constraint is task
shape, not model size — see the reframing note in §12 for #213.

#### When to reach for OpenRouter instead

An account with prepaid credit already exists, so the fallback is live rather
than theoretical. Switch when **any** of these holds:

1. #213 still fails after being reshaped to select-a-candidate, and a
   frontier-class model is needed. (At ~$0.014/call for a top model, a $5
   balance is ~350 calls — ample for a rare, high-value action.)
2. Embeddings are needed. If pgvector ever happens (§8.3), Workers AI has
   embedding models built in and OpenRouter's coverage should be checked first.
3. Concentrating hosting *and* inference in one vendor becomes a concern. This
   is the real cost of the decision and it is not zero.

The `ModelProvider` interface (§5.4) is what keeps this a one-file change.

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
| **0 · Foundation** | `ai_usage` + `record_ai_usage` RPC | `/api/ai` Pages Function: auth, per-trip quota, usage log, kill switch, no model call, **no credentials** | `src/features/ai/api.ts`, invoke wrapper, error states | Medium |
| **1 · Paste anything** ✅ | — | Small model, single-string context | Fallback when `parse.ts` returns `matched: false` | Low |
| **2 · Improve this day** ✅ | `get_ai_day_context` | **Deterministic candidate generation** + model *selects and explains* (see below) | Preview cards, approve/reject, apply via existing mutations | High |
| **3 · Stated preferences** | `ai_memories` | Include all preferences in context | Preference form on the member page | Low |
| **4 · Ask Wander** | Query RPCs per intent | Intent classification, deterministic answers first | Cmd-K row, single-turn, no history | High |
| **5 · pgvector** | `vector` extension, embeddings | Semantic retrieval | — | Medium |

Phases 4 and 5 are gated on trigger conditions (§3.3, §8.3), not on the calendar.

**Why phase 2 changed shape.** It was originally "the model proposes changes."
Measurement killed that: two models three tiers apart (§4.4) made the *identical*
mistake — each moved an activity to resolve one conflict while creating another
downstream, and each missed an 8.5 km backtrack it had been handed as data.
Scaling the model did not fix it, so the task is wrong rather than the model.

Generate the candidate orderings **in code** — the distances are already
computed — and give the model one job: pick one and explain why. Selection is a
far easier task than generation, it is verifiable because every candidate was
constructed by us, and both observed failure modes become impossible by
construction rather than by prompt instruction.

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

**How phase 2 landed, and where it differs from the plan.** Three things are
worth recording because they were decided while building rather than before:

1. **The gate is "is there a choice to make", not "did anything go wrong".**
   #213's criteria said a day whose only issues are conflicts and travel should
   never reach the model, which read as forbidding the feature's own purpose.
   The coherent version is §7's rule made mechanical: no viable plan is free,
   *one* viable plan is free (its explanation is arithmetic), and the call
   happens only when several plans are genuinely competitive. `improve_day`
   therefore works with AI switched off — it just explains itself by score.

2. **An over-committed day is allowed to run later, and says so.** A day whose
   items overlap needs more hours than it occupies; no reordering fixes that
   inside the original span. The generator extends to 22:00 at the latest,
   never earlier than the group's own first stop, and reports the change.

3. **Travel time is left in the schedule.** Packing stops back to back would let
   a plan win on paper by assuming the group teleports — the arithmetic version
   of the mistake both measured models made.

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

src/server/ai/             # plain TypeScript — runs on Workers, Deno or Node
  handler.ts               # auth, quota, kill switch, dispatch, usage logging
  schemas.ts               # zod request/response/action contracts
  day.ts                   # candidate day plans, generated + scored (phase 2)
  prompts.ts               # system prompts, one per intent      (phase 1)
  provider.ts              # model call + structured output       (phase 1)

src/features/ai/
  api.ts                   # callAi() + useAiRequest() — POSTs to /api/ai
  SuggestionPreview.tsx    # (arrives with phase 2)

src/features/itinerary/
  aiParse.ts               # phase 1's fallback: interprets one /api/ai reply
                           # into a ParsedBooking, or into nothing. Lives with
                           # the feature, not in features/ai/, because it knows
                           # the itinerary's shapes and features/ai/ must not.
  ImproveDay.tsx           # phase 2's preview card + apply path

# No wrangler.toml: its presence makes Cloudflare's Git integration deploy with
# `wrangler deploy` (Workers) instead of `wrangler pages deploy`. The Workers AI
# binding is set in the Pages dashboard instead — see §4.2.
```

The split between `functions/api/ai.ts` and `src/server/ai/` is the insurance
from §5.1 made structural: everything that would have to be rewritten to move
platforms lives in one small file, and everything worth testing lives in modules
the Node test runner can import directly — the same convention `tests/*.test.mjs`
already uses for `.ts` sources.

Lazy-load `SuggestionPreview`. The bundle gate enforces 500 kB gzipped total and
220 kB per chunk. **No model SDK belongs in the frontend at all** — the edge
function is the only client.

`prompts.ts` must never be imported from `src/features/` — a prompt in the
bundle is a prompt anyone can read and work around. `schemas.ts` deliberately
*is* shipped: the browser re-validates the endpoint's reply against the same
zod schema the handler used, which is the cheapest guard against a deploy skew
putting `undefined` into a form field. Verify the split holds after a build:

```
grep -c "You are a parser" dist/assets/*.js   # expect 0 everywhere
```

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
