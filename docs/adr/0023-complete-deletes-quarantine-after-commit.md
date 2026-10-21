---
title: "ADR 0023 — Delete upload quarantine after completion commits"
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-20
tags: [adr, upload-intents, verification, record-attachments, object-storage, retry]
related: [adr-0022-upload-intents-module, adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls, record-attachments-spec, verification-spec, file-handling]
---

# ADR 0023 — Delete upload quarantine after completion commits

Date: 2026-10-20 · Status: accepted · Supersedes the cleanup ordering described in [ADR 0022](./0022-upload-intents-module.md) and clarifies the upload lifecycle in [ADR 0013](./0013-verified-direct-upload-lifecycle.md) and [ADR 0014](./0014-on-demand-download-urls.md).

## Context

K1: the shared `UploadIntentsService.complete` deleted the quarantine object after promoting it and before the short database transaction. An audit failure, deadlock, connection reset, local suspension recheck or late attachment cap failure could roll back that transaction. The final object was then deleted best-effort, leaving an open intent without bytes. Retrying the same upload id failed file validation and required a new upload. Both verification documents and record attachments used this flow.

## Decision

Promote the ETag-bound object, commit the short transaction that inserts the result and closes the intent, then delete the quarantine object best-effort. A transaction failure still deletes the promoted final object best-effort and rethrows, but retains the quarantine object and open intent for retry. A post-commit quarantine delete failure logs `upload_orphan_cleanup_failed` with `kind` and does not change the successful response. Logs contain no object keys.

Precheck, invalid-file and expired-intent cleanup, advisory locks, replay, error codes, responses and rate limits remain unchanged. No migration or contract shape change is needed.

## Consequences

- Once the underlying transaction failure clears, a retry of the same upload id can complete and create exactly one result row.
- A quarantine object may linger for up to 24 hours only if the best-effort post-commit delete fails; the bucket lifecycle expires `quarantine/` objects.
- The `goldenIntentStatements` JSON needs no edit: its `complete.sql` and `complete.storage` entries separately record the same statements and storage calls. Their interleaving changes from delete-before-transaction to delete-after-commit, which the golden file does not represent. Unit tests assert that order explicitly.
