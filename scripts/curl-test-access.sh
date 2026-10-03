#!/usr/bin/env bash
# Manual QA for the `access` unit of care-service (docs/access/manual-qa.md; spec §9.7, §3.3, §3.4, §3.5, §12).
#
# `access` adds no business route. It is exercised through the dev-only harness scripts/access-qa-server.ts, which
# serves the real public app plus the test-only routers of spec §9.3 (+ the §12 regression routers):
#   CARE_URL  — harness verifying REAL tokens from a running local Identity (IDENTITY_JWKS_URL → Identity)
#   EDGE_URL  — a second harness whose IDENTITY_JWKS_URL points at scripts/access-qa-fake-identity.ts, which also
#               mints claim-level edge tokens (expired, wrong aud/iss/typ, missing claims, alg none, HS256, ...)
#
# Usage (Git Bash on Windows, or any POSIX bash):
#   QA_PASSWORD='<synthetic password>' IDENTITY_DATABASE_URL='postgres://…/vcare_identity' ./scripts/curl-test-access.sh
#
# Prerequisites (see docs/access/manual-qa.md → Environment):
#   - Identity running (public IDENTITY_URL); on the FIRST run also its worker (registration codes are delivered to
#     its capture mailbox IDENTITY_MAIL_FILE, EMAIL_PROVIDER=capture).
#   - CARE_URL harness running:  npx tsx --env-file-if-exists=.env scripts/access-qa-server.ts  (log → CARE_LOG_FILE)
#   - EDGE_URL harness + fake identity: started by this script when unreachable and START_EDGE=1 (default), stopped
#     on exit.
#
# Environment (no secret has a default; nothing below is ever printed or written to a file):
#   QA_PASSWORD             required — password of the synthetic QA accounts (created on first run)
#   IDENTITY_DATABASE_URL   required — Identity's DB: looks up the QA accounts, promotes the admin, and sets the
#                           status / email-verified variants (pending, rejected, unverified) before each login
#   CARE_OWNER_DATABASE_URL Care owner URL for audit_logs checks (default: MIGRATION_DATABASE_URL from <repo>/.env)
#   CARE_URL (http://localhost:3001) · EDGE_URL (http://localhost:3011) · FAKE_IDENTITY_URL (http://127.0.0.1:3021)
#   IDENTITY_URL (http://localhost:3020) · IDENTITY_MAIL_FILE (<repo>/../vcare-identity-api/.local/mail/outbox.jsonl)
#   QA_EMAIL_DOMAIN (example.test) · QA_EMAIL_PREFIX (qa.access)
#   CARE_LOG_FILE / EDGE_LOG_FILE  harness stdout logs; enable the log assertions (#6 route label, hygiene)
#   REDIS_CLI (redis-cli or memurai-cli) · CARE_REDIS_DB (1) — used to plant malformed idempotency records (#11)
#   EXPECT_IDENTITY_JWKS (up) — expected readiness checks.identityJwks on CARE_URL
#   START_EDGE (1) · SKIP_JWKS_GATE_CASES (0; 1 skips the 61 s wait before the rotation / per-minute-gate cases)
#
# Idempotent: accounts are created once and reused; every request uses fresh UUIDs (X-Request-Id, Idempotency-Key).
# Login is limited by Identity to 5/min per IP+email — do not re-run within one minute.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CARE_URL="${CARE_URL:-http://localhost:3001}"
EDGE_URL="${EDGE_URL:-http://localhost:3011}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:3020}"
IDENTITY_MAIL_FILE="${IDENTITY_MAIL_FILE:-$REPO_DIR/../vcare-identity-api/.local/mail/outbox.jsonl}"
QA_EMAIL_DOMAIN="${QA_EMAIL_DOMAIN:-example.test}"
QA_EMAIL_PREFIX="${QA_EMAIL_PREFIX:-qa.access}"
CARE_LOG_FILE="${CARE_LOG_FILE:-}"
EDGE_LOG_FILE="${EDGE_LOG_FILE:-}"
CARE_REDIS_DB="${CARE_REDIS_DB:-1}"
EXPECT_IDENTITY_JWKS="${EXPECT_IDENTITY_JWKS:-up}"
START_EDGE="${START_EDGE:-1}"
SKIP_JWKS_GATE_CASES="${SKIP_JWKS_GATE_CASES:-0}"

