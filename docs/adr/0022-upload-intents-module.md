---
title: "ADR 0022 — Upload-intent lifecycle as its own module"
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-19
tags: [adr, upload-intents, verification, record-attachments, object-storage, worker, extraction]
related: [adr-0013-verified-direct-upload-lifecycle, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, adr-0017-generic-helpers-and-transaction-scoping, adr-0021-identity-sync-engine-module, record-attachments-spec, verification-spec, file-handling]
---

# ADR 0022 — Upload-intent lifecycle as its own module

Date: 2026-10-19 · Status: accepted · Builds on [ADR 0013](./0013-verified-direct-upload-lifecycle.md) (does not change the lifecycle) and follows the shape of [ADR 0021](./0021-identity-sync-engine-module.md)

## Context
`verification` owns a private upload-intent lifecycle: the intent insert/find/close, the per-intent session advisory lock, the verify-and-promote step of `complete` (HEAD size, 16 leading bytes, ETag-bound promote, orphan cleanup) and the `upload-intent-purge` worker loop. The `upload_intents` table already allows `kind = 'record_attachment'`; the new `record-attachments` module needs the identical lifecycle for the files a doctor attaches to a medical record.

Copying the lifecycle duplicates the riskiest storage code in the service. Importing `VerificationService` or its repository from `record-attachments` would couple one module to another's private internals and invert the dependency (CLAUDE.md → Folder structure and layering). The purge is also verification-kind only (`kind = 'verification_document'` is hard-coded in the listing), a latent gap: a `record_attachment` intent would never be purged.

## Decision
1. A new bounded context `src/app/upload-intents/` (no routes, no controller, no policies) owns the lifecycle: `constants.ts`, `enums.ts` (`UploadIntentKind`), `errors.ts` (`UploadIntentExpired`), `types.ts`, `repository/upload-intents.repo.ts` (moved, with one predicate dropped), `service/upload-intents.service.ts` (`UploadIntentsService`) and `worker/upload-intent-purge.loop.ts` (moved). `verification` and, later, `record-attachments` call its **service**; the worker calls its purge primitives.
2. **The shared module knows no preconditions.** Each module supplies, as callbacks of `UploadIntentsService.complete`: target authorization (`authorizeTarget`), the replay lookup (`findResult`), the precondition check (`precheck`), and the row insert with its audit row (`insertResult`, run inside the shared short transaction), plus the final key prefix. The shared flow keeps verification's exact statement and storage order. This is the ADR 0021 shape (engine knows the job, the modules keep their rules).
3. **Lock and loop identifiers are unchanged.** Advisory-lock namespaces: `1101` per-intent session lock (constant renamed `UPLOAD_INTENT_LOCK_NAMESPACE`, was `VERIFICATION_INTENT_LOCK_NAMESPACE`), `1102` Identity sync (stays in `identity-sync/constants.ts`), `1103` purge singleton (id 0). The worker loop name stays `upload-intent-purge` (`node dist/worker.js --once upload-intent-purge`), third in the loop list.
4. **`UploadIntentRow.document_type` becomes `string | null`** so the shared module imports nothing from `verification`; `VerificationService` narrows it with a guard and answers `Conflict` for an unknown value, as it did for a missing one.
5. **`buildVerificationPolicies(intents)`** receives the intent lookup as a port (`Pick<UploadIntentsService, "findIntent">`): a policy never imports another module's repository.
6. **Registration order.** `UploadIntentsService` is registered immediately before `VerificationService` (it needs only `Db`, `STORAGE`, `Env`); `worker-loops.ts` builds it and passes it as the last constructor argument of `VerificationService` and as the service of the purge loop.

### Intentional, observable differences (each covered by a test)
1. The orphan-cleanup log event `verification_orphan_cleanup_failed` becomes `upload_orphan_cleanup_failed` with a `kind` field (no test or alert referenced the old name).
2. The metric `upload_verification_failed` carries the label `kind` next to `reason="invalid_file"`.
3. The purge lists and closes expired open intents of **every** kind (the `kind` predicate is dropped from `listExpiredOpenIntents`; `closeIntent` still only touches open rows).
4. On the rare "intent no longer open" conflict inside the short `complete` transaction, the target row (the doctor profile) is no longer read before the throw: one statement fewer on a failure path only. The happy path is statement-for-statement identical (proved by the golden statement test, committed before the move).

Routes, responses, audit rows, error codes, rate limits and worker behaviour of `verification` are identical. No new dependency, no environment variable, no migration, no contract or `lib/storage` change.

## Consequences
- One implementation of the riskiest storage code, tested at its own boundary for both kinds; `record-attachments` becomes a thin module (target authorization, cap, insert, audit).
- `verification/constants.ts` keeps only `VERIFICATION_DOCUMENT_KEY_PREFIX`; the intent constants, enum, error and types live in `upload-intents`.
- The extraction lands in its own commits, with verification's unit, integration and manual-QA suites green before any attachment migration, route or contract edit. Verification's existing tests are the oracle: they move mechanically (spy targets, constructor argument, import paths) and no `expect(...)` line changes.
- An operator reading logs or dashboards must use the new log event name and the extra metric label (runbook updated at `/update-docs`).

## Alternatives considered
- **Keep the lifecycle in `verification` and import it from `record-attachments`.** Rejected: cross-module private coupling and an inverted dependency; verification would own record-attachment semantics.
- **Copy it into `record-attachments`.** Rejected: two copies of the verify-and-promote step diverge; a fix in one (for example the ETag binding) would silently miss the other.
- **Move the verify-and-promote step into `lib/storage`.** Rejected: the step also closes intents and emits the failure metric, i.e. it is intent lifecycle (Care rules and `upload_intents` rows), not storage; `lib/` must not know Care's tables.
