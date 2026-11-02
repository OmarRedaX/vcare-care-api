# Resume checkpoint — help-articles (updated 2026-10-29)

## State
- availability is complete and merged (care #46..#51, hub #30 merged or mergeable; nothing left there).
- **help-articles** is the last unbuilt module. Open PRs (user merges; do not merge them): care **#53** (system design, ADRs 0027/0028, shard `docs/architecture/help-articles.md`), care **#54** (brainstorm brief), hub **#31** (capacity row, data-ownership, landscape, TODO).
- Working branch **`feature/help-articles`**, cut from `origin/main` with `docs/help-articles-design` and `docs/help-articles-brainstorm` merged in (neither was on main). PR targets `main`; it shrinks once #53/#54 merge. Never stack on a docs branch.
- Decisions fixed (do not re-ask): body = Markdown verbatim, 50,000-char cap, no new dependency; in-place edits, no revision table; `published_at` set on first publish and kept; start empty (no seed); two audiences (duplicate rows); no `GET /internal/help-articles` this iteration.
- After the module merges: `cd ../vcare-hub && bash scripts/sync-from-spoke.sh care-service ../vcare-care-api`, hub PR, and flip `help-articles` to built in the `CLAUDE.md` Status block.

## Env
Postgres 18 on 5499 (trust auth; data dir C:/Users/power tech/AppData/Local/Temp/care-pg/data; start with `pg_ctl -o "-p 5499"`, backgrounded: pg_ctl hangs the foreground shell).
Redis: Memurai service is Stopped and needs admin. Start a user process: `"/c/Program Files/Memurai/memurai.exe" --port 6380 --save "" --appendonly no` (background).
Always: MIGRATION_DATABASE_URL=postgres://care:care@127.0.0.1:5499/care_test DATABASE_URL=postgres://care_app:care_app@127.0.0.1:5499/care_test REDIS_URL=redis://127.0.0.1:6380/14. Use `npm test` / `npm run test:integration` (never bare npx jest, never port 5432).
Memory is tight: run integration suites in batches of about 10 files, never two jest processes at once, no QA servers at the same time.
No `gh` CLI: use the GitHub MCP tools. Hub repo is `OmarRedaX/Vcare`; care repo is `OmarRedaX/vcare-care-api`.

## Workflow progress (help-articles)
- [x] system-design, brainstorm
- [x] /construct-spec help-articles (docs/help-articles/spec.md v0.1.0, ready)
- [x] /develop (commits 64dadad..327c606; typecheck+lint clean; migration applied to care_test)
- [x] /write-tests (commits 4b05ff1..7632a79; npm test 209 suites/3790 tests verified; help-articles integration 5 suites/254 tests)
- [ ] /manual-qa, /review-code, /update-docs
- [ ] PR to main, hub sync, CLAUDE.md Status

## ▶ NEXT STEP
help-articles is built, tested, QA'd, reviewed clean, docs reconciled. Care PR **#55** (feature/help-articles -> main) is OPEN: user merges (also user merges care #53, #54 and hub #31; #55 contains their commits).
Gate: typecheck/lint clean; npm test 209 suites/3792; integration 70 files, only the 7 known env failures (db-roles 4, storage-adapter 3).
After the user merges #55:
1. `git checkout main && git pull`; `cd ../vcare-hub && git checkout main && git pull && git checkout -b chore/sync-care-help-articles && bash scripts/sync-from-spoke.sh care-service ../vcare-care-api`; commit, push, open hub PR (repo OmarRedaX/Vcare) against main; do not merge.
2. Edit `CLAUDE.md` Status block: help-articles becomes built (no longer 'the only unbuilt module'); open a small care PR.
OWNER DECISION pending: doctor discovery routes Cache-Control (lost accidental no-store in 50f6e6e).