: "${QA_PASSWORD:?QA_PASSWORD is required (synthetic password of the QA accounts)}"
: "${IDENTITY_DATABASE_URL:?IDENTITY_DATABASE_URL is required (Identity DB, for QA account variants)}"
if [ -z "${CARE_OWNER_DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  CARE_OWNER_DATABASE_URL="$(grep -E '^MIGRATION_DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
: "${CARE_OWNER_DATABASE_URL:?CARE_OWNER_DATABASE_URL (or MIGRATION_DATABASE_URL in .env) is required}"
if [ -z "${REDIS_CLI:-}" ]; then
  if command -v redis-cli >/dev/null 2>&1; then REDIS_CLI=redis-cli; elif command -v memurai-cli >/dev/null 2>&1; then REDIS_CLI=memurai-cli; else REDIS_CLI=""; fi
fi

PASS=0
FAIL=0
SKIP=0
CASE=0
TMP="$(mktemp -d)"
STARTED_EDGE=0
TOKEN_SIGS=()   # signature segments of every token used — only in memory, for the log-hygiene check

nodepath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
uuid() { node -e "process.stdout.write(require('node:crypto').randomUUID())"; }
pause() { ping -n "$(( $1 + 1 ))" 127.0.0.1 >/dev/null 2>&1 || sleep "$1"; }

kill_port() {
  local port="$1" pid
  if command -v netstat >/dev/null 2>&1 && command -v taskkill >/dev/null 2>&1; then
    for pid in $(netstat -ano | grep ":$port " | grep LISTEN | awk '{print $5}' | sort -u); do
      taskkill //PID "$pid" //F >/dev/null 2>&1 || true
    done
  elif command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -ti tcp:"$port" -sTCP:LISTEN); do kill "$pid" 2>/dev/null || true; done
  fi
}

on_exit() {
  local rc=$?
  if [ "$STARTED_EDGE" = "1" ]; then
    echo; echo "=== EXIT: stopping the edge harness and fake identity started by this run ==="
    kill_port "${EDGE_URL##*:}"; kill_port "${FAKE_IDENTITY_URL##*:}"
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# --- HTTP + assertions ------------------------------------------------------------------------------------------
# call <method> <url> [curl args...] → status; body/headers in $TMP, sent X-Request-Id in $TMP/rid
call() {
  local method="$1" url="$2" r; shift 2
  r="$(uuid)"; printf "%s" "$r" > "$TMP/rid"
  curl -s -o "$TMP/body" -D "$TMP/headers" -X "$method" -H "X-Request-Id: $r" "$@" "$url" -w "%{http_code}" || true
}
rid() { cat "$TMP/rid"; }
header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
# jfields <path>... → values of the JSON body joined by "|" (<undef> when absent, <non-json> when unparsable)
jfields() {
  node -e '
    const fs = require("fs"); let b;
    try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("<non-json>"); process.exit(0); }
    const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
    process.stdout.write(process.argv.slice(2).map((p) => { const v = get(b, p);
      return v === undefined ? "<undef>" : typeof v === "object" ? JSON.stringify(v) : String(v); }).join("|"));
  ' "$(nodepath "$TMP/body")" "$@"
}
auth() { printf "Authorization: Bearer %s" "$1"; }
remember() { TOKEN_SIGS+=("${1##*.}"); }

record() { # record <label> <request> <expected> <got> <ok 0|1>
  CASE=$((CASE + 1))
  if [ "$5" = "1" ]; then PASS=$((PASS + 1)); printf "  PASS  %-4s %-62s exp=[%s] got=[%s]  (%s)\n" "A$CASE" "$1" "$3" "$4" "$2"
  else FAIL=$((FAIL + 1)); printf "  FAIL  %-4s %-62s exp=[%s] got=[%s]  (%s)\n" "A$CASE" "$1" "$3" "$4" "$2"; fi
}
skip() { CASE=$((CASE + 1)); SKIP=$((SKIP + 1)); printf "  SKIP  %-4s %-62s (%s)\n" "A$CASE" "$1" "$2"; }

# expect_error <label> <method> <url> <status> <code> [curl args...] — checks status, success=false, error.code,
# error.requestId == sent X-Request-Id == echoed X-Request-Id.
expect_error() {
  local label="$1" method="$2" url="$3" es="$4" ec="$5" st f echoed ok=1; shift 5
  st="$(call "$method" "$url" "$@")"
  f="$(jfields success error.code error.requestId)"; echoed="$(header X-Request-Id)"
  [ "$st" = "$es" ] || ok=0
  [ "$f" = "false|$ec|$(rid)" ] || ok=0
  [ "$echoed" = "$(rid)" ] || ok=0
  record "$label" "$method ${url#http://*/}" "$es $ec" "$st $(printf "%s" "$f" | cut -d'|' -f2)$([ "$echoed" = "$(rid)" ] || echo " rid-not-echoed")" "$ok"
}
# expect_principal <label> <method> <url> <status> <userId> <role> [curl args...]
expect_principal() {
  local label="$1" method="$2" url="$3" es="$4" eu="$5" er="$6" st f ok=1; shift 6
  st="$(call "$method" "$url" "$@")"
  f="$(jfields success data.userId data.role)"
  [ "$st" = "$es" ] || ok=0
  [ "$f" = "true|$eu|$er" ] || ok=0
  [ "$(header X-Request-Id)" = "$(rid)" ] || ok=0
  record "$label" "$method ${url#http://*/}" "$es $er" "$st $(printf "%s" "$f" | cut -d'|' -f3)" "$ok"
}
expect_status() { # expect_status <label> <method> <url> <status> [curl args...]
  local label="$1" method="$2" url="$3" es="$4" st; shift 4
  st="$(call "$method" "$url" "$@")"
  record "$label" "$method ${url#http://*/}" "$es" "$st" "$([ "$st" = "$es" ] && echo 1 || echo 0)"
}

isql() { psql "$IDENTITY_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
csql() { psql "$CARE_OWNER_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
log_line_for() { # log_line_for <file> <requestId> <message> → the JSON log line (or empty)
  [ -n "$1" ] && [ -f "$1" ] && { grep -F "\"requestId\":\"$2\"" "$1" | grep -F "\"message\":\"$3\"" | tail -1 || true; }
}
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v===undefined?"<undef>":String(v))}catch{process.stdout.write("<none>")}})' "$1"; }

# --- Identity: QA accounts and real tokens ----------------------------------------------------------------------
email_for() { printf "%s.%s@%s" "$QA_EMAIL_PREFIX" "$1" "$QA_EMAIL_DOMAIN"; }

wait_for_code() { # wait_for_code <email> <sinceIso> → 6-digit code (never printed by callers)
  local i code
  for i in $(seq 1 30); do
    if [ -f "$IDENTITY_MAIL_FILE" ]; then
      code="$(QA_TO="$1" QA_SINCE="$2" node -e '
        const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").reverse();
        for (const l of lines) { try { const m = JSON.parse(l);
          if (String(m.to).toLowerCase() === process.env.QA_TO.toLowerCase() && m.sentAt >= process.env.QA_SINCE) {
            const c = /code is (\d{6})/.exec(m.text); if (c) { process.stdout.write(c[1]); break; } } } catch {} }
      ' "$(nodepath "$IDENTITY_MAIL_FILE")")"
      if [ -n "$code" ]; then printf "%s" "$code"; return 0; fi
    fi
    pause 1
  done
  return 1
}

