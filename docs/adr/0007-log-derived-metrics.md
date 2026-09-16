---
title: "ADR 0007: Log-derived metrics (embedded metric format); no tracing SDK in MVP"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, observability, metrics, logging, alerts]
related: [deployment, infrastructure, runbook, resilience]
---

# ADR 0007 — Log-derived metrics (embedded metric format); no tracing SDK in MVP

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
Care's alerts (search/slot latency, hydration degradation, Identity sync failures, outbox lag, replica lag, budget
burn) need metrics. Care already has a structured JSON logger and `X-Request-Id` propagation. identity-service chose
log-derived metrics (identity ADR 0013); the hub records Care alignment as pending. New runtime dependencies need an ADR.

## Decision
- The `Logger` gains `metric(name, value, unit, dimensions)` writing one JSON line in the platform's **embedded metric
  format** (e.g. CloudWatch EMF) to stdout. No new dependency.
- Dimensions never hold PII, clinical data, object keys, or tokens — the same redaction rules as log lines.
- Metric and alert set: [deployment.md](../architecture/deployment.md) → Observability.
- Cross-service tracing is by `X-Request-Id`; OpenTelemetry stays a future **joint** Identity + Care ADR.

## Consequences
- ➕ Parity with Identity: one pipeline, one dashboard model, zero collectors.
- ➖ No span breakdown; latency debugging uses request-id log search and `EXPLAIN`.
- ➖ Formatter is tied to the platform's log ingestion (hub ADR 0007).

## Alternatives considered
- **OpenTelemetry now** — rejected: Care alone would break the shared baseline and add a collector and dependencies.
- **Prometheus client** — rejected: new dependency and scrape plumbing on managed containers.
