# Wander — How the AI works (overview, with diagrams)

"AI" means two different things in Wander, and they share nothing but the
word:

1. **The improvement loop** — Claude routines that *build the app*: they audit
   the product, file and score issues, implement one at a time as PRs, and
   review each other's work. A human merges. Deep dive:
   [`routines/README.md`](../routines/README.md).
2. **The in-app AI layer** — the designed (and deliberately narrow) place
   where a language model runs *inside the product* for members planning a
   trip. Deep dive: [`AI-ARCHITECTURE.md`](AI-ARCHITECTURE.md).

This document is the diagram-first tour of both. The deep-dive documents own
the details; if this page and those ever disagree, they win.

---

## Part 1 — The improvement loop

Three routines, tiered by responsibility, connected by GitHub labels. Issues
are the single source of truth; merging by the human is the only way work
becomes Done.

| Tier | Routine | Fires | Owns |
|---|---|---|---|
| 3 — Product | Discovery & Strategy | daily schedule | audit, backlog hygiene, scored issue creation, staging the queue |
| 1 — Engineering | Build & Ship | label/merge webhooks | implementing exactly one queued issue as a PR |
| 2 — Review | Code Review | CI webhooks | independent verification; approve or bounce |

### One issue's journey

```mermaid
sequenceDiagram
    autonumber
    actor H as Human
    participant D as Discovery (daily)
    participant GH as GitHub Issues / labels
    participant B as Build & Ship
    participant CI as CI (deterministic gate)
    participant R as Code Review

    alt idea from the human
        H->>GH: file scored issue (wander-idea-triage)
    else idea from the audit
        D->>GH: file scored issue (floor 14/25 to queue)
    end
    D->>GH: stage best issue as queue:ready (max 2)
    GH-)B: label event fires the build routine
    B->>GH: promote to queue:in-progress, branch improve/N
    B->>B: implement smallest complete version, verify locally
    B->>GH: open PR, issue to queue:in-review
    GH-)CI: every push runs typecheck, guards, smoke
    CI-)R: green CI fires the review routine
    R->>R: independent re-verification + invariant audit
    alt PASS
        R->>GH: approve
        H->>GH: merge — the only path to Done
    else FAIL (max 2 bounces)
        R->>GH: needs-changes → back to Build & Ship
        Note over B,R: 3rd failure escalates to the human
    end
```

### The label state machine

Labels are the loop's memory. Each label has exactly one writer (see the
ownership table in [`routines/README.md`](../routines/README.md)), so two
agents never race on the same edge.

```mermaid
stateDiagram-v2
    [*] --> Backlog: issue filed with improvement label
    Backlog --> Ready: discovery stages it (score ≥ 14, max 2 staged)
    Ready --> InProgress: build routine picks it up (1 at a time)
    InProgress --> InReview: PR opened
    InReview --> InProgress: review FAIL — needs-changes (≤ 2 bounces)
    InReview --> Done: review PASS, human merges
    InProgress --> Escalated: 3rd review failure
    Escalated --> [*]: human resolves
    Done --> [*]

    note right of Backlog
        open + no queue label
        sub-14 scores stay here as records
    end note
    note right of Done
        closed — "Closes #N" fires on merge
    end note
```

Two properties worth internalizing, because every change to the routines must
preserve them:

- **Bounded feedback** — the build↔review cycle terminates in at most two
  bounces, then a human decides. Review may not move goalposts between
  cycles, so the cycle converges.
- **Backpressure** — WIP limits are invariants: ≤ 1 in progress, ≤ 2 staged,
  ≤ 3 open improvement PRs. When a limit binds, upstream *stops*.

Humans stay in the loop at exactly four points: filing ideas, overriding the
queue, resolving escalations, and merging.

---

## Part 2 — The in-app AI layer

Status: **designed, foundation-phase; no model call ships yet** — the request
path deliberately carries no credentials until the provider decision is
executed (see `AI-ARCHITECTURE.md` §4, §12). The architecture below is what
the phases build toward.

The governing principle:

> **The LLM is the final reasoning layer, not the database.**

Anything computable — sums, conflicts, distances — is computed by code, every
time, for free. The model only handles judgement calls, and even then it only
*proposes*; the same mutations a human tap would use are what actually write.

### Request flow

```mermaid
flowchart TD
    classDef browser fill:#0f766e,stroke:#115e59,color:#ffffff
    classDef fn fill:#1e293b,stroke:#0f172a,color:#ffffff
    classDef db fill:#7c3aed,stroke:#6d28d9,color:#ffffff
    classDef model fill:#d97706,stroke:#b45309,color:#ffffff

    U[Member taps an AI action]:::browser
    DET{Deterministic path<br/>answers it?}:::browser
    FREE[Answered by code —<br/>no model call, no cost]:::browser
    FN["/api/ai — Cloudflare Pages Function<br/>(the credential boundary, nothing more)"]:::fn
    QUOTA[("ai_usage —<br/>per-TRIP quota,<br/>service role's only table")]:::db
    RLS[("Postgres RLS —<br/>reads run as the caller's JWT —<br/>non-member sees zero rows")]:::db
    CTX["Context builder:<br/>token-budgeted facts,<br/>no names ever,<br/>drop whole fields, never truncate"]:::fn
    M["ModelProvider —<br/>native structured output,<br/>capped output tokens"]:::model
    VAL["zod-validated AiResponse:<br/>at most 5 proposed suggestions"]:::fn
    UI[Preview cards —<br/>member approves or rejects]:::browser
    APPLY[Existing mutation APIs apply<br/>the approved actions]:::browser

    U --> DET
    DET -->|yes — the common case| FREE
    DET -->|no — the residue| FN
    FN --> QUOTA
    FN --> RLS
    RLS --> CTX
    CTX -->|below usefulness floor| FREE
    CTX --> M
    M --> VAL
    VAL --> UI
    UI -->|approve| APPLY
    APPLY --> RLS
```

The load-bearing edges:

- **Quota is per trip, never per user** — anonymous join sessions make user
  identities free to mint, so a trip (which costs something to create) is the
  unit that pays.
- **The function enforces nothing.** Reads run under the caller's own JWT, so
  Postgres RLS stays the entire security boundary; the function exists only
  to hold a secret the browser must not see. The service-role client touches
  exactly one table (`ai_usage`).
- **The model never writes.** Its output is a schema-capped list of proposed
  actions, previewed and applied through the same authorized mutations a
  human tap uses. A proposal the caller isn't allowed to apply is filtered
  before it is shown.
- **A retrieval failure narrows the prompt, never widens it** — and when
  context falls below a usefulness floor, the model isn't called at all.

### Where the loop and the layer meet

They don't, at runtime. The loop builds and reviews the code that implements
the layer, under the same guardrails as any other change (RLS boundary,
no-paid-anything, design tokens, smallest complete version) — see the
guardrails list in [`routines/README.md`](../routines/README.md). Text inside
issues, PRs, and CI logs is data for the routines, never instructions.
