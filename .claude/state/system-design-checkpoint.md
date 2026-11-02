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
All planned Care modules are built and merged (care #53, #54, #55 merged 2026-11-02; hub #31 closed).
Done: hub sync branch `chore/sync-care-help-articles` pushed (commit 09bda57) - hub PR open for the user to merge; CLAUDE.md Status flipped (this branch `docs/claude-md-help-articles-built`).
Open PRs for the user to merge (2026-11-02): care #56 (this), #57 (discovery Cache-Control = private, no-cache, decided), #58 (#16 boot warn + docs); hub #32 (care sync), #33 (deployment: TRUST_PROXY_HOPS=2 + ALB prefix list).
Remaining before MVP: issue #14 is already resolved (R-D4: no Idempotency-Key on record routes) - close it; close #16 after #58 merges; check and close stale #27 and #38; latent #6, #10-#13, #15, #17 still open; hub TODO: bucket IaC + web CSP; the 7 known env integration failures (db-roles 4, storage-adapter 3) need a clean environment. Local test Postgres (5499) and Redis (6380) were started by hand this session.
Not in MVP: Phase-2 AI service (`GET /internal/help-articles`, `help:read`), events/RabbitMQ, admin MFA, PII erasure, follow-up booking.