ensure_account() { # ensure_account <slug> <role patient|doctor> → user id
  local email id since st code
  email="$(email_for "$1")"
  id="$(isql "SELECT id FROM users WHERE email = '$email' AND deleted_at IS NULL")"
  if [ -n "$id" ]; then printf "%s" "$id"; return 0; fi
  since="$(node -e 'process.stdout.write(new Date(Date.now() - 2000).toISOString())')"
  st="$(curl -s -o /dev/null -w "%{http_code}" -X POST "$IDENTITY_URL/api/auth/register/start" \
        -H "Content-Type: application/json" -H "X-Request-Id: $(uuid)" -d "{\"email\":\"$email\"}")"
  [ "$st" = "202" ] || { echo "  register/start for the $1 account returned $st" >&2; return 1; }
  code="$(wait_for_code "$email" "$since")" || {
    echo "  no registration code for the $1 account in IDENTITY_MAIL_FILE — is Identity's worker running" \
         "(cd ../vcare-identity-api && npx tsx --env-file-if-exists=.env src/worker.ts)?" >&2; return 1; }
  st="$(QA_EMAIL="$email" QA_CODE="$code" QA_ROLE="$2" QA_NAME="QA Access ${1^}" node -e '
    process.stdout.write(JSON.stringify({ email: process.env.QA_EMAIL, code: process.env.QA_CODE,
      password: process.env.QA_PASSWORD, fullName: process.env.QA_NAME, role: process.env.QA_ROLE,
      timezone: "Africa/Cairo", locale: "en-EG" }))' | curl -s -o /dev/null -w "%{http_code}" -X POST \
      "$IDENTITY_URL/api/auth/register/complete" -H "Content-Type: application/json" -H "X-Request-Id: $(uuid)" \
      -H "Idempotency-Key: $(uuid)" --data-binary @-)"
  [ "$st" = "201" ] || { echo "  register/complete for the $1 account returned $st" >&2; return 1; }
  isql "SELECT id FROM users WHERE email = '$email' AND deleted_at IS NULL"
}

login() { # login <slug> → access token (stdout only; never written to a file)
  local email
  email="$(email_for "$1")"
  QA_EMAIL="$email" node -e 'process.stdout.write(JSON.stringify({ email: process.env.QA_EMAIL, password: process.env.QA_PASSWORD }))' \
    | curl -s -X POST "$IDENTITY_URL/api/auth/login" -H "Content-Type: application/json" -H "X-Request-Id: $(uuid)" --data-binary @- \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).data.accessToken;if(typeof t!=="string")throw 0;process.stdout.write(t)}catch{process.exit(1)}})'
}
set_state() { # set_state <slug> <role> <status> <verified true|false>
  local ev="now()"; [ "$4" = "true" ] || ev="NULL"
  isql "UPDATE users SET role = '$2', status = '$3', email_verified_at = $ev, updated_at = now() WHERE email = '$(email_for "$1")'" >/dev/null
}
export QA_PASSWORD

# ================================================================================================================
echo "=== 0. Preflight ==="
for target in "$CARE_URL/api/health/ready" "$IDENTITY_URL/api/health/ready"; do
  st="$(curl -s -o /dev/null -w "%{http_code}" "$target" || true)"
  [ "$st" = "200" ] || { echo "  $target → $st. Start it first (docs/access/manual-qa.md → Environment)."; exit 2; }
done
echo "  care harness and Identity reachable"

if ! curl -s -o /dev/null "$EDGE_URL/api/health/live" 2>/dev/null; then
  if [ "$START_EDGE" = "1" ]; then
    echo "  starting fake identity (${FAKE_IDENTITY_URL##*:}) and edge harness (${EDGE_URL##*:})"
    EDGE_LOG_FILE="${EDGE_LOG_FILE:-$TMP/edge.log}"
    ( cd "$REPO_DIR" && FAKE_IDENTITY_PORT="${FAKE_IDENTITY_URL##*:}" npx tsx scripts/access-qa-fake-identity.ts >"$TMP/fake.log" 2>&1 & )
    ( cd "$REPO_DIR" && PORT="${EDGE_URL##*:}" IDENTITY_JWKS_URL="$FAKE_IDENTITY_URL/.well-known/jwks.json" \
        npx tsx --env-file-if-exists=.env scripts/access-qa-server.ts >"$EDGE_LOG_FILE" 2>&1 & )
    STARTED_EDGE=1
    for i in $(seq 1 40); do curl -s "$EDGE_URL/api/health/ready" 2>/dev/null | grep -q '"identityJwks":"up"' && break; pause 1; done
  fi
fi
EDGE_UP=0
curl -s "$EDGE_URL/api/health/ready" 2>/dev/null | grep -q '"identityJwks":"up"' && EDGE_UP=1
echo "  edge harness: $([ "$EDGE_UP" = "1" ] && echo up || echo 'unavailable (edge cases skipped)')"

echo
echo "=== 1. Real Identity accounts and tokens (synthetic; ids only are printed) ==="
PATIENT_ID="$(ensure_account patient patient)"
DOCTOR_ID="$(ensure_account doctor doctor)"
ADMIN_ID="$(ensure_account admin patient)"
echo "  patient id=$PATIENT_ID doctor id=$DOCTOR_ID admin id=$ADMIN_ID"

set_state patient patient active true;   T_P="$(login patient)"
set_state patient patient active false;  T_PU="$(login patient)"
set_state patient patient pending true;  T_PP="$(login patient)"
set_state patient patient active true
set_state doctor doctor pending true;    T_DP="$(login doctor)"
set_state doctor doctor rejected true;   T_DR="$(login doctor)"
set_state doctor doctor active true;     T_DA="$(login doctor)"
set_state doctor doctor pending true     # back to the registration default
set_state admin admin active true;       T_A="$(login admin)"
for t in "$T_P" "$T_PU" "$T_PP" "$T_DP" "$T_DR" "$T_DA" "$T_A"; do remember "$t"; done
echo "  7 real tokens issued by Identity (patient active/unverified/pending, doctor pending/rejected/active, admin)"

