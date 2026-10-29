# Resume checkpoint — availability (updated 2026-10-29)

## State
- **availability is complete and merged to main** (updated 2026-10-29): design (care PR #46, hub #26), slice 1 (#47), slice 2 (#48), slice 3 (#51, merge commit ef5e925), curl-script fixes (#49). Review files are all removed (clean module); gate numbers are in `docs/availability/tasks.md`.
- Hub: card and contract for slice 3 are in hub PR **#30** (`chore/sync-care-availability-slice3`, base main), verified against care main (re-sync changes only `synced_at`). Merge it; nothing else to sync.
- Built modules: everything except `help-articles`.
- Platform delta still open for `/system-design`: Care's Postgres query-rate headline (about 400 qps in hub `architecture/capacity.md`) is understated by about 100 qps because a search page costs 6 queries (derivation in `docs/architecture/capacity.md` section 10).

## Env
Postgres 18 on 5499 (trust auth; data dir C:/Users/power tech/AppData/Local/Temp/care-pg/data; start with `pg_ctl -o "-p 5499"`, backgrounded: pg_ctl hangs the foreground shell).
Redis: Memurai service is Stopped and needs admin. Start a user process: `"/c/Program Files/Memurai/memurai.exe" --port 6380 --save "" --appendonly no` (background).
Always: MIGRATION_DATABASE_URL=postgres://care:care@127.0.0.1:5499/care_test DATABASE_URL=postgres://care_app:care_app@127.0.0.1:5499/care_test REDIS_URL=redis://127.0.0.1:6380/14. Use `npm test` / `npm run test:integration` (never bare npx jest, never port 5432).
Memory is tight: run integration suites in batches of about 10 files, never two jest processes at once, no QA servers at the same time.
Codex (`codex:codex-rescue`) was denied by the auto-mode classifier in this session ("Create Unsafe Agents" for a `task --write` run); do the work inline unless the user adds a permission rule.

## ▶ NEXT STEP
1. Merge hub PR #30.
2. `/system-design` for the query-rate headline restatement (hub `capacity.md`), then for `help-articles` (Phase-2 RAG corpus boundary, admin management, public read).
3. Then `/brainstorm help-articles` and the rest of the workflow (`/construct-spec` … `/update-docs`).
