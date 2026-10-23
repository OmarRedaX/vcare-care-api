# Resume checkpoint — availability (updated 2026-10-23)

## State
- Design merged to main (care PR #46, hub PR #26): ADRs 0024-0026, docs/architecture/availability.md.
- Branch `feature/availability`: brainstorm (7b320b9), spec v0.1.0 (0c545ab), then **slice 1 (slots + listeners) committed, pushed, care PR opened (not merged)**.
- Hub branch `chore/sync-care-availability-slice1`: card + contract re-synced for slice 1, hub PR opened (not merged).
- Slice 1 gate met (2026-10-23): typecheck + eslint clean; `npm test` 180 suites / 3367 tests; availability integration 3 suites / 28 tests; `npm run test:bench` passes (14 days / 150 consultations: miss p95 ~19 ms, hit p95 ~11 ms); manual QA Redis up 14/14, Redis down 8/8.
- Full integration run in batches: 58 files, 56 pass. Only failures: db-roles (4 password cases) and storage-adapter (3 MinIO cases), both environment-only. consultations-rules, record-attachments-rules and sessions-rbac failed once under batch load and pass alone.
- If the card or contract changes again: `cd ../vcare-hub && bash scripts/sync-from-spoke.sh care-service ../vcare-care-api`.

## Env
Postgres 18 on 5499 (trust auth; data dir C:/Users/power tech/AppData/Local/Temp/care-pg/data; start with `pg_ctl -o "-p 5499"`, backgrounded: pg_ctl hangs the foreground shell).
Redis: Memurai service is Stopped and needs admin. Start a user process: `"/c/Program Files/Memurai/memurai.exe" --port 6380 --save "" --appendonly no` (background).
Always: MIGRATION_DATABASE_URL=postgres://care:care@127.0.0.1:5499/care_test DATABASE_URL=postgres://care_app:care_app@127.0.0.1:5499/care_test REDIS_URL=redis://127.0.0.1:6380/14. Use `npm test` / `npm run test:integration` (never bare npx jest, never port 5432).
Memory is tight: run integration suites in batches of about 10 files, never two jest processes at once, no QA servers at the same time.
Codex (`codex:codex-rescue`) was denied by the auto-mode classifier in this session ("Create Unsafe Agents" for a `task --write` run); do the work inline unless the user adds a permission rule.

## Open follow-up (not blocking)
`scripts/curl-test-consultations.sh` may hit the same pending-outbox delete trigger (`trg_notification_outbox_delete_sent_only`) that the availability script hit during cleanup. Not checked.

## ▶ NEXT STEP
Slice 2 as its own `/develop availability` pass (do not start until the slice 1 PRs are reviewed): rank index, free-map, `availability-refresh` and `availability-sweep` worker loops, search (`GET /doctors`), `getDoctor` profile preview, candidate-index migration, Redis for the worker. Contract edits C4-C8 apply then. Slice 3 (name index) follows as another pass.
