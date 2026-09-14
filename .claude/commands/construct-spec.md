---
description: Produce a contract-aligned module spec at docs/<module>/spec.md by dispatching flow-spec-author — with parallel read-only recon first when there are two or more large sources.
argument-hint: <module> [extra context]
allowed-tools: Agent, Task, Read, Grep, Glob, Bash, AskUserQuestion
disable-model-invocation: true
model: inherit
---

## Phase 2 of the feature workflow — Construct spec

Target: **$ARGUMENTS**

1. **Confirm inputs.** Module slug from the arguments. Check for `docs/<module>/brainstorm.md` and an existing `docs/<module>/spec.md` (this may be a revision).
2. **Size the sources (gate for parallel recon).** Candidate sources: the brainstorm brief; the module's operations in `contracts/openapi.yaml`; the relevant `docs/architecture/*.md` shards; for cross-service modules the hub's `architecture/landscape.md` + the other service's synced contract in `../vcare-hub/contracts/`; a sibling spec. Count sources **> 300 lines** that the spec genuinely depends on.
   - **Fewer than 2 large sources → no recon.** Go to step 4.
   - **2 or more → step 3.**
3. **Parallel recon (read-only).** In a **single message**, dispatch one `Explore` subagent per large source (max 4). Each gets: the module slug, its one source, and the instruction *"Return a digest ≤ 60 lines: the facts the spec must honor (endpoints with roles/ownership/error codes, tables/constraints, business rules, cross-service calls + failure policy, open conflicts). Quote exact names. Do not propose design."* Collect the digests.
4. **Dispatch `flow-spec-author`** (`subagent_type: flow-spec-author`) with: the slug, extra context, the brainstorm path, the digests (if any), and these requirements:
   - read `CLAUDE.md` (named sections), `contracts/openapi.yaml`, `docs/system-design.md` first;
   - every endpoint states guard, roles, ownership, error codes, idempotency; the spec must **mirror the contract** — gaps go under *Open questions → Contract changes required*;
   - frontmatter with `status: ready` only when Open questions is empty; add/refresh the module rows in `docs/INDEX.md`; flag service-card impact.
5. **Resolve open questions.** If the author returns Open questions needing a human decision, ask them **one at a time** (`AskUserQuestion`, recommended option first). Re-dispatch the author once with all answers to fold them in. Never leave a spec marked `ready` with unresolved questions.
6. Do not write the spec yourself — the subagent owns the file.

### Finish
Report the spec path, status, a short summary, any contract changes required (and whether they touch the other service — if so, the provider's contract must land first), and the next step: `/develop <module>`.
