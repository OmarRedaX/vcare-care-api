---
title: record-attachments — Tasks
owner: care-team
service: care-service
module: record-attachments
status: in-progress
last_verified: 2026-10-19
tags: [tasks, record-attachments, records, upload-intents, extraction, clinical]
related: [record-attachments-spec, record-attachments-brainstorm, verification-spec, records-spec, adr-0021-identity-sync-engine-module, adr-0022-upload-intents-module]
---

# record-attachments — Tasks

Source: [spec.md](./spec.md) (v0.1.0, section 13 task order). Branch `feature/record-attachments`. **Slice 1 (E0 + E1, the behaviour-preserving extraction of `upload-intents` out of `verification`) is worked first and lands before any attachment migration, route or contract edit** (spec section 2, step 5). The remaining tasks stay open until slice 2.

## Legend
- [ ] todo · [~] in progress · [x] done

## Slice 1 — extraction (worked now)
- [x] (docs) E0: ADR 0022 `docs/adr/0022-upload-intents-module.md` + `docs/INDEX.md` row
- [x] (docs) E0: baseline counts recorded (unit 157 suites / 2988 tests; integration baseline in the table below; verification curl script not run, see Verification record)
- [x] (test) E0: golden statement test in `tests/integration/verification.test.ts`, written and passing on the **unchanged** code before any move
- [x] (module) E1: `src/app/upload-intents/` constants, enums, errors, types, repository (moved), `UploadIntentsService`, purge loop (moved)
- [x] (module) E1: `TOKENS.UploadIntentsService`, `bootstrap.ts` (registered immediately before `VerificationService`), `worker-loops.ts`
- [x] (module) E1: `verification` service / repository / policies / routes / types / enums / errors / constants cleanup (`buildVerificationPolicies(intents)`)
- [x] (test) E1: mechanical repointing of the existing verification and admin-doctors tests (no changed `expect` line)
- [x] (test) E1: new unit and integration tests for the shared module (kind `verification_document` and `record_attachment` at the service boundary)
- [x] (docs) E1: as-built notes (verification spec section 16, file-handling, architecture overview module map, INDEX)

## Slice 2 — record-attachments proper (NOT started in this dispatch)
- [ ] (contract) 0: contract edits C1-C6 in `contracts/openapi.yaml` + the CLAUDE.md owner edit of C5 (`AttachmentLimitReached` row and Domain-rules sentence)
- [ ] (lib) 1: `attachmentDescription` redaction key + test row; `AttachmentLimitReached` in `lib/error/types.ts`; the no-store row
- [ ] (migration) 2: `20261018120000_create_record_attachments` (table, constraints, partial index, `forbid_attachment_delete_after_lock` trigger, column-level grants)
- [ ] (migration) 2: `20261018120100_comment_upload_intents_description` + migration and `db-roles` tests
- [ ] (enums-errors-types) 3: `record-attachments` `constants.ts` / `enums.ts` / `errors.ts` / `types.ts`; `records` `RecordLockRow` and `RecordWithAmendments` / `RecordUpdateResult` additions
- [ ] (entity) 4: `RecordAttachment` entity
- [ ] (request-dto) 4: `RecordAttachmentIntentDto`
- [ ] (response-dto) 4: `RecordAttachmentResponseDto` (viewer-aware, admin throws)
- [ ] (repository) 5: `record-attachments.repo.ts`, `findLockRowForNoKeyUpdate`
- [ ] (service) 6: `RecordLinksService.lockForNoKeyUpdate`, `RecordAttachmentLinksService`, `RecordAttachmentsService`; DI tokens and `bootstrap.ts` (links services before the records services); the `records` plug-ins (queries, update, DTO, controller) and their test updates
- [ ] (policies) 7: `policies.ts` (`record_attachment_writer`; export `recordReaderRule` from `records/policies.ts`)
- [ ] (controller) 7: `RecordAttachmentsController`
- [ ] (routes) 7: `routes.ts` + `rate-limits.ts`
- [ ] (mount) 7: mount after the records router in `src/routes.ts`
- [ ] (tests) 8: unit, integration, RBAC, contract, concurrency, lock boundary, privacy, EXPLAIN, migrations (spec section 10) ← /write-tests
- [ ] (manual-qa) 9: `scripts/curl-test-record-attachments.sh`, re-run `scripts/curl-test-verification.sh` ← /manual-qa
- [ ] (docs) 9: service card, INDEX, architecture shards, runbook, records/verification spec pointers, as-built notes (spec section 14) ← /update-docs

## Verification record (slice 1)
Environment: isolated native PostgreSQL 18 on `127.0.0.1:5499` (trust auth, database `care_test`), Redis db 14 on `:6379`. Docker unavailable. Pre-existing environment failures, not part of this work: `tests/integration/storage-adapter.test.ts` (needs MinIO: 3 tests plus a suite that fails to run) and 4 password-rejection cases of `tests/integration/db-roles.test.ts` (trust-auth server); they fail identically before and after.

| Gate | Before the refactor | After the refactor |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npm run lint` scope (`npx eslint src tests`) | not run | clean |
| `npm test` (unit) | 157 suites, 2988 tests | 158 suites, 3057 tests (+69: shared-module service, constants, purge loop, two verification narrowing cases) |
| `npm run test:integration` (49 suites after, 48 before) | 46 suites passed, 2 failed (the environment suites above); 1532 passed, 7 failed, 2 skipped | 47 suites passed, 2 failed (same two); 1554 passed, 7 failed (same seven), 2 skipped |
| golden statement test (`goldenIntentStatements`, `tests/integration/golden/verification-intent-statements.json`) | recorded and passing on the unchanged code | passes unchanged after the move |
| `scripts/curl-test-verification.sh` | not run (needs MinIO, a real Identity database and an internal-users shim; none available here) | not run: **must be run where that stack exists before slice 2 merges** |

Review gate (spec section 2, step 3): `git diff -U0 tests/` shows no removed or changed `expect(...)` line in the repointed files; the only new assertions are additive tests.
