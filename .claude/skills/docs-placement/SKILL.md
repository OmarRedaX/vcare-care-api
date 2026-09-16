---
name: docs-placement
description: Use before reading or writing any vcare doc — deciding whether a doc or fact belongs in the hub (../vcare-hub, platform scope) or in this service's docs/ (service scope), when to read the hub versus local docs, splitting a topic such as capacity, deployment, availability, observability or data ownership between the two, and checking that no doc landed in the wrong repo. Covers the scope test, the placement table, the roll-up pattern, read and write rules per workflow phase, anti-patterns, and verification.
---

# Doc placement — hub or service (vcare)

## Overview

vcare is three repos: `vcare-identity-api`, `vcare-care-api`, and the hub `vcare-hub`. **Every doc and every fact
has exactly one home, decided by scope** (hub ADR 0008):

- **platform scope → the hub** `../vcare-hub`
- **service scope → the service repo** `docs/`

**The repo you are working in does not decide where a doc goes.** A platform doc written into a spoke is invisible
to the other service and gets forked the next time it designs the same topic. A service doc written into the hub
drifts from the code that makes it true.

## The scope test

Ask two questions:
1. **Whose code makes this true?** One service → service. Several services, the edge, or shared infrastructure → platform.
2. **Who must agree on it without reading one service's code?** Another service, ops, product → platform.

Both answers point at one service → **service**. Either points beyond it → **platform**. The topic has both parts →
**split** (roll-up pattern below).

## Placement table

| Content | Scope | Home |
|---|---|---|
| PRD, requirements, NFRs | platform | hub `product/prd.md` |
| System context (C4 L1), platform containers (C4 L2), services at a glance, architectural principles, shared technical baseline | platform | hub `architecture/overview.md` |
| Edge routing, network zones and rules, every service's runtime components, availability/DR roll-up, release pipeline, cross-service observability, IaC and secrets approach | platform | hub `architecture/deployment.md` |
| Shared traffic assumptions (users, DAU, peak model, hostile load), cross-service load, per-service sizing roll-up | platform | hub `architecture/capacity.md` |
| Dependency graph, service-to-service auth, integration cases and failure policies, internal API surface | platform | hub `architecture/landscape.md` |
| Which service writes which data | platform | hub `architecture/data-ownership.md` |
| Shared terms | platform | hub `glossary.md` |
| Decisions binding more than one service, the edge, or the platform | platform | hub `adr/` |
| Service list, owners, tiers | platform | hub `catalog/service-catalog.md` |
| Service card, OpenAPI contract | service (synced) | spoke `docs/service-card.md`, `contracts/openapi.yaml` → hub copies written only by `scripts/sync-from-spoke.sh` |
| Module map, layering, request pipeline, listeners, this service's container view | service | `docs/architecture/overview.md` |
| Tables, constraints, indexes, ERD | service | `docs/architecture/data-model.md` |
| Endpoint prose (mirrors the contract) | service | `docs/architecture/api.md` |
| Env vars, logging and redaction, health, error envelope details | service | `docs/architecture/infrastructure.md` |
| This service's capacity derivation: per-endpoint load, compute, database, per-table storage, its 10× check | service | `docs/architecture/capacity.md` |
| This service's runtime components, scaling triggers, network rules, release specifics, bottlenecks, metrics, alerts | service | `docs/architecture/deployment.md` (or the matching runtime/resilience shard) |
| Consumer or provider implementation of an integration case (client, retry jobs, alerts) | service | the integration / resilience shard |
| Runbook, quickstart, service ADRs, module docs (brainstorm, spec, tasks, QA, reviews) | service | `docs/` |

## The roll-up pattern (split topics)

Capacity, deployment, availability, observability, and data ownership have a platform part **and** a service part.

- **Hub:** the platform part, plus **one row per service** with headline values (task counts, DB class, storage,
  availability target) and a link to the service doc.
- **Service:** the derivation and detail, linking to the hub for its inputs.
- **Author each number once.** Inputs (traffic assumptions, platform rules) are authored in the hub; values derived
  from them are authored in the service. A quoted value always links to where it is authored, and the quoting doc is
  never the place to change it.
