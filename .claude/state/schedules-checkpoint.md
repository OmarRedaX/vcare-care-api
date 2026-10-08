# schedules - /develop checkpoint (2026-10-09)

Branch feature/schedules. Nothing committed. tasks.md (docs/schedules/tasks.md) is the live truth.

## Done
- Contract C1-C6 applied; pkg/slots + IsCalendarDate; 3 migrations; constants/enums/errors/types/rules; entities; DTOs; repos; SchedulesService + no-op ports + owner resolver; doctors wiring (isBookable, 5 queries); policies; controller; routes; mount; tokens + bootstrap; INDEX + service-card.
- typecheck + lint clean; unit 75 suites pass; integration run against a throwaway local PG (:5434) passed except 2 environment items (MinIO storage-adapter, flaky guarded-DROP-ROLE under load; passes alone).

## NEXT STEP
/write-tests schedules (spec section 9), then /manual-qa schedules, then /update-docs schedules (+ doctors as-built delta), then /review-code schedules.
Known: contracts/openapi.yaml line ~1384 has a pre-existing invalid-YAML plain scalar (tests parse by string).
