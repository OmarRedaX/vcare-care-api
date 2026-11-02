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
Latent issues (2026-11-02): fixed and PR'd - #13 (care #59), #12 (care #60), #17 (care #61), #16 (care #58). Already fixed in code, issue still open, user closes: #6, #10, #11, #15 (access module 2026-10-02), #14 (R-D4, no Idempotency-Key on record routes).
Remaining before MVP: close the stale issues above after merging; check and close #27 and #38; hub TODO: bucket IaC + web CSP; the 7 environment test failures are NOT code bugs - db-roles (4): every one fails on its last assertion 'wrong password -> 28P01', because the local test cluster uses trust auth; with scram-sha-256 on 127.0.0.1 and passwords set for care and care_app, db-roles passes 22/22 (verified 2026-11-02, trust restored afterwards); storage-adapter (3): need MinIO on :9003 via `docker compose -f docker-compose.test.yml up minio minio-setup`, Docker Desktop is not running here - run it to close the last 3. Local test Postgres (5499) and Redis (6380) were started by hand.
Not in MVP: Phase-2 AI service (`GET /internal/help-articles`, `help:read`), events/RabbitMQ, admin MFA, PII erasure, follow-up booking.
