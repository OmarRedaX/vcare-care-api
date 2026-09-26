#!/usr/bin/env bash
# Manual QA for the `foundation` module of care-service (docs/foundation/manual-qa.md).
#
# Foundation exposes no business endpoints. This script exercises the four health probes plus the
# cross-cutting behaviour every later module inherits: X-Request-Id, the one error envelope (404 /
# body-parser mappings), listener isolation, helmet headers, CORS gating, and structured logging
# (spec §3.1, §3.3, §3.4.3-§3.4.6, §4; contract getPublicLiveness / getPublicReadiness /
# getInternalLiveness / getInternalReadiness).
#
# Usage (from anywhere; the dev stack must be up: `docker compose up -d` in the repo root):
#   ./scripts/curl-test-foundation.sh
#   RUN_INFRA_CASES=1 ./scripts/curl-test-foundation.sh   # also stops/starts Redis and Postgres
#
# Environment:
#   PUBLIC_URL        public listener            (default http://localhost:3001)
#   INTERNAL_URL      internal listener          (default http://localhost:3101)
#   COMPOSE_FILE      compose file of the stack  (default <repo>/docker-compose.yml)
#   EXPECT_CORS       1 when the server runs with NODE_ENV=development and CORS_ORIGINS contains
#                     CORS_ORIGIN (host `npm run dev`); 0 for the compose stack (NODE_ENV=production,
#                     CORS disabled — hub ADR 0005). Default 0.
#   CORS_ORIGIN       dev allowlisted origin     (default http://localhost:5173)
#   RUN_INFRA_CASES   1 to run the Redis/Postgres outage cases (default 0)
#   LOG_CHECKS        1 to read `docker compose logs care-api` and assert on log lines (default 1;
#                     auto-disabled when the compose service is not running)
#
# Read-only and idempotent unless RUN_INFRA_CASES=1, which stops containers and ALWAYS restarts
# Postgres and Redis on exit (EXIT trap), then waits for readiness to return to "ok".
# No credentials are used; every marker string sent below is synthetic.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:3001}"
INTERNAL_URL="${INTERNAL_URL:-http://localhost:3101}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.yml}"
EXPECT_CORS="${EXPECT_CORS:-0}"
CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"
RUN_INFRA_CASES="${RUN_INFRA_CASES:-0}"
LOG_CHECKS="${LOG_CHECKS:-1}"

PASS=0
FAIL=0
KNOWN=0
INFRA_TOUCHED=0
TMP="$(mktemp -d)"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

restore_infra() {
  echo
  echo "=== EXIT trap: restoring Postgres and Redis ==="
  dc start postgres redis >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 60); do
    if curl -s "$PUBLIC_URL/api/health/ready" 2>/dev/null | grep -q '"status":"ok"'; then
      echo "  readiness back to ok after ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "  WARNING: readiness not ok after 60s — check: docker compose ps"
}

on_exit() {
  local rc=$?
  if [ "$INFRA_TOUCHED" = "1" ]; then restore_infra; fi
  rm -rf "$TMP"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# Paths handed to Windows-native node must be mixed-form (C:/...) under Git Bash.
nodepath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }

uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr "[:upper:]" "[:lower:]"
  else
    node -e "process.stdout.write(require('node:crypto').randomUUID())"
  fi
}

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# call <method> <url> [curl args...] -> writes $TMP/body, $TMP/headers, $TMP/rid; echoes the status.
# Sends a fresh X-Request-Id (recorded in $TMP/rid).
call() {
  local method="$1" url="$2" rid
  shift 2
  rid="$(uuid)"
  printf "%s" "$rid" > "$TMP/rid"
  curl -s -o "$TMP/body" -D "$TMP/headers" -X "$method" -H "X-Request-Id: $rid" "$url" "$@" -w "%{http_code}" || true
}

# raw <curl args...> -> like call but sends only the headers given (for X-Request-Id cases).
raw() { curl -s -o "$TMP/body" -D "$TMP/headers" "$@" -w "%{http_code}" || true; }

header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
header_count() { { grep -ci "^$1:" "$TMP/headers" || true; } | tr -d "\r\n "; }
body() { cat "$TMP/body"; }
rid() { cat "$TMP/rid"; }
is_uuid() { printf "%s" "$1" | grep -Eq "$UUID_RE" && echo uuid || echo "not-uuid($1)"; }
absent() { [ -z "$(header "$1")" ] && echo absent || echo "present($(header "$1"))"; }
ctype() { local c; c="$(header Content-Type)"; printf "%s" "${c%%;*}"; }

