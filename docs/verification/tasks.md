---
title: verification — Tasks
owner: care-team
service: care-service
module: verification
status: in-progress
diataxis: how-to
last_verified: 2026-10-07
tags: [tasks, verification]
related: [verification-spec, verification-brainstorm]
---

# Verification development tasks

## Legend

- [ ] todo · [~] in progress · [x] done

## Tasks

- [x] (step 0 · docs) Apply C1–C6 to `contracts/openapi.yaml`, validate YAML and references.
- [x] (step 0 · docs) Update contract conformance fixtures for verification operations.
- [x] (step 1 · infra) Verify pinned AWS SDK dependencies (already installed; no package changes).
- [x] (step 1 · infra) Add and validate Identity, storage, and worker env variables and types.
- [x] (step 1 · infra) Add synthetic local and test env values.
- [x] (step 1 · infra) Add MinIO and private bucket/CORS setup to dev and test Compose (verified: stack healthy, ADR 0020).
- [x] (step 1 · infra) Update env tests and infrastructure env table.
- [x] (step 2 · schema) Create raw SQL `upload_intents` migration with grants and down.
- [x] (step 2 · schema) Create raw SQL `verification_documents` migration with grants and down.
- [x] (step 2 · schema) Create raw SQL `identity_sync_jobs` migration with grants and down.
- [x] (step 2 · schema) Create verification queue index migration with down.
- [x] (step 2 · schema) Update migration tests with round-trip, grant, and EXPLAIN assertions.
- [x] (step 2 · schema) Execute migrate/rollback/migrate and EXPLAIN against real Postgres.
- [x] (step 3 · lib) Build storage port/S3 adapter and MinIO adapter suite.
- [x] (step 3 · lib) Build Identity token, status, batch hydration client and DTOs.
- [x] (step 4 · module) Add verification enums, errors, types, entities, DTOs, repositories and policies.
- [x] (step 4 · module) Implement verification service transitions and doctors submit/read/edit collaboration.
- [~] (step 5 · runtime) Add worker loops, DI registration, routes and mounts. API wiring is done; worker loops remain for the separate task.
- [x] (step 5 · runtime) Wire request id, rate limit, idempotency and audit behavior for the API routes.
- [~] (step 6 · test) Add unit, integration, concurrency, RBAC, contract and MinIO suites.
- [~] (step 7 · qa/docs) CURL manual QA done 2026-10-08 (274 pass / 0 fail, see manual-qa.md; one low-severity worker finding open); as-built module and service docs/card still pending `/update-docs`.
- [ ] (step 7 · qa/docs) Hand off hub documentation and sync deltas.
