---
title: foundation — Manual QA (CURL)
owner: care-team
service: care-service
module: foundation
status: passed
diataxis: how-to
last_verified: 2026-09-28
tags: [manual-qa, curl, foundation, health, request-id, error-envelope, readiness, redis, postgres, logging, cors]
related: [foundation-spec, foundation-tasks, foundation-brainstorm, adr-0006-health-split-redis-tier-2, adr-0007-log-derived-metrics, adr-0016-foundation-runtime-dependencies, quickstart, runbook]
contracts: [contracts/openapi.yaml]
---

# foundation — Manual QA (CURL)

_Run: 2026-09-26 • Server: http://localhost:3001 (public) / http://localhost:3101 (internal) • Result: 50 pass / 1 fail / 1 known product bug reproduced (52 scenarios)_

_Re-run: 2026-09-28 after `/develop foundation --fix-review` • Result: script 97 pass / 0 fail / 0 known (read-only),
125 pass / 0 fail / 0 known (`RUN_INFRA_CASES=1`) • see [Re-run 2026-09-28](#re-run-2026-09-28) at the end. The
2026-09-26 results below are kept as recorded._

_(52 scenarios below. The script asserts each scenario's status, body, and headers separately:
**94 pass / 3 fail** without infra cases, **121 pass / 3 fail / 1 known** with `RUN_INFRA_CASES=1`. All 3 failing
assertions belong to the one finding, case 23.)_

The foundation has **no business endpoints**. The only routes are the four health probes (spec §3.1; contract
`getPublicLiveness`, `getPublicReadiness`, `getInternalLiveness`, `getInternalReadiness`). This run also checks the
cross-cutting behaviour every later module inherits: `X-Request-Id`, the error envelope, body-parser mapping,
listener isolation, helmet headers, CORS gating, structured logging, and the readiness decision table.
No route requires a bearer token yet (`lib/auth` and `lib/rbac` are out of scope, spec §10), so there are no
patient, doctor, admin, or service-token cases. Every "Role" below is `public`.

## How this run was set up

The full dev stack runs in containers built from the current code (`docker compose up -d` in the repo root):

| Component | Where | Notes |
|---|---|---|
| `care-api` | `localhost:3001` (public), `127.0.0.1:3101` (internal) | `NODE_ENV=production`, `LOG_LEVEL=info`, `CORS_ORIGINS` unset, so **CORS is disabled** (hub ADR 0005) |
| `care-worker` | no ports | empty loop list; `worker_heartbeat` every 30 s |
| `postgres` | host `5433` | migration `20260915000000_create_extension_btree_gist` applied by `migrate` |
| `redis` | host `6380` | |

Preflight: `GET /api/health/live` → 200 `{"status":"ok"}`, and both readiness probes → 200 `ok`/`up`/`up`.
The separate test stack (`docker-compose.test.yml`, 5434/6381) was not touched.

```bash
./scripts/curl-test-foundation.sh                     # read-only cases
RUN_INFRA_CASES=1 ./scripts/curl-test-foundation.sh   # + stop/start Redis and Postgres (EXIT trap restarts both)
EXPECT_CORS=1 ./scripts/curl-test-foundation.sh       # only against a host `npm run dev` (NODE_ENV=development)
```

Repeatable form of every case: [`scripts/curl-test-foundation.sh`](../../scripts/curl-test-foundation.sh).
Every marker sent (bearer value, query string, request bodies) is synthetic. No token, secret, or PII is recorded here.

## Cases

| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | GET | /api/health/live | public | happy path | 200 `{"status":"ok"}`, `Cache-Control: no-store`, `application/json`, `X-Request-Id` = sent id | exactly that | pass |
| 2 | GET | /api/health/ready | public | both dependencies up | 200 `{"status":"ok","checks":{"database":"up","redis":"up"}}` + headers | exactly that | pass |
| 3 | GET | /internal/health/live | public (internal listener) | happy path | 200 `{"status":"ok"}`, `no-store` | exactly that | pass |
| 4 | GET | /internal/health/ready | public (internal listener) | both dependencies up | 200 `ok`/`up`/`up`, `no-store`, `application/json` | exactly that | pass |
| 5 | GET | /api/health/live?probe=1 | public | unknown query parameter ignored (spec §3.1) | 200 `{"status":"ok"}` | 200 `ok` | pass |
| 6 | GET | /api/health/live | public | valid lower-case UUID `X-Request-Id` | echoed unchanged | echoed | pass |
| 7 | GET | /api/health/live | public | upper-case UUID | adopted, lower-cased (spec §1.4) | lower-cased echo | pass |
| 8 | GET | /api/health/live | public | v1 UUID (any version accepted) | echoed | echoed | pass |
| 9 | GET | /api/health/live | public | malformed id `not-a-uuid` | replaced by a fresh UUID | fresh UUID | pass |
| 10 | GET | /api/health/live | public | empty `X-Request-Id` header | fresh UUID | fresh UUID | pass |
| 11 | GET | /api/health/live | public | header absent | fresh UUID | fresh UUID | pass |
| 12 | GET | /api/health/live | public | header sent twice (Node joins as `a, b`) | one fresh UUID, neither sent value | one fresh UUID | pass |
| 13 | GET | /api/nope | public | request id on an error response | 404; header and `error.requestId` = sent id | both match | pass |
| 14 | GET | /internal/health/ready | public (internal listener) | request id on the internal listener | echoed | echoed | pass |
| 15 | GET | /internal/health/live, /internal/health/ready | public listener | listener isolation (F11) | 404 `NotFound` envelope | 404 `NotFound` | pass |
| 16 | GET | /api/health/live, /api/health/ready | internal listener | listener isolation (F11) | 404 `NotFound` envelope | 404 `NotFound` | pass |
| 17 | — | port 3101 | — | internal listener published on host loopback only (spec §7) | `127.0.0.1:3101` | `127.0.0.1:3101` | pass |
| 18 | GET | /api/definitely/not/here | public | unknown public path | 404, exact envelope `{success:false,error:{code:"NotFound",message:"Resource not found",details:[],requestId}}`, `application/json` | exactly that | pass |
| 19 | GET | /internal/definitely/not/here | internal | unknown internal path | 404 exact envelope | exactly that | pass |
| 20 | GET | / , /api/health , /api/health/deep | public | root, bare health prefix, unknown probe | 404 envelope | 404 envelope | pass |
| 21 | POST | /api/health/live | public | wrong method (valid JSON body) | 404 `NotFound` envelope (spec §3.4.3, no 405) | 404 envelope | pass |
| 22 | PUT / DELETE | /api/health/ready, /internal/health/live | public / internal | wrong method | 404 | 404 | pass |
| 23 | OPTIONS | /api/health/live, /internal/health/ready | public / internal | wrong method (`OPTIONS`, no CORS in production) | 404 `NotFound` envelope (spec §3.4.3: "Unmatched methods on a known path are also 404") | **200 `text/plain` body `GET, HEAD`, `Allow: GET, HEAD`**, no envelope | **fail** |
| 24 | POST | /api/nope | public | malformed JSON (F5) | 400 `ValidationFailed`, `details:[{field:"body",issue:"must be valid JSON"}]` | exactly that | pass |
| 25 | POST | /internal/nope | internal | malformed JSON on the internal listener | 400, same envelope | exactly that | pass |
| 26 | POST | /api/nope | public | JSON primitive `"text"` (strict parser) | 400 `must be valid JSON` | exactly that | pass |
| 27 | POST | /api/nope | public | body 110 KB > 100kb limit (F5) | 400 `ValidationFailed`, `issue:"must not exceed 100kb"` | exactly that | pass |
| 28 | POST | /api/nope | public | unsupported charset | 400 `ValidationFailed`, `issue:"could not be read"` | exactly that | pass |
| 29 | POST | /api/nope | public | unsupported `Content-Encoding: compress` | 400 `could not be read` | exactly that | pass |
| 30 | POST | /api/nope | public | `text/plain` body is not parsed as JSON | 404 (routing, no parse error) | 404 | pass |
| 31 | GET | /api/health/live, /internal/health/live | public | helmet headers on both listeners | `nosniff`, `no-referrer`, `SAMEORIGIN`, COOP/CORP `same-origin`, CSP and HSTS present | all present | pass |
| 32 | GET | /api/health/live, /api/nope | public | `X-Powered-By` disabled (spec §7) | absent on success and error | absent | pass |
| 33 | GET | /api/health/live | public | `Origin: http://localhost:5173` in production mode (F22) | no CORS headers | none | pass |
| 34 | GET | /api/health/live | public | foreign origin | no CORS headers | none | pass |
| 35 | OPTIONS | /api/health/live | public | preflight in production mode | no `Access-Control-Allow-*` headers | none (status covered by case 23) | pass |
| 36 | GET | /internal/health/live | internal | internal listener never mounts CORS (F22) | no CORS headers | none | pass |
| 37 | — | logs | — | every `care-api` line of the read-only run parses as one JSON object | 0 non-JSON lines | 0 | pass |
| 38 | — | logs | — | every `request_completed` carries `requestId` | 0 missing | 0 | pass |
| 39 | GET | /api/nope | public | 404 logged once: `request_completed`, `route:"unmatched"`, `status:404`, `code:"NotFound"`, `level:"info"`, sent requestId | 1 line | 1 line | pass |
| 40 | GET / POST | /api/nope | public | no `Authorization` value, query string, or body fixture (`SYNTHETIC-COMPLAINT-7731`, `synthetic.patient@example.test`) in logs (F7) | 0 occurrences | 0 | pass |
| 41 | GET | /api/health/live | public | health 200 not logged at `LOG_LEVEL=info` (logged at `debug`, spec §3.4.4) | no line | no line | pass |
| 42 | GET | /api/health/ready + /internal/health/ready | public / internal | **Redis stopped** (F10, ADR 0006) | 200 `{"status":"degraded","checks":{"database":"up","redis":"down"}}`, `no-store` | exactly that, 1 s after stop | pass |
| 43 | GET | /api/health/live + /internal/health/live | public / internal | liveness ignores Redis (F9) | 200 `ok` | 200 `ok` | pass |
| 44 | GET | /api/nope | public | envelope still served with Redis down | 404 envelope | 404 envelope | pass |
| 45 | GET | /api/health/ready + /internal/health/ready | public / internal | Redis restarted | 200 `ok`/`up`/`up` | recovered after about 3 s | pass |
| 46 | — | logs | — | Redis window: JSON only; exactly one `redis_unavailable` (warn) and one `redis_recovered` (info), one line per transition (spec §3.4.9) | 1 + 1 | 1 + 1 | pass |
| 47 | GET | /api/health/ready + /internal/health/ready | public / internal | **Postgres stopped** (F10) | 503 `{"status":"down","checks":{"database":"down","redis":"up"}}`, `no-store`, `X-Request-Id` echoed | exactly that, 1 s after stop, about 500 ms (probe bound) | pass |
| 48 | GET | /api/health/live + /internal/health/live | public / internal | liveness never 503 on a dependency outage (F9) | 200 `ok` | 200 `ok` | pass |
| 49 | GET | /api/nope | public | envelope still served with Postgres down | 404 exact envelope (no 500) | exactly that | pass |
| 50 | — | logs | — | 503 readiness logged as `request_completed`, `level:"error"`, `route:"/api/health/ready"`, `status:503` (spec §3.4.4) | 1 line | 1 line | pass |
| 51 | — | logs | — | Postgres window: no raw console output (known bug #2) | 0 non-JSON lines | **15–18 raw lines per outage** (see notes) | known bug (pinned `test.failing`) |
| 52 | GET | /api/health/ready + /internal/health/ready | public / internal | Postgres restarted | 200 `ok`/`up`/`up` | recovered after about 2 s | pass |

Readiness decision table (spec §3.1) exercised: `up/up → 200 ok`, `up/down → 200 degraded`, and
`down/up → 503 down`. The shutdown row (`503` while draining) is covered by the tests (see "Not exercised").

## Failures / notes

- **`OPTIONS` on a known path (case 23): expected 404 `NotFound` envelope, got 200 `text/plain` `GET, HEAD`.**
  Violates spec §3.4.3 ("Unmatched methods on a known path are also 404 (no 405 code exists)") and §3.1 ("any
  unmatched path → 404 error envelope"). Diagnosis: Express 5's router answers `OPTIONS` itself when a path
  matches a route but no `OPTIONS` handler is registered (`Allow` header plus a plain-text body), so `notFound` and
  `errorHandler` never run. `src/app/health/routes.ts` registers only `GET`, and neither `src/app.ts` nor
  `src/internal-app.ts` intercepts `OPTIONS`. The response still carries `X-Request-Id` and helmet headers and
  exposes nothing sensitive, so severity is **low**. It is a real deviation, though, and every later router
  inherits it: each would answer `OPTIONS` with 200 `text/plain` instead of the one envelope. In development, a
  CORS preflight from a **disallowed** origin falls through to the same 200 (a browser still blocks it, because
  there is no `Access-Control-Allow-Origin`). Possible fix: a small middleware on both apps, placed after
  `cors()`, that sends any `OPTIONS` not already answered to `notFound`. The other option is to amend the spec to
  allow the router's automatic `OPTIONS` reply. identity-service shares this design (spec §1.4 parity), so its QA
  should check the same case. The integration suite has no `OPTIONS` case (`tests/integration/envelope.test.ts`).
- **Known bug #2 reproduced (case 51): Knex writes raw, non-JSON console output during a Postgres outage.**
  While Postgres was stopped, the `care-api` log held 15–18 non-JSON lines per outage window (two infra runs). Examples: `Connection Error: Connection
  ended unexpectedly` (Knex `client.js:310`, `this.logger.warn`) and `Acquire connection error: Error: operation
  timed out for an unknown reason`, followed by a multi-line tarn/knex stack (Knex `client.js:489`). On restart the
  same lines appeared with `the database system is starting up`. They come from Knex's default logger
  (`console.log`), because `createKnex` in `src/lib/knex/knex.ts:23-46` passes no `log` option. They carry no DSN,
  credentials, or request data, but they break the rule of one JSON object per line
  (CLAUDE.md → Privacy and logging; spec §3.4.4 "console.* is banned… everything goes through Logger"). Already
  pinned by `test.failing` in `tests/integration/health.test.ts`. Not fixed here: QA does not change `src/`.
- Known bugs #1 (pg error messages carrying request values reach logs) and #3 (`INTERNAL_HOST` accepts non-IP
  values) **cannot be observed through CURL on the foundation surface**. No mounted route sends request values
  to Postgres, and #3 is an env-validation defect at boot. Both stay pinned by their `test.failing` cases.
- Observation, not a failure: `redis_recovered` is logged once at **boot** on the first Redis `ready` (see
  `src/lib/redis/redis.ts`, the `healthy` flag starts `false`). Spec §3.4.9 describes it as the line after a
  `redis_unavailable`. A log-derived alert keyed on `redis_recovered` would see one event per start. This is
  cosmetic; a boot-time `redis_ready` line, or starting the transition log only after the first error, would
  remove the ambiguity.
- Observation: `HEAD /api/health/live` → 200 with no body (Express maps `HEAD` to `GET`), and
  `/api/health/live/` (trailing slash) → 200 (non-strict routing). Both are harmless and consistent with probes.
- Observation: health responses carry a weak `ETag`. This is harmless alongside `Cache-Control: no-store`.
- Parity note: unlike identity, Care writes no separate `readiness_failed` line on a 503. The `error`-level
  `request_completed` (case 50) is the only signal, which matches the Care spec, since §3.4.4 defines no such line.
- Every `care-worker` line (20 at the end of the run) is JSON; the worker has no Postgres or Redis wiring yet, so
  outages do not affect it.

## Not exercised, and why

| Area | Why not | Where it is covered |
|---|---|---|
| Idempotency middleware (`lib/idempotency`) | mounted only on test routers (`tests/helpers/test-routers.ts`), deliberately not in `src/routes.ts`; no product endpoint uses it yet | `tests/integration/idempotency.test.ts` (replay, 422, 400 missing key, 409 + `Retry-After: 1` in-flight, Redis-down skip), spec §3.4.10 |
| Rate limiting (`lib/rate-limit`) | same: no mounted route is rate-limited in the foundation | `tests/integration/rate-limit.test.ts`, spec §3.4.11 |
| Dev CORS allowlist (allowed origin, preflight 204, `Allow-Methods`/`Allow-Headers`/`Max-Age`) | the compose stack runs `NODE_ENV=production`; the task forbids starting another long-running server. The script has the `EXPECT_CORS=1` branch ready for a host `npm run dev` | `tests/integration/cors.test.ts`, `tests/unit/lib/http/cors.test.ts` |
| Readiness during shutdown (503 while draining), graceful-shutdown order | needs a controlled `SIGTERM` mid-request; restarting `care-api` is out of this run's scope (stack must stay up) | `tests/unit/lib/lifecycle/graceful-shutdown.test.ts`, `tests/integration/process.test.ts` (skipped on win32, runs on CI) |
| `500 InternalError` envelope | no product route can throw an unhandled error | `tests/integration/envelope.test.ts` (test route) |
| DTO validation (`forbidNonWhitelisted`, no value echo) | no product route takes a body | `tests/integration/envelope.test.ts`, `tests/unit/lib/validation/validate.test.ts` |
| Bearer / service tokens, RBAC, `401`/`403` | `lib/auth` and `lib/rbac` are out of scope for the foundation (spec §10); health is the documented no-`authorize` exception (spec §3.1) | first business module |
| Identity Cases 1–4 | the foundation makes no Identity calls (spec §5) | later modules |

## Contract conformance

Checked against `contracts/openapi.yaml` (`getPublicLiveness`, `getPublicReadiness`, `getInternalLiveness`,
`getInternalReadiness`; responses `HealthLiveOk`, `HealthReadyOk`, `HealthReadyDown`) and spec §3.1:

- `HealthLive`: bare `{"status":"ok"}` with no envelope, on both listeners and during both outages. Matches.
- `HealthStatus`: `{status: ok|degraded|down, checks:{database, redis}}`; `503` exactly when `status` is `down`;
  `degraded` stays `200`. Matches on both listeners.
- Headers `X-Request-Id` (UUID) and `Cache-Control: no-store` appear on every health response (200 and 503). Matches.
- `ErrorEnvelope`: `{success:false, error:{code, message, details, requestId}}` with `details` always present.
  The codes seen were `NotFound` and `ValidationFailed`, both in the `ErrorCode` enum, and the messages match spec
  §3.4.3. Matches. The exception is case 23, where `OPTIONS` bypasses the envelope.

No contract drift. The only divergence is from the spec's method-handling rule (case 23).

_Correction (2026-09-28, `/update-docs`):_ the bodies checked here are byte-compatible with identity-service's (spec
§1.4), but the two contracts' schemas are not identical: Care's `HealthLive` and `HealthStatus` declare
`additionalProperties: false`, identity's do not (spec §12.1 correction, §13.2). This does not change any result
above.

## Re-run 2026-09-28

_After both `/develop foundation --fix-review` rounds • Server: the dev stack rebuilt from the current tree
(`care-api` `NODE_ENV=production`, 3001 public / `127.0.0.1:3101` internal) •
Script only: `scripts/curl-test-foundation.sh`, no manual case table re-recorded._

| Mode | Pass | Fail | Known |
|---|---|---|---|
| read-only | 97 | 0 | 0 |
| `RUN_INFRA_CASES=1` (Redis and Postgres stopped and restored) | 125 | 0 | 0 |

- **Bug 4 fixed** ([GitHub #4](https://github.com/OmarRedaX/vcare-care-api/issues/4)): `OPTIONS /api/health/live` and
  `OPTIONS /internal/health/ready` now answer `404 NotFound` with the envelope (case 23 passes; the 3 assertions that
  failed on 2026-09-26 pass). The totals are unchanged (97 and 125 assertions); only their outcome changed.
- **Known bug 2 no longer reproduces:** the Postgres-outage window produced no non-JSON line, so the script's
  known-bug check for case 51 counted a pass, not a known failure (Knex messages are now `knex_warn` / `knex_error`
  JSON lines).
- **Dev database prepared for the new migration names:** the existing `care-pg-data` volume still recorded
  `20260915000000_create_extension_btree_gist.js`; the `.js` suffix was stripped in `knex_migrations` before the run
  (see [quickstart.md](../quickstart.md) → "If `npm run migrate` says 'migration directory is corrupt'").
- Bugs 1 and 3 are still not observable through CURL on the foundation surface (see the 2026-09-26 notes); both are
  covered by plain (no longer `test.failing`) tests.
- Not re-exercised by hand: the 2026-09-26 "Not exercised, and why" list still applies.
- No tokens, secrets, or PII were recorded; every marker the script sends is synthetic.