# envelope <code> <message> <detailsJson> <requestId> -> the exact error body the contract requires
envelope() {
  printf '{"success":false,"error":{"code":"%s","message":"%s","details":%s,"requestId":"%s"}}' "$1" "$2" "$3" "$4"
}
NF_MSG="Resource not found"
VF_MSG="Request validation failed"

# check <label> <expected> <actual>
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    printf "  PASS  %s\n" "$label"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s\n        expected: %s\n        got:      %s\n" "$label" "$expected" "$actual"
  fi
}

# known_bug <label> <reproduced: yes|no> — a product bug already pinned by `test.failing`.
# Reproduced -> KNOWN (not a new failure). Not reproduced -> PASS with a prompt to drop the marker.
known_bug() {
  if [ "$2" = "yes" ]; then
    KNOWN=$((KNOWN + 1))
    printf "  KNOWN %s (reproduced; pinned by test.failing — see docs/foundation/tasks.md)\n" "$1"
  else
    PASS=$((PASS + 1))
    printf "  PASS  %s (no longer reproduces — remove the known-bug marker here and in the tests)\n" "$1"
  fi
}

section() { printf "\n=== %s ===\n" "$1"; }

# --- log helpers (node reads stdin; no temp paths cross the Git Bash / Windows boundary) -------------
cat > "$TMP/logcheck.js" <<'JS'
// usage: node logcheck.js nonjson | missing-rid | count <message> [key=value ...]
const lines = require("fs").readFileSync(0, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
const parsed = lines.map((l) => { try { const o = JSON.parse(l); return o && typeof o === "object" ? o : null; } catch { return null; } });
const [mode, ...args] = process.argv.slice(2);
if (mode === "nonjson") {
  process.stdout.write(String(parsed.filter((o) => o === null).length));
} else if (mode === "missing-rid") {
  process.stdout.write(String(parsed.filter((o) => o && o.message === "request_completed" && !o.requestId).length));
} else if (mode === "count") {
  const [message, ...filters] = args;
  const pairs = filters.map((f) => { const i = f.indexOf("="); return [f.slice(0, i), f.slice(i + 1)]; });
  process.stdout.write(String(parsed.filter((o) => o && o.message === message && pairs.every(([k, v]) => String(o[k]) === v)).length));
} else {
  process.stderr.write("unknown mode\n"); process.exit(2);
}
JS
LOGCHECK="$(nodepath "$TMP/logcheck.js")"
logs_since() { dc logs --no-color --no-log-prefix --since "$1" care-api 2>/dev/null || true; }
now_minus() { date -u -d "-${1} seconds" +%Y-%m-%dT%H:%M:%SZ; }
# MSYS_NO_PATHCONV: stop Git Bash rewriting "route=/api/..." into a Windows path for native node.
logq() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" node "$LOGCHECK" "$@"; }

# ---------------------------------------------------------------------------
section "Preflight"
status="$(call GET "$PUBLIC_URL/api/health/live")"
if [ "$status" != "200" ]; then
  echo "Server not reachable at $PUBLIC_URL (got $status). Start the dev stack from the repo root:"
  echo "  docker compose up -d --build      # postgres 5433, redis 6380, migrate, care-api 3001/3101, care-worker"
  echo "  curl -s $PUBLIC_URL/api/health/ready   # expect {\"status\":\"ok\",...}"
  exit 1
fi
echo "  public listener reachable at $PUBLIC_URL"
if [ "$LOG_CHECKS" = "1" ] && [ -z "$(dc ps -q care-api 2>/dev/null || true)" ]; then
  echo "  care-api compose service not running — log checks disabled"
  LOG_CHECKS=0
fi
if [ "$RUN_INFRA_CASES" = "1" ] && [ "$LOG_CHECKS" != "1" ]; then
  echo "  RUN_INFRA_CASES=1 needs the compose stack (docker compose) — aborting"
  exit 1
fi
RUN_START="$(now_minus 2)"

# ---------------------------------------------------------------------------
section "A. Health happy paths (contract HealthLiveOk / HealthReadyOk)"
check "GET /api/health/live -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/live")"
check "  body" '{"status":"ok"}' "$(body)"
check "  Cache-Control" "no-store" "$(header Cache-Control)"
check "  Content-Type" "application/json" "$(ctype)"
check "  X-Request-Id echoes the sent id" "$(rid)" "$(header X-Request-Id)"