C="$CARE_URL/api/__test/access"
echo
echo "=== 2. User guard on real Identity tokens (spec §3.3.6) ==="
expect_error     "no Authorization header"                    GET "$C/any" 401 Unauthorized
expect_error     "Basic scheme"                               GET "$C/any" 401 Unauthorized -H "Authorization: Basic cWE6cWE="
expect_error     "Bearer with empty token"                    GET "$C/any" 401 Unauthorized -H "Authorization: Bearer "
expect_error     "Bearer with two tokens"                     GET "$C/any" 401 Unauthorized -H "Authorization: Bearer a b"
expect_error     "malformed JWT (not-a-jwt)"                  GET "$C/any" 401 Unauthorized -H "Authorization: Bearer not-a-jwt"
expect_error     "malformed JWT (a.b.c)"                      GET "$C/any" 401 Unauthorized -H "Authorization: Bearer a.b.c"
TAMP="$(printf "%s" "$T_P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [h,p,g]=s.split(".");const c=JSON.parse(Buffer.from(p,"base64url"));c.role="admin";process.stdout.write(h+"."+Buffer.from(JSON.stringify(c)).toString("base64url")+"."+g)})')"
expect_error     "tampered real token (role→admin)"           GET "$C/admin" 401 Unauthorized -H "$(auth "$TAMP")"
expect_error     "real token + 4100 chars (over 4096)"        GET "$C/any" 401 Unauthorized -H "$(auth "${T_P}$(printf 'A%.0s' $(seq 1 4100))")"
expect_principal "real patient token"                         GET "$C/any" 200 "$PATIENT_ID" patient -H "$(auth "$T_P")"
expect_principal "real active doctor token"                   GET "$C/any" 200 "$DOCTOR_ID" doctor -H "$(auth "$T_DA")"
expect_principal "real admin token"                           GET "$C/any" 200 "$ADMIN_ID" admin -H "$(auth "$T_A")"
expect_principal "lower-case 'bearer' scheme accepted"        GET "$C/any" 200 "$PATIENT_ID" patient -H "authorization: bearer $T_P"
expect_principal "X-User-Id / X-Role headers ignored"         GET "$C/any" 200 "$PATIENT_ID" patient -H "$(auth "$T_P")" -H "X-User-Id: 999999" -H "X-Role: admin"
expect_error     "X-Role: admin does not unlock admin route"  GET "$C/admin" 403 Forbidden -H "$(auth "$T_P")" -H "X-Role: admin" -H "X-User-Id: $ADMIN_ID"
if [ "$EDGE_UP" = "1" ]; then
  T_FAKE="$(curl -s "$FAKE_IDENTITY_URL/mint?case=patient-101")"; remember "$T_FAKE"
  expect_error   "token from a foreign key (kid unknown to Identity)" GET "$C/any" 401 Unauthorized -H "$(auth "$T_FAKE")"
else skip "token from a foreign key (kid unknown to Identity)" "edge harness unavailable"; fi
st="$(curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: not-a-uuid" "$C/any" -w "%{http_code}")"
gen="$(header X-Request-Id)"
record "invalid X-Request-Id replaced by a generated UUID" "GET /api/__test/access/any" "401 + uuid" "$st $(printf "%s" "$gen" | grep -Eq '^[0-9a-f-]{36}$' && echo uuid || echo "$gen")" \
  "$([ "$st" = 401 ] && printf "%s" "$gen" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' && echo 1 || echo 0)"

echo
echo "=== 3. RBAC matrix on real tokens (spec §3.4.3, §9.3) ==="
# any — patient, doctor, admin; default status active
expect_principal "any: unverified patient (no email gate)"    GET "$C/any" 200 "$PATIENT_ID" patient -H "$(auth "$T_PU")"
expect_error     "any: pending patient"                       GET "$C/any" 403 Forbidden -H "$(auth "$T_PP")"
expect_error     "any: pending doctor (active required)"      GET "$C/any" 403 Forbidden -H "$(auth "$T_DP")"
expect_error     "any: rejected doctor"                       GET "$C/any" 403 Forbidden -H "$(auth "$T_DR")"
# admin
expect_error     "admin: no token"                            GET "$C/admin" 401 Unauthorized
expect_error     "admin: patient"                             GET "$C/admin" 403 Forbidden -H "$(auth "$T_P")"
expect_error     "admin: active doctor"                       GET "$C/admin" 403 Forbidden -H "$(auth "$T_DA")"
expect_principal "admin: admin"                               GET "$C/admin" 200 "$ADMIN_ID" admin -H "$(auth "$T_A")"
# onboarding — doctor pending|active|rejected
expect_error     "onboarding: no token"                       GET "$C/onboarding" 401 Unauthorized
expect_principal "onboarding: pending doctor"                 GET "$C/onboarding" 200 "$DOCTOR_ID" doctor -H "$(auth "$T_DP")"
expect_principal "onboarding: rejected doctor"                GET "$C/onboarding" 200 "$DOCTOR_ID" doctor -H "$(auth "$T_DR")"
expect_principal "onboarding: active doctor"                  GET "$C/onboarding" 200 "$DOCTOR_ID" doctor -H "$(auth "$T_DA")"
expect_error     "onboarding: patient"                        GET "$C/onboarding" 403 Forbidden -H "$(auth "$T_P")"
expect_error     "onboarding: admin"                          GET "$C/onboarding" 403 Forbidden -H "$(auth "$T_A")"
# verified — patient, emailVerified: true
expect_error     "verified: no token"                         POST "$C/verified" 401 Unauthorized
expect_principal "verified: verified patient"                 POST "$C/verified" 201 "$PATIENT_ID" patient -H "$(auth "$T_P")"
expect_error     "verified: unverified patient"               POST "$C/verified" 403 EmailNotVerified -H "$(auth "$T_PU")"
expect_error     "verified: pending patient (status before email)" POST "$C/verified" 403 Forbidden -H "$(auth "$T_PP")"
expect_error     "verified: active doctor"                    POST "$C/verified" 403 Forbidden -H "$(auth "$T_DA")"
expect_error     "verified: admin"                            POST "$C/verified" 403 Forbidden -H "$(auth "$T_A")"
# owned/:id — resource 1 → user 101, 2 → user 102 (real ids are neither)
expect_error     "owned/1: no token"                          GET "$C/owned/1" 401 Unauthorized
expect_error     "owned/1: patient non-owner → 404"           GET "$C/owned/1" 404 NotFound -H "$(auth "$T_P")"
expect_error     "owned/1: doctor non-owner → 403"            GET "$C/owned/1" 403 Forbidden -H "$(auth "$T_DA")"
expect_error     "owned/1: admin (role not listed)"           GET "$C/owned/1" 403 Forbidden -H "$(auth "$T_A")"
expect_error     "owned/999: unknown id"                      GET "$C/owned/999" 404 NotFound -H "$(auth "$T_P")"
expect_error     "owned/abc: non-numeric id"                  GET "$C/owned/abc" 404 NotFound -H "$(auth "$T_DA")"
expect_error     "owned/1: pending patient → 403 before ownership" GET "$C/owned/1" 403 Forbidden -H "$(auth "$T_PP")"
# checked — doctor/admin; check test_blocked_doctor applies to doctors (user 9001)
expect_principal "checked: active doctor (not blocked)"       GET "$C/checked" 200 "$DOCTOR_ID" doctor -H "$(auth "$T_DA")"
expect_principal "checked: admin"                             GET "$C/checked" 200 "$ADMIN_ID" admin -H "$(auth "$T_A")"
expect_error     "checked: patient"                           GET "$C/checked" 403 Forbidden -H "$(auth "$T_P")"
expect_error     "checked: pending doctor"                    GET "$C/checked" 403 Forbidden -H "$(auth "$T_DP")"
expect_error     "unknown test route (fail closed → 404)"     GET "$C/does-not-exist" 404 NotFound -H "$(auth "$T_A")"

