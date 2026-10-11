---
title: patients — Tasks
owner: care-team
service: care-service
module: patients
status: implemented
last_verified: 2026-10-11
tags: [tasks, patients]
related: [patients-spec, patients-brainstorm, patients-manual-qa]
---

# patients — Tasks

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) no change: operations `getMyPatientProfile` / `upsertMyPatientProfile` already match the spec (drift check 2026-10-11)
- [x] (migration) `20261011120000_create_patient_profiles` — table, checks, partial unique index, grants
- [x] (enums-errors-types) `constants.ts`, `enums.ts`, `errors.ts`, `types.ts`
- [x] (entity) `PatientProfile`
- [x] (request-dto) `PatientProfileUpdateDto`
- [x] (response-dto) `PatientProfileResponseDto` (viewer-aware)
- [x] (repository) `patient-profiles.repo.ts`
- [x] (service) `PatientsService` + DI tokens + container registration + `gender` redaction key
- [x] (policies) `policies.ts`
- [x] (controller) `PatientsController`
- [x] (routes) `routes.ts`
- [x] (mount) `src/routes.ts`
- [x] (tests) unit (service, DTO, response DTO, repo mapping, policies/contract, `IsTextList`) + integration `tests/integration/patients.test.ts` (RBAC, create/update/clear, concurrency, audit, no-store, rate limits, logs, schema, EXPLAIN); `gender` redaction row done by develop
- [x] (manual-qa) 2026-10-11: 135 pass / 0 fail after the no-store fix, `scripts/curl-test-patients.sh`, [manual-qa.md](./manual-qa.md)
- [x] (docs) service-card / INDEX / data-model / api / rbac / overview / quickstart; spec v1.1.0 as-built notes (2026-10-11)

## Notes
- Added `src/lib/validation/text-list-decorator.ts` (`IsTextList`): domain-free per-item string-list rules, kept in `lib/validation` per the generic-helpers rule.
- Verified: typecheck, lint, 112 unit suites green; integration migrations/boot/rbac/db-roles/logs green; ad-hoc smoke of GET/PATCH flow (deleted).
