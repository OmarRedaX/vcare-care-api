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

Source: [spec.md](./spec.md) (v0.1.0, section 13 task order). Branch `feature/record-attachments`. **Slice 1 (E0 + E1, the behaviour-preserving extraction of `upload-intents` out of `verification`) is worked first and lands before any attachment migration, route or contract edit** (spec section 2, step 5). Slice 2 steps 0-7 are built (dispatch 2); steps 8-9 (dedicated test suites, manual QA, final docs) remain.

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

## Slice 2 — record-attachments proper (steps 0-7 worked in dispatch 2; steps 8-9 remain)
- [x] (contract) 0: contract edits C1-C6 in `contracts/openapi.yaml` + the CLAUDE.md owner edit of C5 (`AttachmentLimitReached` row and Domain-rules sentence)
- [x] (lib) 1: `attachmentDescription` redaction key + test row; `AttachmentLimitReached` in `lib/error/types.ts`; the no-store row (`tests/integration/no-store.test.ts`; `/api/records` already in `NO_STORE_PREFIXES`)
- [x] (migration) 2: `20261018120000_create_record_attachments` (table, constraints, partial index, `forbid_attachment_delete_after_lock` trigger, column-level grants)
- [x] (migration) 2: `20261018120100_comment_upload_intents_description` + migration and `db-roles` tests
- [x] (enums-errors-types) 3: `record-attachments` `constants.ts` / `enums.ts` / `errors.ts` / `types.ts`; `records` `RecordLockRow` and `RecordWithAmendments` / `RecordUpdateResult` additions
- [x] (entity) 4: `RecordAttachment` entity
- [x] (request-dto) 4: `RecordAttachmentIntentDto`
- [x] (response-dto) 4: `RecordAttachmentResponseDto` (viewer-aware, admin throws)
- [x] (repository) 5: `record-attachments.repo.ts`, `findLockRowForNoKeyUpdate`
- [x] (service) 6: `RecordLinksService.lockForNoKeyUpdate`, `RecordAttachmentLinksService`, `RecordAttachmentsService`; DI tokens and `bootstrap.ts` (links services before the records services); the `records` plug-ins (queries, update, DTO, controller) and their test updates
- [x] (policies) 7: `policies.ts` (`record_attachment_writer`; export `recordReaderRule` from `records/policies.ts`)
- [x] (controller) 7: `RecordAttachmentsController`
- [x] (routes) 7: `routes.ts` + `rate-limits.ts`
- [x] (mount) 7: mount after the records router in `src/routes.ts`
- [x] (tests) 8: unit, integration, RBAC, contract, concurrency, lock boundary, privacy, EXPLAIN, migrations (spec section 10)
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

## Verification record (slice 2, steps 0-7)
Same isolated environment as slice 1. Pre-existing environment failures unchanged: 4 password-rejection cases of `db-roles.test.ts` and the 3 MinIO tests of `storage-adapter.test.ts`.

| Gate | Before (389de6f) | After steps 0-7 |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npx eslint src tests` | clean | clean |
| `npm test` (unit) | 158 suites, 3057 tests | 158 suites, 3069 tests |
| `npm run test:integration` | 47 of 49 suites passed; 1554 passed, 7 failed, 2 skipped | 46 of 49 passed in the full run (the 2 environment suites plus `sessions.test.ts`, whose 2 failures were a TRUNCATE/pool timeout in one full run and passed solo: 60/60); 1562 passed, 9 failed (7 environment + the 2 flaky), 2 skipped |
| contract file | n/a | parses, every `$ref` resolves, no duplicate `operationId` |

Existing integration tests edited because the schema or the record views changed (no assertion weakened): `migrations.test.ts` and `records-schema.test.ts` step the two new migrations down before `medical_records` and up after it; `records-explain.test.ts` statement order gains `attachments`.

## Verification record (step 8, tests)
Same isolated environment. Pre-existing environment failures unchanged: 4 password-rejection cases of `db-roles.test.ts` and the 3 MinIO tests of `storage-adapter.test.ts`.

| Gate | Result |
|---|---|
| `npm run typecheck` / `npx eslint src tests` | clean / clean |
| `npm test` (unit) | 167 suites, 3296 tests, all pass (was 158 / 3069) |
| `npm run test:integration` | 55 suites: 53 passed, 2 failed (the environment suites); 1745 tests: 1736 passed, 7 failed (the known 7), 2 skipped |

New suites: unit `tests/unit/app/record-attachments/*` (service, policies, links service, repo, DTO, controller, rate limits, logging) and `tests/unit/contract/record-attachments-contract.test.ts`; integration `record-attachments{,-rbac,-rules,-audit,-privacy,-links}.test.ts`, helper `tests/helpers/record-attachments-fixtures.ts`; extended `records-explain`, `db-roles`, `no-store`.
Note for `/update-docs`: `findLive(id, recordId)` is planned on `idx_record_attachments_medical_record_id` (both columns are equality predicates), not the primary key as spec 3.3 says; still a one-row index access, no Seq Scan.