if [ "$EDGE_UP" = "1" ]; then
  E="$EDGE_URL/api/__test/access"
  mint() { local t; t="$(curl -s "$FAKE_IDENTITY_URL/mint?case=$1")"; remember "$t"; printf "%s" "$t"; }
  echo
  echo "=== 4. Edge tokens (fake JWKS + minted claims, spec §3.3.5 / §3.3.6) ==="
  if [ "$SKIP_JWKS_GATE_CASES" != "1" ]; then
    echo "  waiting 61 s so the per-minute JWKS demand-fetch gate is open (JWKS_MIN_FETCH_INTERVAL_MS) ..."
    pause 61
    before="$(curl -s "$FAKE_IDENTITY_URL/stats" | json_field jwksRequests)"
    kid="qa-rot-$(date +%s)"; curl -s -o /dev/null -X POST "$FAKE_IDENTITY_URL/keys/add?kid=$kid"
    T_ROT="$(curl -s "$FAKE_IDENTITY_URL/mint?kid=$kid")"; remember "$T_ROT"
    expect_principal "rotation: token signed by a newly published kid" GET "$E/any" 200 101 patient -H "$(auth "$T_ROT")"
    after="$(curl -s "$FAKE_IDENTITY_URL/stats" | json_field jwksRequests)"
    record "rotation: exactly one extra JWKS fetch" "GET /.well-known/jwks.json" "+1" "+$((after - before))" "$([ $((after - before)) = 1 ] && echo 1 || echo 0)"
    expect_error   "unknown kid within the minute (gated)" GET "$E/any" 401 Unauthorized -H "$(auth "$(mint unknown-kid)")"
    final="$(curl -s "$FAKE_IDENTITY_URL/stats" | json_field jwksRequests)"
    record "unknown kid within the minute: no extra JWKS fetch" "GET /.well-known/jwks.json" "+0" "+$((final - after))" "$([ $((final - after)) = 0 ] && echo 1 || echo 0)"
  else
    skip "rotation / per-minute gate cases" "SKIP_JWKS_GATE_CASES=1"
    expect_error   "unknown kid" GET "$E/any" 401 Unauthorized -H "$(auth "$(mint unknown-kid)")"
  fi
  expect_error     "expired (exp 10 min ago)"                 GET "$E/any" 401 TokenExpired -H "$(auth "$(mint expired)")"
  expect_principal "expired 20 s ago (within 30 s tolerance)" GET "$E/any" 200 101 patient -H "$(auth "$(mint expired-within-tolerance)")"
  expect_error     "expired AND bad signature → Unauthorized" GET "$E/any" 401 Unauthorized -H "$(auth "$(mint expired-bad-signature)")"
  expect_error     "nbf 120 s in the future"                  GET "$E/any" 401 Unauthorized -H "$(auth "$(mint nbf-future)")"
  expect_principal "nbf 20 s in the future (tolerance)"       GET "$E/any" 200 101 patient -H "$(auth "$(mint nbf-within-tolerance)")"
  for c in wrong-aud wrong-iss typ-service no-sub no-exp no-iat no-jti sub-zero sub-nonnumeric sub-unsafe \
           role-bogus status-bogus ev-string jti-too-long no-kid tampered alg-none hs256 oversize; do
    expect_error   "edge token: $c"                          GET "$E/any" 401 Unauthorized -H "$(auth "$(mint "$c")")"
  done

  echo
  echo "=== 5. RBAC edge principals (minted status / ids) ==="
  expect_error     "any: suspended patient"                   GET "$E/any" 403 Forbidden -H "$(auth "$(mint patient-suspended)")"
  expect_error     "any: pending admin"                       GET "$E/any" 403 Forbidden -H "$(auth "$(mint admin-pending)")"
  expect_error     "onboarding: suspended doctor"             GET "$E/onboarding" 403 Forbidden -H "$(auth "$(mint doctor-suspended)")"
  expect_error     "verified: suspended patient → Forbidden"  POST "$E/verified" 403 Forbidden -H "$(auth "$(mint patient-suspended)")"
  expect_principal "owned/1: owner patient 101"               GET "$E/owned/1" 200 101 patient -H "$(auth "$(mint patient-101)")"
  expect_error     "owned/2: patient 101 non-owner → 404"     GET "$E/owned/2" 404 NotFound -H "$(auth "$(mint patient-101)")"
  expect_principal "owned/1: owner doctor 101"                GET "$E/owned/1" 200 101 doctor -H "$(auth "$(mint doctor-101)")"
  expect_error     "owned/2: doctor 101 non-owner → 403"      GET "$E/owned/2" 403 Forbidden -H "$(auth "$(mint doctor-101)")"
  expect_error     "owned/1: body ownerUserId=101 from patient 102 still 404" GET "$E/owned/1" 404 NotFound \
                   -H "$(auth "$(mint patient-102)")" -H "Content-Type: application/json" -d '{"ownerUserId":101}'
  expect_error     "owned/1: suspended patient → 403 before ownership" GET "$E/owned/1" 403 Forbidden -H "$(auth "$(mint patient-suspended)")"
  expect_error     "checked: doctor 9001 (blocked check)"     GET "$E/checked" 403 Forbidden -H "$(auth "$(mint doctor-9001)")"
  expect_principal "checked: admin 9001 (check not applicable)" GET "$E/checked" 200 9001 admin -H "$(auth "$(mint admin-9001)")"
  expect_principal "checked: doctor 201"                      GET "$E/checked" 200 201 doctor -H "$(auth "$(mint doctor-201)")"