check "GET /api/health/ready -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/ready")"
check "  body" '{"status":"ok","checks":{"database":"up","redis":"up"}}' "$(body)"
check "  Cache-Control" "no-store" "$(header Cache-Control)"
check "  X-Request-Id echoes the sent id" "$(rid)" "$(header X-Request-Id)"

check "GET /internal/health/live -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/live")"
check "  body" '{"status":"ok"}' "$(body)"
check "  Cache-Control" "no-store" "$(header Cache-Control)"

check "GET /internal/health/ready -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/ready")"
check "  body" '{"status":"ok","checks":{"database":"up","redis":"up"}}' "$(body)"
check "  Cache-Control" "no-store" "$(header Cache-Control)"
check "  Content-Type" "application/json" "$(ctype)"

check "unknown query parameter ignored -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/live?probe=1")"
check "  body" '{"status":"ok"}' "$(body)"

# ---------------------------------------------------------------------------
section "B. X-Request-Id (spec §1.4 parity rule, F3)"
SENT="$(uuid)"
raw -H "X-Request-Id: $SENT" "$PUBLIC_URL/api/health/live" >/dev/null
check "valid lower-case UUID is echoed" "$SENT" "$(header X-Request-Id)"

UPPER="$(uuid | tr "[:lower:]" "[:upper:]")"
raw -H "X-Request-Id: $UPPER" "$PUBLIC_URL/api/health/live" >/dev/null
check "upper-case UUID is adopted lower-cased" "$(printf "%s" "$UPPER" | tr "[:upper:]" "[:lower:]")" "$(header X-Request-Id)"

V1="6ba7b810-9dad-11d1-80b4-00c04fd430c8"
raw -H "X-Request-Id: $V1" "$PUBLIC_URL/api/health/live" >/dev/null
check "non-v4 UUID (v1) is adopted (any version)" "$V1" "$(header X-Request-Id)"

raw -H "X-Request-Id: not-a-uuid" "$PUBLIC_URL/api/health/live" >/dev/null
GOT="$(header X-Request-Id)"
check "malformed id is replaced by a fresh UUID" "uuid" "$(is_uuid "$GOT")"
check "  and not echoed" "replaced" "$([ "$GOT" != "not-a-uuid" ] && echo replaced || echo echoed)"

raw -H "X-Request-Id;" "$PUBLIC_URL/api/health/live" >/dev/null
check "empty header -> fresh UUID" "uuid" "$(is_uuid "$(header X-Request-Id)")"

raw "$PUBLIC_URL/api/health/live" >/dev/null
check "absent header -> fresh UUID" "uuid" "$(is_uuid "$(header X-Request-Id)")"

A1="$(uuid)"; A2="$(uuid)"
raw -H "X-Request-Id: $A1" -H "X-Request-Id: $A2" "$PUBLIC_URL/api/health/live" >/dev/null
GOT="$(header X-Request-Id)"
check "repeated header -> one fresh UUID" "1 uuid fresh" \
  "$(header_count X-Request-Id) $(is_uuid "$GOT") $([ "$GOT" != "$A1" ] && [ "$GOT" != "$A2" ] && echo fresh || echo reused)"

SENT="$(uuid)"
check "404 carries the sent id in header" 404 "$(raw -H "X-Request-Id: $SENT" "$PUBLIC_URL/api/nope")"
check "  header" "$SENT" "$(header X-Request-Id)"
check "  body error.requestId" "$(envelope NotFound "$NF_MSG" "[]" "$SENT")" "$(body)"

SENT="$(uuid)"
raw -H "X-Request-Id: $SENT" "$INTERNAL_URL/internal/health/ready" >/dev/null
check "internal listener echoes the id" "$SENT" "$(header X-Request-Id)"

