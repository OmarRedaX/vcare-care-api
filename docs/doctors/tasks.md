---
title: doctors — Development tasks
owner: care-team
service: care-service
module: doctors
status: complete
diataxis: how-to
last_verified: 2026-10-07
tags: [tasks, doctors]
related: [doctors-spec, doctors-manual-qa, doctors-spec-conformance, api]
contracts: [contracts/openapi.yaml]
---

# Doctors development tasks

- [x] **Step 0:** Apply contract changes C1–C3.
- [x] **Step 0a:** Add luxon, timezone validation, currency environment setting, logger redaction, and specialties batch lookup.
- [x] **Step 1:** Add raw SQL migrations for doctor profiles, languages, and specialties.
- [x] **Step 2:** Define module constants, enums, errors, and types.
- [x] **Step 3:** Add the doctor profile entity.
- [x] **Step 4:** Add request DTOs and validation.
- [x] **Step 5:** Add response DTOs.
- [x] **Step 6:** Add repository functions.
- [x] **Step 7:** Add the service with transactional audit and DI registration.
- [x] **Step 8:** Add local suspension check and policies.
- [x] **Step 9:** Add controller and DI registration.
- [x] **Step 10:** Add guarded, limited, authorized routes.
- [x] **Step 11:** Mount the doctors router in public routes.
- [x] **Step 12:** Add unit, integration, RBAC, and contract conformance coverage; typecheck and tests green, with no code-review findings.

- [x] **Step 13:** Manual QA of all four live doctors routes (37 HTTP cases plus one replay-data comparison; 38 pass / 0 fail); see [manual-qa.md](./manual-qa.md).
- [x] **Step 14:** Reconcile the spec, architecture shards, index and service card with the as-built doctors slice.