- **Same-session rule:** changing a headline in a service doc updates its hub row; changing a hub input means every
  service re-derives (or records that it must, in hub `TODO.md`).

Example — capacity: "500 k registered / 50 k DAU, peak hour 15 % × 2" is authored in hub `architecture/capacity.md`;
"refresh ≈ 12 rps peak, `refresh_tokens` ≈ 6 GB, `identity-api` 2 × (1 vCPU, 2 GB)" is authored in
`vcare-identity-api/docs/architecture/capacity.md`; the hub roll-up quotes the task count and storage total with a link.

## Frontmatter marks scope

- Hub `architecture/` and `adr/` docs: `service: platform`, `owner: platform-team`.
- Spoke docs: `service: <service-id>`. **A spoke doc never has `service: platform`.**
- The spokes' Stop hook (`.claude/hooks/docs-sync-check.sh`) blocks a `service: platform` doc under a spoke's `docs/`
  and a hub `architecture/` or `adr/` doc without `service: platform`.

## When to read which

| You are… | Read |
|---|---|
| building, testing, or reviewing this service's internals | this repo's `CLAUDE.md` and `docs/` only — don't load the hub |
| touching a cross-service call, borrowed data, a shared term | hub `landscape.md`, `data-ownership.md`, `glossary.md`, the other service's synced contract — then the local shard |
| touching deployment, networking, edge routes, scaling, availability, release, observability | hub `deployment.md` first, then the local runtime shard |
| sizing anything or changing a load assumption | hub `capacity.md` first, then the local capacity shard |
| orienting on the whole system | hub `INDEX.md` → `overview.md` |
| needing another service's internals | CLAUDE.md → "Cross-service context (the hub)" escalation (sibling on disk → ask → GitHub MCP; never clone to read) |

## Who writes where

| Phase | Writes (this repo) | Hub |
|---|---|---|
| `/system-design` | service shards, `system-design.md`, service ADRs, INDEX rows | **writes** platform docs directly, updates this service's roll-up rows — the only phase that hand-edits the hub |
| `/brainstorm`, `/construct-spec` | `docs/<module>/` | read only; needed platform changes → Open questions |
| `/develop`, `/write-tests`, `/manual-qa`, `/review-code` | code, tests, module docs | read only; report needed platform changes |
| `/update-docs` | service docs, contract drift, service card | lists platform deltas + hub file for `/system-design`; asks for the sync when card/contract changed |
| `scripts/sync-from-spoke.sh` | — | the only writer of hub `catalog/*.card.md` and `contracts/*` |

## Anti-patterns

- ❌ Writing the platform topology, the edge table, the release pipeline, or shared traffic assumptions into a
  service doc because the design session happened in that repo.
- ❌ Copying a hub doc (or its diagram) into `docs/` "for convenience" — link to it.
- ❌ The same number authored in both repos with no link — they will disagree.
- ❌ Putting module internals, env vars, or one service's alerts into the hub.
- ❌ Hand-editing hub `catalog/*.card.md` or `contracts/*`.
- ❌ Relative links from `docs/service-card.md` to the hub — the sync rewrites `../` links to point into the spoke;
  name hub docs in plain text there.
- ❌ Leaving the other service's roll-up row silently wrong — mark it pending in hub `TODO.md`.

## Moving a misplaced doc

1. Split it with the scope test: the platform part goes to the hub doc from the table (create it with
   `service: platform` if missing), the service part stays.
2. Replace the moved content locally with a one-line pointer to the hub doc; keep the local filename if ADRs link to it.
3. Fix every link (`grep -rn '<filename>'` across all three repos), add hub `INDEX.md` rows, bump `last_verified`.
4. If the card or contract changed, run the sync.

## Checklist before finishing any doc change

- [ ] Every doc written passed the scope test and sits in its one home
- [ ] Split topics: the hub roll-up row and the service derivation agree and link to each other
- [ ] `grep -rlE '^service:[[:space:]]*platform' docs/` in this repo prints nothing
- [ ] New hub docs have `service: platform` and a row in hub `INDEX.md`; new local docs have a row in `docs/INDEX.md`
- [ ] `last_verified` bumped on every touched doc; `../vcare-hub/scripts/check-freshness.sh` passes
- [ ] Card or contract changed → hub sync run