# ---------------------------------------------------------------------------
section "C. Listener isolation (F11)"
check "/internal/health/live on PUBLIC -> 404" 404 "$(call GET "$PUBLIC_URL/internal/health/live")"
check "  envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
check "/internal/health/ready on PUBLIC -> 404" 404 "$(call GET "$PUBLIC_URL/internal/health/ready")"
check "/api/health/live on INTERNAL -> 404" 404 "$(call GET "$INTERNAL_URL/api/health/live")"
check "  envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
check "/api/health/ready on INTERNAL -> 404" 404 "$(call GET "$INTERNAL_URL/api/health/ready")"
if [ "$LOG_CHECKS" = "1" ]; then
  check "internal port published on host loopback only" "127.0.0.1:3101" \
    "$(dc port care-api 3101 2>/dev/null | tr -d '\r' | head -1)"
fi

# ---------------------------------------------------------------------------
section "D. Error envelope (F4, F5; spec §3.4.3)"
check "unknown public path -> 404" 404 "$(call GET "$PUBLIC_URL/api/definitely/not/here")"
check "  exact envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
check "  Content-Type" "application/json" "$(ctype)"
check "unknown internal path -> 404" 404 "$(call GET "$INTERNAL_URL/internal/definitely/not/here")"
check "  exact envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
check "root path -> 404" 404 "$(call GET "$PUBLIC_URL/")"
check "  exact envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
check "/api/health (no probe) -> 404" 404 "$(call GET "$PUBLIC_URL/api/health")"
check "/api/health/<other> -> 404" 404 "$(call GET "$PUBLIC_URL/api/health/deep")"
check "POST on a GET-only path -> 404" 404 \
  "$(call POST "$PUBLIC_URL/api/health/live" -H "Content-Type: application/json" -d '{}')"
check "  exact envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
check "PUT on a GET-only path -> 404" 404 "$(call PUT "$PUBLIC_URL/api/health/ready")"
check "DELETE on internal GET-only path -> 404" 404 "$(call DELETE "$INTERNAL_URL/internal/health/live")"
# Spec §3.4.3: "Unmatched methods on a known path are also 404 (no 405 code exists)."
check "OPTIONS on a GET-only path -> 404 (spec §3.4.3)" 404 "$(call OPTIONS "$PUBLIC_URL/api/health/live")"
check "  envelope code" "NotFound" "$(body | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
check "OPTIONS on internal GET-only path -> 404 (spec §3.4.3)" 404 "$(call OPTIONS "$INTERNAL_URL/internal/health/ready")"

MALFORMED='[{"field":"body","issue":"must be valid JSON"}]'
check "malformed JSON -> 400" 400 \
  "$(call POST "$PUBLIC_URL/api/nope" -H "Content-Type: application/json" -d '{bad')"
check "  exact envelope" "$(envelope ValidationFailed "$VF_MSG" "$MALFORMED" "$(rid)")" "$(body)"
check "malformed JSON on internal -> 400" 400 \
  "$(call POST "$INTERNAL_URL/internal/nope" -H "Content-Type: application/json" -d '{bad')"
check "  exact envelope" "$(envelope ValidationFailed "$VF_MSG" "$MALFORMED" "$(rid)")" "$(body)"
check "JSON primitive with strict parser -> 400" 400 \
  "$(call POST "$PUBLIC_URL/api/nope" -H "Content-Type: application/json" -d '"text"')"
check "  exact envelope" "$(envelope ValidationFailed "$VF_MSG" "$MALFORMED" "$(rid)")" "$(body)"

node -e "process.stdout.write(JSON.stringify({pad:'x'.repeat(110*1024)}))" > "$TMP/big.json"
check "body > 100kb -> 400" 400 \
  "$(call POST "$PUBLIC_URL/api/nope" -H "Content-Type: application/json" --data-binary "@$TMP/big.json")"
check "  exact envelope" \
  "$(envelope ValidationFailed "$VF_MSG" '[{"field":"body","issue":"must not exceed 100kb"}]' "$(rid)")" "$(body)"

UNREADABLE='[{"field":"body","issue":"could not be read"}]'
check "unsupported charset -> 400" 400 \
  "$(call POST "$PUBLIC_URL/api/nope" -H "Content-Type: application/json; charset=x-qa-unknown" -d '{}')"
check "  exact envelope" "$(envelope ValidationFailed "$VF_MSG" "$UNREADABLE" "$(rid)")" "$(body)"
check "unsupported Content-Encoding -> 400" 400 \
  "$(call POST "$PUBLIC_URL/api/nope" -H "Content-Type: application/json" -H "Content-Encoding: compress" -d '{}')"
