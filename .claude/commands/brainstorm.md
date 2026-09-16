---
description: Explore intent and scope for a new feature/module one question at a time, and write a brainstorm brief to docs/<module>/brainstorm.md (with frontmatter). Interactive, inline.
argument-hint: <module-or-feature>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion
disable-model-invocation: true
model: inherit
---

## Phase 1 of the feature workflow — Brainstorm

Target: **$ARGUMENTS**

You turn a rough idea into a clear brief. This step is **interactive and inline** — do NOT write application code and do NOT dispatch a subagent.

### Steps
1. **Establish context (cheap first).** Read `CLAUDE.md` ("Mission of this service", "Domain rules", "Authorization — RBAC and ownership", "Cross-service integration", "Out of scope"), `docs/INDEX.md`, `docs/system-design.md` (and only the `docs/architecture/*.md` shards the feature touches), `docs/adr/*` titles, `contracts/openapi.yaml` (the relevant tags), and any existing `docs/*/spec.md`. Read the relevant PRD section in `../vcare-hub/product/prd.md`. Read the hub only for what the feature touches at platform scope (CLAUDE.md → "Doc placement — hub or service"): crosses services → `../vcare-hub/INDEX.md` → `architecture/landscape.md`, `data-ownership.md`; changes runtime, routing, or availability → `architecture/deployment.md`; changes load or sizing → `architecture/capacity.md` (follow "Cross-service context (the hub)").
2. **Altitude check.** If the idea needs an architecture decision that is not yet recorded (a new cross-service call, a new data owner, a new infrastructure component, a queue, a cache strategy, a change to a hub deployment or capacity assumption), say so and recommend running `/system-design <topic>` first. Continue only if the user wants to. The brief itself is service scope: it lives in `docs/<module>/` and never edits hub docs — list needed platform changes under **Open questions**.
3. **Module slug.** Pick a kebab-case slug; reuse an existing `docs/<module>/` when the feature extends it.
4. **Ask clarifying questions ONE at a time** (prefer `AskUserQuestion`, multiple choice with a recommended option first). Cover: the user problem and actors (patient/doctor/admin/service); in/out of scope for this iteration; entities and relationships; primary flows and endpoints; **roles + ownership per endpoint**; business rules and state transitions; cross-service calls and their failure policy; privacy (PII/clinical data, audit); success criteria; risks. Stop when you can describe the feature without guessing.
5. **Flag conflicts early** with CLAUDE.md (forbidden libraries, stored slots, hard delete, clinical data to admins, trusting identity headers, anything in "Out of scope") and ask how to proceed rather than assuming.
6. **Write the brief** to `docs/<module>/brainstorm.md` (create the directory):

```markdown
---
title: <module> — Brainstorm
owner: <service owner from CLAUDE.md / service card>
service: <service id>
module: <module>
status: draft
diataxis: explanation
last_verified: <YYYY-MM-DD>
tags: [brainstorm, <module>]
related: [system-design]
---

# <module> — Brainstorm

## Problem & purpose
## Actors
## In scope (this iteration)
## Out of scope
## Key entities & relationships
## Primary flows / endpoints (with roles + ownership)
## Business rules & state transitions
## Cross-service touchpoints (case, direction, failure policy)
## Privacy & audit
## Constraints & guideline notes
## Contract changes expected
## Open questions
## Success criteria
```

7. Keep **Open questions** honest. Add a row for the brief in `docs/INDEX.md` (lens `explanation`).

### Finish
Summarize the brief in 3–5 lines, give the path, list expected contract changes, and name the next step: `/construct-spec <module>`.
