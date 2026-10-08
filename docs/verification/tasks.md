---
title: verification — Tasks
owner: care-team
service: care-service
module: verification
status: implemented
diataxis: how-to
last_verified: 2026-10-08
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
- [x] (step 5 · runtime) Add worker loops (`identity-sync`, `upload-intent-purge`), DI registration, routes and mounts; worker deps, `--once` mode and pool close path done.
- [x] (step 5 · runtime) Wire request id, rate limit, idempotency and audit behavior for the API routes.
- [x] (step 6 · test) Add unit, integration, concurrency, RBAC, contract and MinIO suites (final: unit 1154, integration 489 green on 2026-10-08).
- [x] (step 7 · qa/docs) CURL manual QA done 2026-10-08 (274 pass / 0 fail, see manual-qa.md); the low-severity worker-hydration finding was fixed in `fac9c08`. As-built notes, service card, INDEX and architecture shards reconciled by `/update-docs` on 2026-10-08.
- [~] (step 7 · qa/docs) Hub documentation deltas handed to the lead as a precise list (landscape, deployment, capacity, glossary) and the Identity internal-users dependency; hub branch edits and `../vcare-hub/scripts/sync-from-spoke.sh` remain open until the lead applies them.
- [x] (step 6 · test) Fix review 20261008-1500: pending-sync guard, ETag-bound promote, no idempotency on URL routes, session-lock and rate-limit tests, keyset index use, worker backoff re-check, layering and logging items (typecheck, lint, unit and full integration suites green).
