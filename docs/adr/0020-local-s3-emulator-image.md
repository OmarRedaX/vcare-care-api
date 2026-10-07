---
title: "ADR 0020 — Local S3 emulator image (frozen community MinIO build)"
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-07
tags: [adr, storage, s3, minio, docker, local-development, testing]
related: [adr-0015-aws-sdk-storage-adapter, adr-0013-verified-direct-upload-lifecycle, file-handling]
---

# ADR 0020 — Local S3 emulator image (frozen community MinIO build)

Date: 2026-10-07 · Status: accepted · Supplements [ADR 0015](./0015-aws-sdk-storage-adapter.md) (does not change its decision)

## Context
ADR 0015 chose the AWS SDK v3 adapter, exercised against "MinIO locally". On 2026-10-07 the official images were no longer
obtainable: `docker pull minio/minio` and `minio/mc` return *pull access denied*, and `quay.io/minio/*` returns `401`.
The adapter suite and manual QA still need a local S3 that **honors presigned POST policies** (exact key,
`content-length-range`), `HEAD`, ranged `GET`, `COPY`, `DELETE` and presigned `GET`.

## Decision
Dev and test compose run `bitnamilegacy/minio` — a frozen community build of MinIO (`2025-05-24`, includes `mc`) — **pinned by
image digest**, for both the server and the one-shot `minio-setup` service. Spiked 2026-10-07 with the project's SDK
versions: valid POST → 204; oversize POST → `EntityTooLarge`; wrong key → `AccessDenied (Policy Condition failed)`; `HEAD`,
`Range: bytes=0-4`, `COPY` all work. Bucket CORS is MinIO's server-wide `MINIO_API_CORS_ALLOW_ORIGIN`;
`docker/minio-cors.xml` stays as the **AWS bucket CORS reference**. MinIO rejects the `x-amz-server-side-encryption: AES256` POST condition (`501 NotImplemented`) unless a KMS is configured, so compose sets a synthetic static `MINIO_KMS_SECRET_KEY`; the adapter therefore enforces SSE-S3 exactly as it does on AWS. The image is local/test infrastructure only; production
uses AWS S3 (hub ADR 0011) and is never affected.

## Consequences
- No application code changes; `STORAGE_*` env contract unchanged.
- The frozen build receives no security updates → loopback-only ports, synthetic credentials, never used outside a developer machine or CI.
- If the digest becomes unavailable, replace the image and re-run the adapter suite; the suite is the acceptance test.
- Rejected: SeaweedFS (POST-policy request returned 403 in the spike, not pursued); in-memory fake only (never exercises POST-policy semantics).
