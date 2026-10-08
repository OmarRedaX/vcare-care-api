# schedules — session checkpoint (2026-10-08)

Branch `feature/schedules` from `main` @ 9c8cd31 (verification merged, PR #28). Nothing committed yet.
Care PR #29 (contract: reinstate + audit range) and Identity PR #12 are still OPEN, not merged (checked via GitHub MCP; `gh` is not installed).
Hub branch docs/sync-identity-auth-race-fixes pushed, no PR yet.

## ✅ Done
`/brainstorm schedules` complete: `docs/schedules/brainstorm.md` written + INDEX row added (uncommitted).
Decisions: (1) conflict flow behind `ScheduleImpactProvider` port, empty default, real impl in `consultations`;
(2) `pkg/slots` open-interval resolution built here, slicing/busy in `availability`;
(3) wire `isBookable` active-type term into doctors now (query count 4→5);
(4) type currency must equal profile currency and be in ALLOWED_CURRENCIES; profile fee and type price independent;
(5) `ScheduleChangeListener` post-commit no-op port for cache invalidation (availability binds it).

## ▶ NEXT STEP
1. Settle brainstorm Open questions 1 (delete custom_hours exception can strand bookings → contract edit), 3, 4, 5 with the user (or at /construct-spec).
2. Commit brainstorm on `feature/schedules`, then `/construct-spec schedules`.
3. Still queued: admin-doctors module (suspend Case 3 + reinstate Case 4) and audit module — only after Identity #12 is merged.
4. Hub TODO.md still open: glossary entries (care-worker, notification outbox, Case 4/5), Identity service-auth notes for landscape.md + deployment.md (/system-design step).
5. Identity dev servers hold esbuild.exe → `npm ci` in vcare-identity-api fails until stopped.