check "  exact envelope" "$(envelope ValidationFailed "$VF_MSG" "$UNREADABLE" "$(rid)")" "$(body)"
check "non-JSON Content-Type is not parsed -> 404" 404 \
  "$(call POST "$PUBLIC_URL/api/nope" -H "Content-Type: text/plain" -d '{bad')"

# ---------------------------------------------------------------------------
section "E. Security headers (helmet on both listeners; x-powered-by disabled)"
for target in "$PUBLIC_URL/api/health/live" "$INTERNAL_URL/internal/health/live"; do
  call GET "$target" >/dev/null
  echo "  -- $target"
  check "  X-Powered-By" "absent" "$(absent X-Powered-By)"
  check "  X-Content-Type-Options" "nosniff" "$(header X-Content-Type-Options)"
  check "  Referrer-Policy" "no-referrer" "$(header Referrer-Policy)"
  check "  X-Frame-Options" "SAMEORIGIN" "$(header X-Frame-Options)"
  check "  Cross-Origin-Opener-Policy" "same-origin" "$(header Cross-Origin-Opener-Policy)"
  check "  Cross-Origin-Resource-Policy" "same-origin" "$(header Cross-Origin-Resource-Policy)"
  check "  Content-Security-Policy present" "yes" "$([ -n "$(header Content-Security-Policy)" ] && echo yes || echo no)"
  check "  Strict-Transport-Security present" "yes" "$([ -n "$(header Strict-Transport-Security)" ] && echo yes || echo no)"
done
call GET "$PUBLIC_URL/api/nope" >/dev/null
check "  X-Powered-By absent on an error response" "absent" "$(absent X-Powered-By)"

# ---------------------------------------------------------------------------
if [ "$EXPECT_CORS" = "1" ]; then
  section "F. CORS — development allowlist (F22, spec §3.4.6)"
  raw -H "Origin: $CORS_ORIGIN" "$PUBLIC_URL/api/health/live" >/dev/null
  check "allowlisted origin reflected" "$CORS_ORIGIN" "$(header Access-Control-Allow-Origin)"
  check "  Vary" "Origin" "$(header Vary)"
  check "  Expose-Headers" "X-Request-Id, Retry-After" "$(header Access-Control-Expose-Headers)"
  check "  no Allow-Credentials (bearer tokens only)" "absent" "$(absent Access-Control-Allow-Credentials)"
  check "preflight from allowlisted origin -> 204" 204 \
    "$(raw -X OPTIONS -H "Origin: $CORS_ORIGIN" -H "Access-Control-Request-Method: POST" "$PUBLIC_URL/api/health/live")"
  check "  Allow-Methods" "GET, POST, PATCH, DELETE" "$(header Access-Control-Allow-Methods)"
  check "  Allow-Headers" "Authorization, Content-Type, Idempotency-Key, X-Request-Id" "$(header Access-Control-Allow-Headers)"
  check "  Max-Age" "600" "$(header Access-Control-Max-Age)"
  raw -H "Origin: http://evil.example.test" "$PUBLIC_URL/api/health/live" >/dev/null
  check "disallowed origin -> no CORS headers" "absent" "$(absent Access-Control-Allow-Origin)"
else
  section "F. CORS — production mode: disabled (F22, hub ADR 0005)"
  raw -H "Origin: $CORS_ORIGIN" "$PUBLIC_URL/api/health/live" >/dev/null
  check "dev origin gets no Access-Control-Allow-Origin" "absent" "$(absent Access-Control-Allow-Origin)"
  check "  no Access-Control-Expose-Headers" "absent" "$(absent Access-Control-Expose-Headers)"
  raw -H "Origin: http://evil.example.test" "$PUBLIC_URL/api/health/live" >/dev/null
  check "foreign origin gets no CORS headers" "absent" "$(absent Access-Control-Allow-Origin)"
  raw -X OPTIONS -H "Origin: $CORS_ORIGIN" -H "Access-Control-Request-Method: POST" "$PUBLIC_URL/api/health/live" >/dev/null
  check "preflight gets no Access-Control-Allow-Origin" "absent" "$(absent Access-Control-Allow-Origin)"
  check "  no Access-Control-Allow-Methods" "absent" "$(absent Access-Control-Allow-Methods)"
