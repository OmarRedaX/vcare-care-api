---
title: audit — Tasks
owner: care-team
service: care-service
module: audit
status: in-progress
last_verified: 2026-10-09
tags: [tasks, audit, audit-logs, keyset, indexes]
related: [audit-spec, audit-brainstorm]
---

# audit — Tasks

Spec: [spec.md](./spec.md) v1.0.0. Build-order tags in parentheses.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) C1-C3 of spec 11.1 on `listAuditLogs` in `contracts/openapi.yaml`
- [x] (migration) `20261009120000_add_audit_logs_read_indexes` (three commented indexes, real down)
- [x] (lib) `pkg/utils/iso-datetime.ts` + `IsIsoDateTimeWithOffset` decorator
- [x] (enums-errors-types) audit `constants.ts`, `types.ts` (no new error codes)
- [x] (entity) `AuditLog`
- [x] (request-dto) `ListAuditLogsQueryDto`
- [x] (response-dto) `AuditLogResponseDto`
- [x] (repository) `listAuditLogsQuery`, `listAuditLogs`
- [x] (service) `AuditService` + pure `window.ts` + DI tokens (`AuditService`, `AuditController`, `AuditClock`)
- [x] (policies) `policies.ts`
- [x] (controller) `AuditController`
- [x] (routes) `routes.ts` (noStore, guard, authorize, rate limit)
- [x] (mount) `src/routes.ts`
- [x] (tests) <- /write-tests (spec 9): written and green; the two product findings it pinned (all cross-field details at once; validly signed cursor with an impossible `t` answers 400) are fixed
- [ ] (manual-qa) <- /manual-qa
- [x] (docs) service card, INDEX, checkpoint; `architecture/*` deltas (data-model indexes, api row) left to /update-docs
