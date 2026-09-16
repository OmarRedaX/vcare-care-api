---
title: "ADR 0015: AWS SDK v3 modular packages for the storage adapter"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, dependency, object-storage, s3]
related: [file-handling, infrastructure, adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls]
---

# ADR 0015 — AWS SDK v3 modular packages for the storage adapter

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team (decision D6 of the file-handling `/system-design`)

## Context
ADRs 0013 and 0014 need presigned POST policies, presigned GETs with response overrides, `HEAD`, ranged `GET`,
`COPY`, and `DELETE` against S3 (reference platform, hub ADR 0007) and against MinIO locally. `CLAUDE.md` → Tech
stack requires an ADR before any new runtime dependency. The storage port (`lib/storage`) exists; no client was
locked.

## Decision
- Add **`@aws-sdk/client-s3`**, **`@aws-sdk/s3-presigned-post`**, and **`@aws-sdk/s3-request-presigner`**, pinned to
  one minor version together.
- They are imported **only** in `src/lib/storage/s3.adapter.ts`, behind the port:
  `createUploadPolicy(key, maxBytes, ttl)`, `headObject(key)`, `readHead(key, bytes)`, `promote(fromKey, toKey)`,
  `presignDownload(key, contentType, ttl)`, `delete(key)`. Modules never import the SDK; tests mock the port in unit
  tests and use MinIO in integration tests.
- Local and test runs use `STORAGE_ENDPOINT` with path-style addressing; production uses the task role for
  credentials (static keys only in local development).
- Per-call timeout 2 s on `HEAD`/ranged `GET`/`DELETE`, 10 s on `COPY`; SDK retries limited to 2.

## Consequences
- ➕ Correct SigV4 and POST-policy signing on the security-critical path, maintained upstream.
- ➕ One adapter file to change if the provider changes.
- ➖ Three packages and their transitive dependencies to track for updates and advisories.

## Alternatives considered
- **Hand-rolled SigV4 on `undici`** — no new dependency, but we would own signing and policy-encoding edge cases for
  clinical files. Rejected.
- **A generic S3-compatible client (e.g. `minio`)** — one package, but a thinner fit for AWS POST-policy and bucket
  specifics on the reference platform. Rejected.