fi

echo
echo "=== 6. Audit write (spec §3.5; POST /api/__test/audit) ==="
A="$CARE_URL/api/__test/audit"
PARTITION="audit_logs_y$(date -u +%Y)m$(date -u +%m)"
expect_error     "audit: no token"                            POST "$A" 401 Unauthorized -H "Content-Type: application/json" -d '{}'
expect_error     "audit: patient"                             POST "$A" 403 Forbidden -H "$(auth "$T_P")" -H "Content-Type: application/json" -d '{}'
st="$(call POST "$A" -H "$(auth "$T_A")" -H "Content-Type: application/json" -d '{}')"; R1="$(rid)"
record "audit: admin commit → 201" "POST /api/__test/audit" "201 recorded=true" "$st recorded=$(jfields data.recorded)" "$([ "$st" = 201 ] && [ "$(jfields data.recorded)" = true ] && echo 1 || echo 0)"
row="$(csql "SELECT actor_user_id||'|'||actor_role||'|'||action||'|'||entity_type||'|'||entity_id||'|'||metadata::text||'|'||tableoid::regclass FROM audit_logs WHERE request_id = '$R1'")"
exp="$ADMIN_ID|admin|test.performed|test_entity|1|{\"reason\": \"synthetic\"}|$PARTITION"
record "audit: row actor/action/entity/metadata/partition" "SELECT … audit_logs WHERE request_id=<rid>" "$exp" "$row" "$([ "$row" = "$exp" ] && echo 1 || echo 0)"
n="$(csql "SELECT count(*) FROM audit_logs WHERE request_id = '$R1'")"
record "audit: exactly one row for the request id" "SELECT count(*)" "1" "$n" "$([ "$n" = 1 ] && echo 1 || echo 0)"
expect_error     "audit: rollback (fail=true) → 500"          POST "$A" 500 InternalError -H "$(auth "$T_A")" -H "Content-Type: application/json" -d '{"fail":true}'
n="$(csql "SELECT count(*) FROM audit_logs WHERE request_id = '$(rid)'")"
record "audit: rollback leaves no row" "SELECT count(*)" "0" "$n" "$([ "$n" = 0 ] && echo 1 || echo 0)"
expect_error     "audit: clinical key in metadata → 500"      POST "$A" 500 InternalError -H "$(auth "$T_A")" -H "Content-Type: application/json" -d '{"invalid":true}'
n="$(csql "SELECT count(*) FROM audit_logs WHERE request_id = '$(rid)'")"
record "audit: invalid metadata leaves no row" "SELECT count(*)" "0" "$n" "$([ "$n" = 0 ] && echo 1 || echo 0)"
n="$(csql "SELECT count(*) FROM audit_logs WHERE metadata::text LIKE '%SYNTHETIC-COMPLAINT%'")"
record "audit: no clinical fixture in any row" "SELECT count(*)" "0" "$n" "$([ "$n" = 0 ] && echo 1 || echo 0)"

echo
echo "=== 7. Regression #5 — malformed percent-encoding in :param (spec §12.1) ==="
P="$CARE_URL/api/__test/params"
st="$(call GET "$P/%E0%A4%A" -H "$(auth "$T_P")")"; R5="$(rid)"
f="$(jfields success error.code error.requestId error.details.0.field)"
record "params/%E0%A4%A with token → 400 ValidationFailed (path)" "GET /api/__test/params/%E0%A4%A" "400 ValidationFailed path" "$st $(printf "%s" "$f" | cut -d'|' -f2,4)" \
  "$([ "$st" = 400 ] && [ "$f" = "false|ValidationFailed|$R5|path" ] && echo 1 || echo 0)"
st="$(call GET "$P/%E0%A4%A")"; f="$(jfields error.code)"
record "params/%E0%A4%A without token → handled 4xx, never 500" "GET /api/__test/params/%E0%A4%A" "400|401 (not 500)" "$st $f" "$([ "$st" = 400 ] || [ "$st" = 401 ] && echo 1 || echo 0)"
expect_status    "params/ok-value with patient token"         GET "$P/ok-value" 200 -H "$(auth "$T_P")"
if [ -n "$CARE_LOG_FILE" ] && [ -f "$CARE_LOG_FILE" ]; then
  n="$(grep -cF '%E0%A4%A' "$CARE_LOG_FILE" || true)"; u="$(grep -F "\"requestId\":\"$R5\"" "$CARE_LOG_FILE" | grep -cF unhandled_error || true)"
  record "#5 logs: no raw value, no unhandled_error" "grep CARE_LOG_FILE" "0/0" "$n/$u" "$([ "$n" = 0 ] && [ "$u" = 0 ] && echo 1 || echo 0)"
else skip "#5 logs: no raw value, no unhandled_error" "CARE_LOG_FILE not set"; fi

echo
echo "=== 8. Regression #6 — route label keeps the mount prefix (spec §12.2) ==="
N="$CARE_URL/api/__test/nested"
expect_error     "nested/inner/boom/42 → 500 InternalError"   GET "$N/inner/boom/42" 500 InternalError; R6A="$(rid)"
expect_error     "nested/guarded/boom/42 admin → 500"         GET "$N/guarded/boom/42" 500 InternalError -H "$(auth "$T_A")"; R6B="$(rid)"
expect_error     "nested/guarded/boom/42 patient → 403"       GET "$N/guarded/boom/42" 403 Forbidden -H "$(auth "$T_P")"; R6C="$(rid)"
if [ -n "$CARE_LOG_FILE" ] && [ -f "$CARE_LOG_FILE" ]; then
  pause 1
  for pair in "$R6A|/api/__test/nested/inner/boom/:id" "$R6B|/api/__test/nested/guarded/boom/:id" "$R6C|/api/__test/nested/guarded/boom/:id"; do
    r="${pair%%|*}"; want="${pair#*|}"
    got="$(log_line_for "$CARE_LOG_FILE" "$r" request_completed | json_field route)"
    record "#6 request_completed.route" "log line for X-Request-Id" "$want" "$got" "$([ "$got" = "$want" ] && echo 1 || echo 0)"
  done
  got="$(log_line_for "$CARE_LOG_FILE" "$R1" request_completed | json_field userId)"
  record "request_completed carries userId from the guard" "log line (audit commit)" "$ADMIN_ID" "$got" "$([ "$got" = "$ADMIN_ID" ] && echo 1 || echo 0)"