fi
raw -H "Origin: $CORS_ORIGIN" "$INTERNAL_URL/internal/health/live" >/dev/null
check "internal listener never emits CORS headers" "absent" "$(absent Access-Control-Allow-Origin)"

# ---------------------------------------------------------------------------
if [ "$LOG_CHECKS" = "1" ]; then
  section "G. Structured logs (F7; spec §3.4.4; CLAUDE.md → Privacy and logging)"
  MARK_TOKEN="qa-synthetic-token-$(uuid)"
  MARK_QUERY="qa-synthetic-query-$(uuid)"
  PROBE_404="$(uuid)"; PROBE_400="$(uuid)"; PROBE_HEALTH="$(uuid)"
  raw -H "X-Request-Id: $PROBE_404" -H "Authorization: Bearer $MARK_TOKEN" \
    "$PUBLIC_URL/api/nope?q=$MARK_QUERY" >/dev/null
  raw -X POST -H "X-Request-Id: $PROBE_400" -H "Content-Type: application/json" \
    -d '{"complaintText":"SYNTHETIC-COMPLAINT-7731","email":"synthetic.patient@example.test"' \
    "$PUBLIC_URL/api/nope" >/dev/null
  raw -X POST -H "Content-Type: application/json" \
    -d '{"complaintText":"SYNTHETIC-COMPLAINT-7731","email":"synthetic.patient@example.test"}' \
    "$PUBLIC_URL/api/nope" >/dev/null
  raw -H "X-Request-Id: $PROBE_HEALTH" "$PUBLIC_URL/api/health/live" >/dev/null
  sleep 1
  logs_since "$RUN_START" > "$TMP/run.log"
  check "every care-api line of this run is one JSON object" 0 "$(logq nonjson < "$TMP/run.log")"
  check "every request_completed carries requestId" 0 "$(logq missing-rid < "$TMP/run.log")"
  check "404 logged once: request_completed route=unmatched status=404 code=NotFound" 1 \
    "$(logq count request_completed requestId="$PROBE_404" route=unmatched status=404 code=NotFound level=info < "$TMP/run.log")"
  check "400 logged once with code=ValidationFailed" 1 \
    "$(logq count request_completed requestId="$PROBE_400" status=400 code=ValidationFailed < "$TMP/run.log")"
  check "health 200 not logged at LOG_LEVEL=info (debug by design)" 0 \
    "$(logq count request_completed requestId="$PROBE_HEALTH" < "$TMP/run.log")"
  check "no Authorization value in logs" 0 "$(grep -c -- "$MARK_TOKEN" "$TMP/run.log" || true)"
  check "no query string in logs" 0 "$(grep -c -- "$MARK_QUERY" "$TMP/run.log" || true)"
  check "no request-body fixture in logs" 0 \
    "$(grep -c -e "SYNTHETIC-COMPLAINT-7731" -e "synthetic.patient@example.test" "$TMP/run.log" || true)"
else
  section "G. Structured logs — skipped (LOG_CHECKS=0 or compose service not running)"
fi

