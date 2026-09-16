---
title: "ADR 0008: Background work runs in a separate care-worker component"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, runtime, worker, background-jobs, deployment]
related: [deployment, resilience, integration, adr-0011-notification-outbox-and-reminders, adr-0010-next-available-lazy-cache-worker-refresh]
---

# ADR 0008 — Background work runs in a separate `care-worker` component

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
The Identity-sync retrier (Cases 1, 3, 4) was designed as a loop inside every API task. Care now also needs
notification delivery, a reminder scan, `next-available` refreshes, and audit-partition maintenance. Running all of
that in API tasks competes with the search (< 400 ms) and slot (< 300 ms) budgets and spreads email egress to every
task.

## Decision
- A **`care-worker`** component: same image as `care-api`, entrypoint `node dist/worker.js`, **1 task**
  (0.5 vCPU, 1 GB), restarted on liveness.
- It hosts: the `identity_sync_jobs` retrier and its sweeper; `notification_outbox` delivery
  ([ADR 0011](./0011-notification-outbox-and-reminders.md)); the reminder scan (every minute); `next-available`
  refreshes ([ADR 0010](./0010-next-available-lazy-cache-worker-refresh.md)); monthly `audit_logs` partition
  creation ([ADR 0009](./0009-audit-logs-monthly-partitions.md)).
- Every loop claims work with `FOR UPDATE SKIP LOCKED` (or an advisory lock for singleton loops), so running **2**
  workers is safe when lag alerts fire.
- `care-api` tasks are request-only. Only `care-worker` has egress to the email provider; `care-api` keeps egress to
  the video provider and object storage.
- A worker outage delays sync retries, emails, and refreshes; it never fails a request. `WorkerHeartbeatStale`
  alerts when the worker's heartbeat metric is older than 2 minutes.

## Consequences
- ➕ API latency isolated from background load; independent scaling; narrower egress.
- ➕ Mirrors `identity-worker` — one operational model.
- ➖ One more component to deploy (rolled out after `care-api`), monitor, and size.
- ➖ Case 3 retries stall if the worker is down; the inline attempts and `WorkerHeartbeatStale` page cover it.

## Alternatives considered
- **Loops in every API task** (previous design) — rejected: budget interference, wider egress.
- **Scheduled one-off tasks (cron)** — rejected: minute-level loops and continuous outbox delivery need a long-running process.