else skip "#6 request_completed.route checks" "CARE_LOG_FILE not set"; fi

echo
echo "=== 9. Idempotency (CLAUDE.md → API conventions) and regression #11 (spec §12.4) ==="
I="$CARE_URL/api/__test/idem"
J='Content-Type: application/json'
expect_error     "idem: missing Idempotency-Key (required)"   POST "$I" 400 ValidationFailed -H "$J" -d '{"a":1}'
expect_error     "idem: non-UUID Idempotency-Key"             POST "$I" 400 ValidationFailed -H "$J" -H "Idempotency-Key: nope" -d '{"a":1}'
K1="$(uuid)"
st="$(call POST "$I" -H "$J" -H "Idempotency-Key: $K1" -d '{"a":1}')"; first="$(jfields data)"
record "idem: first call → 201" "POST /api/__test/idem" "201" "$st" "$([ "$st" = 201 ] && echo 1 || echo 0)"
st="$(call POST "$I" -H "$J" -H "Idempotency-Key: $K1" -d '{"a":1}')"; second="$(jfields data)"
record "idem: replay same key+body → same 201 body (handler not re-run)" "POST /api/__test/idem" "201 $first" "$st $second" "$([ "$st" = 201 ] && [ "$first" = "$second" ] && echo 1 || echo 0)"
expect_error     "idem: same key, different body → 422"       POST "$I" 422 IdempotencyConflict -H "$J" -H "Idempotency-Key: $K1" -d '{"a":2}'
K2="$(uuid)"
curl -s -o /dev/null -X POST "$I?delayMs=2500" -H "$J" -H "Idempotency-Key: $K2" -H "X-Request-Id: $(uuid)" -d '{"b":1}' &
BG=$!
pause 1
expect_error     "idem: same key while first in flight → 409" POST "$I" 409 Conflict -H "$J" -H "Idempotency-Key: $K2" -d '{"b":1}'
ra="$(header Retry-After)"
record "idem: in-flight 409 carries Retry-After: 1" "header" "1" "$ra" "$([ "$ra" = 1 ] && echo 1 || echo 0)"
wait "$BG" || true
expect_status    "idem: after the first finished → replay 201" POST "$I" 201 -H "$J" -H "Idempotency-Key: $K2" -d '{"b":1}'
K5="$(uuid)"
expect_error     "idem-invalid: stored 400"                   POST "$CARE_URL/api/__test/idem-invalid" 400 ValidationFailed -H "$J" -H "Idempotency-Key: $K5" -d '{}'
expect_error     "idem-invalid: replayed 400 carries the NEW request id" POST "$CARE_URL/api/__test/idem-invalid" 400 ValidationFailed -H "$J" -H "Idempotency-Key: $K5" -d '{}'
K6="$(uuid)"
st1="$(call POST "$CARE_URL/api/__test/idem-flaky" -H "$J" -H "Idempotency-Key: $K6" -d '{}')"
st2="$(call POST "$CARE_URL/api/__test/idem-flaky" -H "$J" -H "Idempotency-Key: $K6" -d '{}')"
record "idem-flaky: 5xx releases the lock, retry → 201" "POST /api/__test/idem-flaky ×2" "500→201 (fresh server) or 201→201" "$st1→$st2" \
  "$([ "$st2" = 201 ] && { [ "$st1" = 500 ] || [ "$st1" = 201 ]; } && echo 1 || echo 0)"
K7="$(uuid)"
expect_status    "idem-empty: 204"                            POST "$CARE_URL/api/__test/idem-empty" 204 -H "$J" -H "Idempotency-Key: $K7" -d '{}'
expect_status    "idem-empty: replay 204"                     POST "$CARE_URL/api/__test/idem-empty" 204 -H "$J" -H "Idempotency-Key: $K7" -d '{}'
# authenticated principal: the store key is scoped to user:<id>
K8="$(uuid)"
expect_principal "verified + Idempotency-Key: first 201"      POST "$C/verified" 201 "$PATIENT_ID" patient -H "$(auth "$T_P")" -H "$J" -H "Idempotency-Key: $K8" -d '{"x":1}'
expect_principal "verified + same key: replay 201"            POST "$C/verified" 201 "$PATIENT_ID" patient -H "$(auth "$T_P")" -H "$J" -H "Idempotency-Key: $K8" -d '{"x":1}'
expect_error     "verified + same key, different body → 422"  POST "$C/verified" 422 IdempotencyConflict -H "$(auth "$T_P")" -H "$J" -H "Idempotency-Key: $K8" -d '{"x":2}'
if [ -n "$REDIS_CLI" ]; then
  found="$("$REDIS_CLI" -n "$CARE_REDIS_DB" EXISTS "idem:POST /api/__test/access/verified:user:$PATIENT_ID:$K8" | tr -d '\r')"
  record "idempotency principal is user:<id> (Redis key)" "EXISTS idem:POST …:user:<id>:<key>" "1" "$found" "$([ "$found" = 1 ] && echo 1 || echo 0)"
  # #11: malformed records under the computed key must not crash the process
  for variant in done-without-status garbage; do
    K="$(uuid)"
    if [ "$variant" = garbage ]; then val="garbage"; else val='{"state":"done","bodyHash":"0000000000000000000000000000000000000000000000000000000000000000"}'; fi
    "$REDIS_CLI" -n "$CARE_REDIS_DB" SET "idem:POST /api/__test/idem:ip:127.0.0.1:$K" "$val" PX 60000 >/dev/null
    st="$(call POST "$I" -H "$J" -H "Idempotency-Key: $K" -d '{"c":1}')"; d1="$(jfields data)"
    record "#11 $variant record → handler runs (201)" "POST /api/__test/idem" "201" "$st" "$([ "$st" = 201 ] && echo 1 || echo 0)"
    st="$(curl -s -o /dev/null -w "%{http_code}" "$CARE_URL/api/health/live")"
    record "#11 $variant: process still alive" "GET /api/health/live" "200" "$st" "$([ "$st" = 200 ] && echo 1 || echo 0)"
    # spec §12.4: the invalid record is deleted and the handler runs WITHOUT storing; the next request with the same
    # key stores (handler runs again), and the one after that replays it.
    st="$(call POST "$I" -H "$J" -H "Idempotency-Key: $K" -d '{"c":1}')"; d2="$(jfields data)"
    st3="$(call POST "$I" -H "$J" -H "Idempotency-Key: $K" -d '{"c":1}')"; d3="$(jfields data)"
    record "#11 $variant: 2nd request stores, 3rd replays it" "POST /api/__test/idem ×2" "201 new run → 201 same body" \
      "$st $([ "$d1" = "$d2" ] && echo same-as-1st || echo new-run) → $st3 $([ "$d2" = "$d3" ] && echo replayed || echo different)" \
      "$([ "$st" = 201 ] && [ "$st3" = 201 ] && [ "$d1" != "$d2" ] && [ "$d2" = "$d3" ] && echo 1 || echo 0)"
  done
  if [ -n "$CARE_LOG_FILE" ] && [ -f "$CARE_LOG_FILE" ]; then
    n="$(grep -cF idempotency_record_invalid "$CARE_LOG_FILE" || true)"; u="$(grep -cE 'unhandledRejection|uncaughtException|process_crash' "$CARE_LOG_FILE" || true)"
    record "#11 logs: idempotency_record_invalid, no unhandled rejection" "grep CARE_LOG_FILE" ">=2 / 0" "$n / $u" "$([ "$n" -ge 2 ] && [ "$u" = 0 ] && echo 1 || echo 0)"
  fi