# ---------------------------------------------------------------------------
# Infrastructure cases: readiness decision table rows (spec §3.1). Off by default: they stop containers.
if [ "$RUN_INFRA_CASES" = "1" ]; then
  wait_ready() { # wait_ready <grep pattern> <seconds>
    local pattern="$1" limit="$2" i
    for i in $(seq 1 "$limit"); do
      curl -s "$PUBLIC_URL/api/health/ready" 2>/dev/null | grep -q "$pattern" && return 0
      sleep 1
    done
    return 1
  }
  INFRA_TOUCHED=1

  section "H. Redis stopped -> 200 degraded (Redis is Tier 2, ADR 0006, F10)"
  T_REDIS="$(now_minus 1)"
  dc stop redis >/dev/null 2>&1
  wait_ready '"redis":"down"' 20 || true
  check "public readiness -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/ready")"
  check "  body" '{"status":"degraded","checks":{"database":"up","redis":"down"}}' "$(body)"
  check "  Cache-Control" "no-store" "$(header Cache-Control)"
  check "internal readiness -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/ready")"
  check "  body" '{"status":"degraded","checks":{"database":"up","redis":"down"}}' "$(body)"
  check "public liveness -> 200 ok" '200 {"status":"ok"}' "$(call GET "$PUBLIC_URL/api/health/live") $(body)"
  check "internal liveness -> 200 ok" '200 {"status":"ok"}' "$(call GET "$INTERNAL_URL/internal/health/live") $(body)"
  check "404 envelope still served" 404 "$(call GET "$PUBLIC_URL/api/nope")"

  section "I. Redis restarted -> ok"
  dc start redis >/dev/null 2>&1
  wait_ready '"redis":"up"' 30 || true
  check "public readiness -> 200 ok" '200 {"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$PUBLIC_URL/api/health/ready") $(body)"
  check "internal readiness -> 200 ok" '200 {"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$INTERNAL_URL/internal/health/ready") $(body)"
  sleep 1
  logs_since "$T_REDIS" > "$TMP/redis.log"
  check "Redis window: every line is JSON" 0 "$(logq nonjson < "$TMP/redis.log")"
  check "Redis window: one redis_unavailable line (per transition, not per error)" 1 \
    "$(logq count redis_unavailable level=warn < "$TMP/redis.log")"
  check "Redis window: one redis_recovered line" 1 "$(logq count redis_recovered level=info < "$TMP/redis.log")"

  section "J. Postgres stopped -> 503 down (the only fatal dependency, F9, F10)"
  T_PG="$(now_minus 1)"
  dc stop postgres >/dev/null 2>&1
  wait_ready '"database":"down"' 20 || true
  check "public readiness -> 503" 503 "$(call GET "$PUBLIC_URL/api/health/ready")"
  check "  body" '{"status":"down","checks":{"database":"down","redis":"up"}}' "$(body)"
  check "  Cache-Control" "no-store" "$(header Cache-Control)"
  check "  X-Request-Id echoes the sent id" "$(rid)" "$(header X-Request-Id)"
  PG_503_RID="$(rid)"
  check "internal readiness -> 503" 503 "$(call GET "$INTERNAL_URL/internal/health/ready")"
  check "  body" '{"status":"down","checks":{"database":"down","redis":"up"}}' "$(body)"
  check "public liveness still -> 200 ok" '200 {"status":"ok"}' "$(call GET "$PUBLIC_URL/api/health/live") $(body)"
  check "internal liveness still -> 200 ok" '200 {"status":"ok"}' "$(call GET "$INTERNAL_URL/internal/health/live") $(body)"
  check "404 envelope still served (no 500)" 404 "$(call GET "$PUBLIC_URL/api/nope")"
  check "  exact envelope" "$(envelope NotFound "$NF_MSG" "[]" "$(rid)")" "$(body)"
  sleep 1
  logs_since "$T_PG" > "$TMP/pg.log"
  check "503 readiness logged at error: request_completed route=/api/health/ready status=503" 1 \
    "$(logq count request_completed requestId="$PG_503_RID" level=error route=/api/health/ready status=503 < "$TMP/pg.log")"
  check "Postgres window: every request_completed carries requestId" 0 "$(logq missing-rid < "$TMP/pg.log")"
  NONJSON_PG="$(logq nonjson < "$TMP/pg.log")"
  echo "        (Postgres window: $NONJSON_PG non-JSON line(s); first raw line shown, truncated)"
  { grep -v '^{' "$TMP/pg.log" || true; } | head -1 | cut -c1-100 | sed 's/^/        | /'
  known_bug "bug #2: Knex default logger writes raw non-JSON lines during a Postgres outage" \
    "$([ "$NONJSON_PG" -gt 0 ] && echo yes || echo no)"

  section "K. Postgres restarted -> ok"
  dc start postgres >/dev/null 2>&1
  wait_ready '"status":"ok"' 60 || true
  check "public readiness -> 200 ok" '200 {"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$PUBLIC_URL/api/health/ready") $(body)"
  check "internal readiness -> 200 ok" '200 {"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$INTERNAL_URL/internal/health/ready") $(body)"
else
  section "H-K. Infrastructure cases skipped"
  echo "  set RUN_INFRA_CASES=1 to stop/start Redis and Postgres and assert the readiness table"
fi

# ---------------------------------------------------------------------------
printf "\n=== Result: %s pass / %s fail / %s known (pinned product bugs) ===\n" "$PASS" "$FAIL" "$KNOWN"
[ "$FAIL" -eq 0 ]
