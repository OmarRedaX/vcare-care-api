# schedules - /develop checkpoint (2026-10-09)

Branch feature/schedules. Nothing committed. tasks.md (docs/schedules/tasks.md) is the live truth.

## Done
- Contract C1-C6 applied; pkg/slots + IsCalendarDate; 3 migrations; constants/enums/errors/types/rules; entities; DTOs; repos; SchedulesService + no-op ports + owner resolver; doctors wiring (isBookable, 5 queries); policies; controller; routes; mount; tokens + bootstrap; INDEX + service-card.
- typecheck + lint clean; unit 75 suites pass; integration run against a throwaway local PG (:5434) passed except 2 environment items (MinIO storage-adapter, flaky guarded-DROP-ROLE under load; passes alone).

## /write-tests done (2026-10-09)
Unit: tests/unit/pkg/slots/*, app/schedules/* (8 files incl. service), contract/schedules-contract, lib/validation/date-decorator. Integration: tests/integration/schedules.test.ts (116) + additions to boot, db-roles, doctors (isBookable flip). Green: npm test 1541; targeted integration 226; full integration only MinIO storage-adapter + known migrations flake fail (migrations passes alone). 

## /manual-qa done (2026-10-09)
220 pass / 0 fail (docs/schedules/manual-qa.md; scripts/curl-test-schedules.sh + scripts/schedules-qa-fake-identity.mjs). Throwaway DB care_qa_test (dropped), Redis db 13, no MinIO needed. No product bugs. Unverified: 409 ScheduleConflictsUnconfirmed (default impact provider is a no-op), in-flight idempotency 409, Redis-down fallback limiter.

## /update-docs done (2026-10-09)
Docs reconciled: schedules spec v1.1.0 (section 14 as-built notes), doctors spec v1.3.0, architecture shards data-model/api/rbac/scheduling-slots/overview, INDEX, service-card, quickstart, tasks. Contract unchanged. 

## /develop --fix-review done (2026-10-09)
C1 (year 0000 -> 400, not 500) and C3 (zone-validity memo + localInstant fast path + arithmetic midnight; 5 ms budget moved to opt-in `npm run test:bench`: 3.07-3.30 ms; npm test keeps deterministic guards, 4/4 green) fixed; review findings flipped to RESOLVED. unit 1557, integration (schedules, doctors, boot, db-roles) 227 green; typecheck and lint clean. Not committed.

## NEXT STEP
/review-code schedules (re-review: verify the two fixes and delete the review file if clean).