else skip "#11 malformed idempotency records" "no redis-cli / memurai-cli"; fi
if [ "$EDGE_UP" = "1" ]; then
  K9="$(uuid)"
  expect_principal "same key, user 101 → 201"                 POST "$E/verified" 201 101 patient -H "$(auth "$(mint patient-101)")" -H "$J" -H "Idempotency-Key: $K9" -d '{"y":1}'
  expect_principal "same key, user 102 → own 201 (not a replay of 101)" POST "$E/verified" 201 102 patient -H "$(auth "$(mint patient-102)")" -H "$J" -H "Idempotency-Key: $K9" -d '{"y":1}'
fi

echo
echo "=== 10. Rate limit (sliding window, 3 per 1 s per IP on /api/__test/limited) ==="
pause 1
# One curl process for the first three and one for the fourth: spawning node per request would stretch the
# four calls past the 1 s window.
R="$(uuid)"; printf "%s" "$R" > "$TMP/rid"
LIM="$CARE_URL/api/__test/limited"
s="$(curl -s -w "%{http_code} " -H "X-Request-Id: $R" -o /dev/null "$LIM" -o /dev/null "$LIM" -o /dev/null "$LIM")"
st="$(curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: $R" "$CARE_URL/api/__test/limited" -w "%{http_code}")"
f="$(jfields success error.code error.requestId)"
record "4th request inside the window → 429 RateLimited" "GET /api/__test/limited" "429 RateLimited" "$st $(printf "%s" "$f" | cut -d'|' -f2)" \
  "$([ "$st" = 429 ] && [ "$f" = "false|RateLimited|$R" ] && [ "$(header X-Request-Id)" = "$R" ] && echo 1 || echo 0)"
ra="$(header Retry-After)"
record "429 carries Retry-After; first three 200" "GET /api/__test/limited ×4" "200 200 200 + Retry-After" "${s}+ Retry-After=$ra" \
  "$([ "$s" = "200 200 200 " ] && [ -n "$ra" ] && echo 1 || echo 0)"

echo
echo "=== 11. Health — checks.identityJwks (contract C1) ==="
st="$(call GET "$CARE_URL/api/health/ready")"; f="$(jfields status checks.database checks.redis checks.identityJwks)"
record "ready: 200, identityJwks=$EXPECT_IDENTITY_JWKS, not enveloped" "GET /api/health/ready" "200 ok|up|up|$EXPECT_IDENTITY_JWKS" "$st $f" \
  "$([ "$st" = 200 ] && [ "$f" = "ok|up|up|$EXPECT_IDENTITY_JWKS" ] && echo 1 || echo 0)"
cc="$(header Cache-Control)"; echoed="$(header X-Request-Id)"
record "ready: X-Request-Id echoed, Cache-Control no-store" "headers" "echo + no-store" "$([ "$echoed" = "$(rid)" ] && echo echo || echo none) + $cc" \
  "$([ "$echoed" = "$(rid)" ] && [ "$cc" = no-store ] && echo 1 || echo 0)"
expect_status    "live: 200"                                  GET "$CARE_URL/api/health/live" 200

echo
echo "=== 12. Log hygiene (tokens, Authorization, PII, clinical fixture) ==="
for lf in "$CARE_LOG_FILE" "$EDGE_LOG_FILE"; do
  [ -n "$lf" ] && [ -f "$lf" ] || continue
  leaks=0
  for sig in "${TOKEN_SIGS[@]}"; do [ -n "$sig" ] && grep -qF "$sig" "$lf" && leaks=$((leaks + 1)); done
  bearer="$(grep -ciE 'bearer |"authorization"' "$lf" || true)"
  pii="$(grep -ciE "$QA_EMAIL_PREFIX|@$QA_EMAIL_DOMAIN|SYNTHETIC-COMPLAINT|password" "$lf" || true)"
  record "log $(basename "$lf"): token signatures / Authorization / PII" "grep" "0 / 0 / 0" "$leaks / $bearer / $pii" \
    "$([ "$leaks" = 0 ] && [ "$bearer" = 0 ] && [ "$pii" = 0 ] && echo 1 || echo 0)"
done

echo
echo "=== Result: $PASS pass / $FAIL fail / $SKIP skipped ($CASE cases) ==="
[ "$FAIL" = 0 ]
