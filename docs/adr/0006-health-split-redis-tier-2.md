---
title: "ADR 0006: Redis is Tier 2; health splits into liveness and readiness"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, health, redis, availability]
related: [infrastructure, resilience, deployment, runbook, adr-0005-availability-and-recovery-targets]
---

# ADR 0006 — Redis is Tier 2; health splits into liveness and readiness

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
`GET /api/health` and `GET /internal/health` returned `503` when Postgres **or Redis** failed. Behind a load balancer,
a Redis outage would drain every Care task at once — turning a cache outage into a full outage. Identity solved the
same problem (identity ADRs 0008, 0014).

## Decision
- **Redis is Tier 2.** Its loss degrades Care, never takes it down:
  - caches (`slots:*`, `next-available:*`, `identity:user:*`) → every read is a miss (slower, still within limits);
  - idempotency → booking falls back to `uq_consultations_idempotency`; reschedule/cancel replays stay safe
    ([resilience.md](../architecture/resilience.md));
  - rate limits → a per-instance in-memory fallback limiter at `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))`.
- **Health endpoints** (both listeners):

| Endpoint | Checks | 200 | 503 |
|---|---|---|---|
| `…/health/live` | event loop responsive; no dependencies | `{ status: "ok" }` | never |
| `…/health/ready` | Postgres `SELECT 1` (500 ms) — fatal; Redis `PING` — reported only | `{ status: "ok" \| "degraded", checks: { database, redis } }` | Postgres down, or shutdown in progress |

- Load balancers use readiness; the orchestrator restarts on liveness only. The edge never routes health.
- **Contract change:** replaces `GET /api/health` and `GET /internal/health` (lands via `/construct-spec` + `/develop`).

## Consequences
- ➕ A Redis failover no longer drains the fleet; a Postgres blip no longer restart-loops tasks.
- ➕ Same health semantics in both services — one runbook model.
- ➖ Contract, runbook, and synthetic monitors change; a fallback limiter is looser across the fleet.

## Alternatives considered
- **Redis Tier 1, one endpoint** — rejected: a cache outage becomes a Care outage.
- **Tier 2 with one endpoint** — rejected: no liveness/readiness distinction for the orchestrator.
