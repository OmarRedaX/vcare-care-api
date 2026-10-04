#!/usr/bin/env bash
# Manual QA for the `specialties` module of care-service (docs/specialties/manual-qa.md; spec §9.2, §9.5).
#
# Exercises GET/POST/PATCH /api/specialties on the REAL public app (CARE_URL) with REAL tokens issued by a running
# local Identity, then repeats the #8 query/body-conversion checks against the COMPILED build (npm run build →
# node dist/server.js on COMPILED_URL), which this script builds and starts when it is not already reachable.
#
# Usage (Git Bash on Windows, or any POSIX bash):
#   QA_PASSWORD='<synthetic password>' IDENTITY_DATABASE_URL='postgres://…/vcare_identity' ./scripts/curl-test-specialties.sh
#
# Prerequisites:
#   - Identity running (IDENTITY_URL) and, on the FIRST run, its worker (registration codes are delivered to the capture
#     mailbox IDENTITY_MAIL_FILE, EMAIL_PROVIDER=capture).
#   - Care api running at CARE_URL with IDENTITY_JWKS_URL → that Identity, migrations applied (incl. specialties + seed).
#   - psql and redis-cli (or memurai-cli) on PATH; Care's .env readable (MIGRATION_DATABASE_URL owner URL).
#
# Environment (no secret has a default; nothing below is ever printed or written to a file):
#   QA_PASSWORD             required — password of the synthetic QA accounts (created on first run)
#   IDENTITY_DATABASE_URL   required — Identity's DB: promotes the admin and sets status variants before each login
#   CARE_OWNER_DATABASE_URL Care owner URL for audit_logs / specialties assertions (default: MIGRATION_DATABASE_URL in .env)
#   CARE_URL (http://localhost:3001) · IDENTITY_URL (http://localhost:3020) · COMPILED_URL (http://localhost:3011)
#   IDENTITY_MAIL_FILE (<repo>/../vcare-identity-api/.local/mail/outbox.jsonl) · QA_EMAIL_DOMAIN (example.test)
#   EDGE_URL (http://localhost:3012) · FAKE_IDENTITY_URL (http://127.0.0.1:3021) · START_EDGE (1) — a second care api from
#   source verifying tokens from scripts/access-qa-fake-identity.ts (suspended principals Identity will not log in)
#   QA_EMAIL_PREFIX (qa.specialties) · CARE_LOG_FILE (enables log-hygiene checks) · START_COMPILED (1)
#   REDIS_CLI · CARE_REDIS_DB (1) — resets the rate-limit keys rl:specialties-list-* between sections
#
# Idempotent: accounts are created once and reused; every run creates its own uniquely named specialties (RUN id)
# and deactivates them at the end; every request uses fresh UUIDs. Login is limited by Identity to 5/min per IP+email.
# Exit code: 0 when every case passes, 1 otherwise (2 when a prerequisite is missing).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CARE_URL="${CARE_URL:-http://localhost:3001}"
COMPILED_URL="${COMPILED_URL:-http://localhost:3011}"
EDGE_URL="${EDGE_URL:-http://localhost:3012}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
START_EDGE="${START_EDGE:-1}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:3020}"
IDENTITY_MAIL_FILE="${IDENTITY_MAIL_FILE:-$REPO_DIR/../vcare-identity-api/.local/mail/outbox.jsonl}"
QA_EMAIL_DOMAIN="${QA_EMAIL_DOMAIN:-example.test}"
QA_EMAIL_PREFIX="${QA_EMAIL_PREFIX:-qa.specialties}"
CARE_LOG_FILE="${CARE_LOG_FILE:-}"
CARE_REDIS_DB="${CARE_REDIS_DB:-1}"
START_COMPILED="${START_COMPILED:-1}"

: "${QA_PASSWORD:?QA_PASSWORD is required (synthetic password of the QA accounts)}"
: "${IDENTITY_DATABASE_URL:?IDENTITY_DATABASE_URL is required (Identity DB, for QA account variants)}"
if [ -z "${CARE_OWNER_DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  CARE_OWNER_DATABASE_URL="$(grep -E '^MIGRATION_DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
: "${CARE_OWNER_DATABASE_URL:?CARE_OWNER_DATABASE_URL (or MIGRATION_DATABASE_URL in .env) is required}"
if [ -z "${REDIS_CLI:-}" ]; then
  if command -v redis-cli >/dev/null 2>&1; then REDIS_CLI=redis-cli; elif command -v memurai-cli >/dev/null 2>&1; then REDIS_CLI=memurai-cli; else REDIS_CLI=""; fi
fi
: "${REDIS_CLI:?redis-cli or memurai-cli is required (rate-limit key reset between sections)}"

PASS=0; FAIL=0; SKIP=0; CASE=0
TMP="$(mktemp -d)"
printf "0" > "$TMP/gcount"
STARTED_COMPILED=0
STARTED_EDGE=0
RUN="$(date +%s)"
CREATED_IDS=()
TOKEN_SIGS=()   # signature segments of every token used — only in memory, for the log-hygiene check

nodepath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
uuid() { node -e "process.stdout.write(require('node:crypto').randomUUID())"; }
pause() { ping -n "$(( $1 + 1 ))" 127.0.0.1 >/dev/null 2>&1 || sleep "$1"; }
longstr() { node -e "process.stdout.write(process.argv[1].repeat(Number(process.argv[2])))" "$1" "$2"; }

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

isql() { psql "$IDENTITY_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
csql() { psql "$CARE_OWNER_DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
rcli() { "$REDIS_CLI" -n "$CARE_REDIS_DB" "$@" | tr -d '\r'; }

deactivate_created() {
  # Leave the catalog as found: every row this run created is deactivated (the table is never deleted from).
  local id
  for id in "${CREATED_IDS[@]:-}"; do [ -n "$id" ] && csql "UPDATE specialties SET is_active = false WHERE id = $id" >/dev/null 2>&1 || true; done
}
on_exit() {
  local rc=$?
  deactivate_created
  if [ "$STARTED_COMPILED" = "1" ]; then
    echo; echo "=== EXIT: stopping the compiled build started by this run (port ${COMPILED_URL##*:}) ==="
    kill_port "${COMPILED_URL##*:}"
  fi
  if [ "$STARTED_EDGE" = "1" ]; then
    echo; echo "=== EXIT: stopping the edge care api and fake identity started by this run ==="
    kill_port "${EDGE_URL##*:}"; kill_port "${FAKE_IDENTITY_URL##*:}"
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

reset_rl() { # drop the specialties GET limiter keys so the per-IP 60/min never skews unrelated cases
  local k
  for k in $(rcli KEYS 'rl:specialties-list-*'); do rcli DEL "$k" >/dev/null; done
  printf "0" > "$TMP/gcount"
}

# --- HTTP + assertions ------------------------------------------------------------------------------------------
# call <method> <url> [curl args...] → status; body/headers in $TMP, sent X-Request-Id in $TMP/rid
call() {
  local method="$1" url="$2" r; shift 2
  if [ "$method" = GET ] && [[ "$url" == */api/specialties* ]]; then
    GCOUNT=$(( $(cat "$TMP/gcount" 2>/dev/null || echo 0) + 1 )); printf "%s" "$GCOUNT" > "$TMP/gcount"
    if [ "$GCOUNT" -ge 40 ]; then reset_rl; fi
  fi
  r="$(uuid)"; printf "%s" "$r" > "$TMP/rid"
  curl -s -o "$TMP/body" -D "$TMP/headers" -X "$method" -H "X-Request-Id: $r" "$@" "$url" -w "%{http_code}" || true
}
rid() { cat "$TMP/rid"; }
header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
# jfields <path>... → values of the last JSON body joined by "|" (<undef> when absent, <non-json> when unparsable)
jfields() {
  node -e '
    const fs = require("fs"); let b;
    try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("<non-json>"); process.exit(0); }
    const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
    process.stdout.write(process.argv.slice(2).map((p) => { const v = get(b, p);
      return v === undefined ? "<undef>" : typeof v === "object" ? JSON.stringify(v) : String(v); }).join("|"));
  ' "$(nodepath "$TMP/body")" "$@"
}
# ids_of → comma-separated data[].id of the last body ("" when none); keys_of <path> → sorted keys of that object
ids_of() { node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((Array.isArray(b.data)?b.data:[]).map(r=>r.id).join(","))}catch{process.stdout.write("<non-json>")}' "$(nodepath "$TMP/body")"; }
names_sorted_ok() { # data[].name strictly follows the (name,id) order the database reports for the same ids
  node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(b.data.map(r=>r.name).join("\n"))}catch{}' "$(nodepath "$TMP/body")"
}
data_keys() { node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=Array.isArray(b.data)?b.data[0]:b.data;process.stdout.write(Object.keys(d).sort().join(","))}catch{process.stdout.write("<none>")}' "$(nodepath "$TMP/body")"; }
auth() { printf "Authorization: Bearer %s" "$1"; }
remember() { TOKEN_SIGS+=("${1##*.}"); }
SPEC_KEYS="createdAt,description,id,isActive,name,slug,updatedAt"

record() { # record <label> <request> <expected> <got> <ok 0|1>
  CASE=$((CASE + 1))
  if [ "$5" = "1" ]; then PASS=$((PASS + 1)); printf "  PASS  %-4s %-66s exp=[%s] got=[%s]  (%s)\n" "S$CASE" "$1" "$3" "$4" "$2"
  else FAIL=$((FAIL + 1)); printf "  FAIL  %-4s %-66s exp=[%s] got=[%s]  (%s)\n" "S$CASE" "$1" "$3" "$4" "$2"; fi
}
skip() { CASE=$((CASE + 1)); SKIP=$((SKIP + 1)); printf "  SKIP  %-4s %-66s (%s)\n" "S$CASE" "$1" "$2"; }
short() { printf "%s" "${1#http://*/}" | cut -c1-70; }

# expect_error <label> <method> <url> <status> <code> [curl args...] — status, success=false, error.code,
# error.requestId == sent X-Request-Id == echoed X-Request-Id.
expect_error() {
  local label="$1" method="$2" url="$3" es="$4" ec="$5" st f echoed ok=1; shift 5
  st="$(call "$method" "$url" "$@")"
  f="$(jfields success error.code error.requestId)"; echoed="$(header X-Request-Id)"
  [ "$st" = "$es" ] || ok=0
  [ "$f" = "false|$ec|$(rid)" ] || ok=0
  [ "$echoed" = "$(rid)" ] || ok=0
  record "$label" "$method $(short "$url")" "$es $ec" "$st $(printf "%s" "$f" | cut -d'|' -f2)$([ "$echoed" = "$(rid)" ] || echo " rid-not-echoed")" "$ok"
}
# expect_ok <label> <method> <url> <status> [curl args...] — status, success=true, X-Request-Id echoed, data key set
expect_ok() {
  local label="$1" method="$2" url="$3" es="$4" st ok=1 k; shift 4
  st="$(call "$method" "$url" "$@")"
  [ "$st" = "$es" ] || ok=0
  [ "$(jfields success)" = "true" ] || ok=0
  [ "$(header X-Request-Id)" = "$(rid)" ] || ok=0
  k="$(data_keys)"; [ "$k" = "$SPEC_KEYS" ] || ok=0
  record "$label" "$method $(short "$url")" "$es success keys" "$st $(jfields success) $k" "$ok"
}
expect_status() { # expect_status <label> <method> <url> <status> [curl args...]
  local label="$1" method="$2" url="$3" es="$4" st; shift 4
  st="$(call "$method" "$url" "$@")"
  record "$label" "$method $(short "$url")" "$es" "$st" "$([ "$st" = "$es" ] && echo 1 || echo 0)"
}
expect_field() { # expect_field <label> <json path> <expected> — checks the LAST body
  local got; got="$(jfields "$2")"
  record "$1" "body $2" "$3" "$got" "$([ "$got" = "$3" ] && echo 1 || echo 0)"
}
expect_val() { # expect_val <label> <what> <expected> <got>
  record "$1" "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"
}

# --- Identity: QA accounts and real tokens ----------------------------------------------------------------------
email_for() { printf "%s.%s@%s" "$QA_EMAIL_PREFIX" "$1" "$QA_EMAIL_DOMAIN"; }
wait_for_code() {
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
    echo "  no registration code for the $1 account in IDENTITY_MAIL_FILE — is Identity's worker running?" >&2; return 1; }
  st="$(QA_EMAIL="$email" QA_CODE="$code" QA_ROLE="$2" QA_NAME="QA Specialties ${1^}" node -e '
    process.stdout.write(JSON.stringify({ email: process.env.QA_EMAIL, code: process.env.QA_CODE,
      password: process.env.QA_PASSWORD, fullName: process.env.QA_NAME, role: process.env.QA_ROLE,
      timezone: "Africa/Cairo", locale: "en-EG" }))' | curl -s -o /dev/null -w "%{http_code}" -X POST \
      "$IDENTITY_URL/api/auth/register/complete" -H "Content-Type: application/json" -H "X-Request-Id: $(uuid)" \
      -H "Idempotency-Key: $(uuid)" --data-binary @-)"
  [ "$st" = "201" ] || { echo "  register/complete for the $1 account returned $st" >&2; return 1; }
  isql "SELECT id FROM users WHERE email = '$email' AND deleted_at IS NULL"
}
login() { # login <slug> → access token (stdout only; never written to a file)
  QA_EMAIL="$(email_for "$1")" node -e 'process.stdout.write(JSON.stringify({ email: process.env.QA_EMAIL, password: process.env.QA_PASSWORD }))' \
    | curl -s -X POST "$IDENTITY_URL/api/auth/login" -H "Content-Type: application/json" -H "X-Request-Id: $(uuid)" --data-binary @- \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).data.accessToken;if(typeof t!=="string")throw 0;process.stdout.write(t)}catch{process.exit(1)}})'
}
set_state() { # set_state <slug> <role> <status> <verified true|false>
  local ev="now()"; [ "$4" = "true" ] || ev="NULL"
  isql "UPDATE users SET role = '$2', status = '$3', email_verified_at = $ev, updated_at = now() WHERE email = '$(email_for "$1")'" >/dev/null
}
token_for() { # token_for <slug> <role> <status> <verified> → token or empty (Identity may refuse the login)
  local t; set_state "$1" "$2" "$3" "$4"; t="$(login "$1")" || t=""; [ -n "$t" ] && remember "$t"; printf "%s" "$t"
}
export QA_PASSWORD

# ================================================================================================================
echo "=== 0. Preflight ==="
for target in "$CARE_URL/api/health/ready" "$IDENTITY_URL/api/health/ready"; do
  st="$(curl -s -o /dev/null -w "%{http_code}" "$target" || true)"
  [ "$st" = "200" ] || { echo "  $target → $st. Start it first (docs/specialties/manual-qa.md → Environment)."; exit 2; }
done
echo "  care api and Identity reachable"
seed_n="$(csql "SELECT count(*) FROM specialties WHERE slug IN ('allergy-immunology','cardiology','dermatology','endocrinology','family-medicine','gastroenterology','general-practice','infectious-diseases','internal-medicine','nephrology','neurology','obstetrics-gynecology','ophthalmology','orthopedics','otolaryngology','pediatrics','psychiatry','pulmonology','rheumatology','urology')")"
expect_val "seed catalog: 20 starter slugs present (owner query)" "SELECT count(*) FROM specialties" 20 "$seed_n"
reset_rl
EDGE_UP=0
if ! curl -s -o /dev/null "$EDGE_URL/api/health/live" 2>/dev/null && [ "$START_EDGE" = "1" ]; then
  echo "  starting fake identity (${FAKE_IDENTITY_URL##*:}) and an edge care api (${EDGE_URL##*:}) from source"
  ( cd "$REPO_DIR" && FAKE_IDENTITY_PORT="${FAKE_IDENTITY_URL##*:}" npx tsx scripts/access-qa-fake-identity.ts >"$TMP/fake.log" 2>&1 & )
  ( cd "$REPO_DIR" && PORT="${EDGE_URL##*:}" INTERNAL_PORT="$(( ${EDGE_URL##*:} + 100 ))" IDENTITY_JWKS_URL="$FAKE_IDENTITY_URL/.well-known/jwks.json"       npx tsx --env-file-if-exists=.env src/server.ts >"$TMP/edge.log" 2>&1 & )
  STARTED_EDGE=1
  for _ in $(seq 1 40); do curl -s -o /dev/null "$EDGE_URL/api/health/live" 2>/dev/null && break; pause 1; done
fi
curl -s -o /dev/null "$EDGE_URL/api/health/live" 2>/dev/null && EDGE_UP=1
echo "  edge care api (fake identity): $([ "$EDGE_UP" = "1" ] && echo up || echo unavailable)"

echo
echo "=== 1. Real Identity accounts and tokens (synthetic; ids only are printed) ==="
PATIENT_ID="$(ensure_account patient patient)"
DOCTOR_ID="$(ensure_account doctor doctor)"
ADMIN_ID="$(ensure_account admin patient)"
echo "  patient id=$PATIENT_ID doctor id=$DOCTOR_ID admin id=$ADMIN_ID"
T_P="$(token_for patient patient active true)"
T_PU="$(token_for patient patient active false)"
T_PP="$(token_for patient patient pending true)"
set_state patient patient active true
T_DP="$(token_for doctor doctor pending true)"
T_DR="$(token_for doctor doctor rejected true)"
T_DA="$(token_for doctor doctor active true)"
set_state doctor doctor pending true
T_A="$(token_for admin admin active true)"
T_AP="$(token_for admin admin pending true)"
set_state admin admin active true
for v in P PU PP DP DR DA A AP; do
  eval "t=\${T_$v}"; [ -n "$t" ] || echo "  note: Identity issued no token for variant $v (login refused)"
done
[ -n "$T_P" ] && [ -n "$T_DA" ] && [ -n "$T_A" ] || { echo "  active patient/doctor/admin tokens are required"; exit 2; }
echo "  real tokens issued by Identity (patient active/unverified/pending, doctor pending/rejected/active, admin active/pending; suspended variants: section 2b)"

S="$CARE_URL/api/specialties"
J='Content-Type: application/json'
NAME_A="QA Spec $RUN A"; SLUG_A="qa-spec-$RUN-a"; DESC_A="QA-DESC-FIXTURE-$RUN"

echo
echo "=== 2. RBAC matrix (spec §9.2) ==="
expect_error "GET: no token"                              GET "$S" 401 Unauthorized
for pair in "T_P|patient active" "T_PU|patient unverified email" "T_DA|doctor active" "T_DP|doctor pending (S4)" "T_DR|doctor rejected (S4)" "T_A|admin active"; do
  eval "t=\${${pair%%|*}}"
  if [ -n "$t" ]; then expect_ok "GET: ${pair#*|} → 200" GET "$S" 200 -H "$(auth "$t")"; else skip "GET: ${pair#*|}" "no token"; fi
done
for pair in "T_PP|patient pending" "T_AP|admin pending"; do
  eval "t=\${${pair%%|*}}"
  if [ -n "$t" ]; then expect_error "GET: ${pair#*|} → 403" GET "$S" 403 Forbidden -H "$(auth "$t")"; else skip "GET: ${pair#*|}" "Identity refused the login"; fi
done
BODY_RBAC="{\"name\":\"QA Spec $RUN RBAC\",\"slug\":\"qa-spec-$RUN-rbac\"}"
expect_error "POST: no token"                             POST "$S" 401 Unauthorized -H "$J" -d "$BODY_RBAC"
for pair in "T_P|patient" "T_DA|doctor active" "T_DP|doctor pending" "T_DR|doctor rejected" "T_PP|patient pending" "T_AP|admin pending"; do
  eval "t=\${${pair%%|*}}"
  if [ -n "$t" ]; then expect_error "POST: ${pair#*|} → 403" POST "$S" 403 Forbidden -H "$(auth "$t")" -H "$J" -d "$BODY_RBAC"; else skip "POST: ${pair#*|}" "no token"; fi
done
n="$(csql "SELECT count(*) FROM specialties WHERE slug = 'qa-spec-$RUN-rbac'")"
expect_val "POST by non-admins created no row" "SELECT count(*) WHERE slug=rbac" 0 "$n"
expect_error "POST: patient + X-Role/X-User-Id admin headers still 403" POST "$S" 403 Forbidden -H "$(auth "$T_P")" -H "X-Role: admin" -H "X-User-Id: $ADMIN_ID" -H "$J" -d "$BODY_RBAC"
expect_error "PATCH: no token"                            PATCH "$S/1" 401 Unauthorized -H "$J" -d '{"name":"Zz"}'
for pair in "T_P|patient" "T_DA|doctor active" "T_DP|doctor pending" "T_DR|doctor rejected" "T_PP|patient pending" "T_AP|admin pending"; do
  eval "t=\${${pair%%|*}}"
  if [ -n "$t" ]; then expect_error "PATCH: ${pair#*|} → 403" PATCH "$S/1" 403 Forbidden -H "$(auth "$t")" -H "$J" -d '{"name":"Zz"}'; else skip "PATCH: ${pair#*|}" "no token"; fi
done
expect_error "PATCH /abc: patient → 403 (role before id)" PATCH "$S/abc" 403 Forbidden -H "$(auth "$T_P")" -H "$J" -d '{"name":"Zz"}'
TAMP="$(printf "%s" "$T_P" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [h,p,g]=s.split(".");const c=JSON.parse(Buffer.from(p,"base64url"));c.role="admin";process.stdout.write(h+"."+Buffer.from(JSON.stringify(c)).toString("base64url")+"."+g)})')"
expect_error "POST: tampered token (role→admin) → 401" POST "$S" 401 Unauthorized -H "$(auth "$TAMP")" -H "$J" -d "$BODY_RBAC"
expect_error "GET: malformed bearer → 401"                GET "$S" 401 Unauthorized -H "Authorization: Bearer not-a-jwt"

echo
echo "=== 2b. Suspended principals (Identity refuses to log them in; minted by the fake identity) ==="
if [ "$EDGE_UP" = "1" ]; then
  E="$EDGE_URL/api/specialties"
  mint() { local t; t="$(curl -s "$FAKE_IDENTITY_URL/mint?case=$1")"; remember "$t"; printf "%s" "$t"; }
  for c in patient-suspended doctor-suspended admin-suspended; do
    t="$(mint "$c")"
    expect_error "GET: $c → 403"   GET   "$E"      403 Forbidden -H "$(auth "$t")"
    expect_error "POST: $c → 403"  POST  "$E"      403 Forbidden -H "$(auth "$t")" -H "$J" -d "$BODY_RBAC"
    expect_error "PATCH: $c → 403" PATCH "$E/1"    403 Forbidden -H "$(auth "$t")" -H "$J" -d '{"name":"Zz"}'
  done
  expect_error "GET: forged-key token (unknown kid) → 401" GET "$E" 401 Unauthorized -H "$(auth "$(mint unknown-kid)")"
  expect_error "GET: expired token → 401 TokenExpired"     GET "$E" 401 TokenExpired -H "$(auth "$(mint expired)")"
  expect_error "GET: wrong audience → 401"                 GET "$E" 401 Unauthorized -H "$(auth "$(mint wrong-aud)")"
  expect_error "GET: service-typed token → 401"            GET "$E" 401 Unauthorized -H "$(auth "$(mint typ-service)")"
  expect_ok    "GET: edge patient 101 (fake JWKS) → 200"   GET "$E" 200 -H "$(auth "$(mint patient-101)")"
else skip "suspended / edge-token cases" "edge Care server unavailable"; fi

echo
echo "=== 3. POST /api/specialties (admin) ==="
AUTH_A="$(auth "$T_A")"
K_A="$(uuid)"
BODY_A="{\"name\":\"$NAME_A\",\"slug\":\"$SLUG_A\",\"description\":\"$DESC_A\"}"
expect_ok "create A (with Idempotency-Key) → 201" POST "$S" 201 -H "$AUTH_A" -H "$J" -H "Idempotency-Key: $K_A" -d "$BODY_A"
R_A="$(rid)"; ID_A="$(jfields data.id)"; CREATED_IDS+=("$ID_A")
expect_field "A: isActive true, description kept" data.isActive true
expect_val "A: name/slug/description echoed" "body" "$NAME_A|$SLUG_A|$DESC_A" "$(jfields data.name data.slug data.description)"
row="$(csql "SELECT actor_user_id||'|'||actor_role||'|'||action||'|'||entity_type||'|'||entity_id||'|'||metadata::text FROM audit_logs WHERE request_id = '$R_A'")"
expect_val "A: one audit row (actor, action, entity, metadata {})" "SELECT … audit_logs WHERE request_id" "$ADMIN_ID|admin|specialty.created|specialty|$ID_A|{}" "$row"
expect_ok "A: replay same key + same body → 201 same id" POST "$S" 201 -H "$AUTH_A" -H "$J" -H "Idempotency-Key: $K_A" -d "$BODY_A"
expect_field "A: replay returns the original id" data.id "$ID_A"
expect_val "A: replay leaves one row, one audit row" "count rows|audit" "1|1" "$(csql "SELECT (SELECT count(*) FROM specialties WHERE slug='$SLUG_A')||'|'||(SELECT count(*) FROM audit_logs WHERE action='specialty.created' AND entity_id=$ID_A)")"
expect_error "A: same key, different body → 422" POST "$S" 422 IdempotencyConflict -H "$AUTH_A" -H "$J" -H "Idempotency-Key: $K_A" -d "{\"name\":\"$NAME_A\",\"slug\":\"$SLUG_A-other\"}"
expect_error "Idempotency-Key not a UUID → 400" POST "$S" 400 ValidationFailed -H "$AUTH_A" -H "$J" -H "Idempotency-Key: nope" -d "{\"name\":\"QA Spec $RUN X\",\"slug\":\"qa-spec-$RUN-x\"}"
expect_val "invalid key created no row" "count" 0 "$(csql "SELECT count(*) FROM specialties WHERE slug='qa-spec-$RUN-x'")"

NAME_B="QA Spec $RUN B"; SLUG_B="qa-spec-$RUN-b"
expect_ok "create B (no Idempotency-Key; optional) → 201" POST "$S" 201 -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_B\",\"slug\":\"$SLUG_B\"}"
ID_B="$(jfields data.id)"; CREATED_IDS+=("$ID_B")
expect_field "B: description null when omitted" data.description null
expect_error "B again without a key → 409 Conflict (duplicate)" POST "$S" 409 Conflict -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_B\",\"slug\":\"$SLUG_B\"}"
expect_error "duplicate slug → 409, details.field slug" POST "$S" 409 Conflict -H "$AUTH_A" -H "$J" -d "{\"name\":\"QA Spec $RUN dupslug\",\"slug\":\"$SLUG_A\"}"
expect_field "duplicate slug: details[0].field" error.details.0.field slug
R="$(rid)"; expect_val "duplicate slug: no audit row" "count" 0 "$(csql "SELECT count(*) FROM audit_logs WHERE request_id='$R'")"
expect_error "duplicate name → 409, details.field name" POST "$S" 409 Conflict -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_A\",\"slug\":\"qa-spec-$RUN-dupname\"}"
expect_field "duplicate name: details[0].field" error.details.0.field name
expect_error "duplicate of a seeded name (Cardiology) → 409" POST "$S" 409 Conflict -H "$AUTH_A" -H "$J" -d "{\"name\":\"Cardiology\",\"slug\":\"qa-spec-$RUN-card\"}"
expect_ok "case-sensitive name (D3): lower-cased A → 201" POST "$S" 201 -H "$AUTH_A" -H "$J" -d "{\"name\":\"$(printf "%s" "$NAME_A" | tr 'A-Z' 'a-z')\",\"slug\":\"qa-spec-$RUN-c\"}"
CREATED_IDS+=("$(jfields data.id)")
N100="$(printf "%s" "QA$RUN" )$(longstr n $((100 - 2 - ${#RUN})))"
D2000="$(longstr d 2000)"
expect_ok "boundary: 100-char name, 2000-char description → 201" POST "$S" 201 -H "$AUTH_A" -H "$J" -d "{\"name\":\"$N100\",\"slug\":\"qa-spec-$RUN-max\",\"description\":\"$D2000\"}"
CREATED_IDS+=("$(jfields data.id)")
# concurrency (S-R17): two parallel creates of one slug → exactly one 201 and one 409
( curl -s -o /dev/null -w "%{http_code}" -X POST "$S" -H "$AUTH_A" -H "$J" -H "X-Request-Id: $(uuid)" -H "Idempotency-Key: $(uuid)" -d "{\"name\":\"QA Spec $RUN race1\",\"slug\":\"qa-spec-$RUN-race\"}" > "$TMP/c1" ) &
( curl -s -o /dev/null -w "%{http_code}" -X POST "$S" -H "$AUTH_A" -H "$J" -H "X-Request-Id: $(uuid)" -H "Idempotency-Key: $(uuid)" -d "{\"name\":\"QA Spec $RUN race2\",\"slug\":\"qa-spec-$RUN-race\"}" > "$TMP/c2" ) &
wait
got="$(printf "%s\n%s\n" "$(cat "$TMP/c1")" "$(cat "$TMP/c2")" | sort | tr '\n' ' ')"
expect_val "concurrent creates of one slug → one 201 + one 409" "2 parallel POSTs" "201 409 " "$got"
CREATED_IDS+=("$(csql "SELECT id FROM specialties WHERE slug='qa-spec-$RUN-race'")")
expect_val "race: exactly one row" "count" 1 "$(csql "SELECT count(*) FROM specialties WHERE slug='qa-spec-$RUN-race'")"

echo "  -- validation (all expect 400 ValidationFailed)"
V1="$(longstr a 101)"; V2000="$(longstr d 2001)"
bad_post() { expect_error "POST invalid: $1" POST "$S" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d "$2"; }
bad_post "empty object"                 '{}'
bad_post "name 1 char"                  '{"name":"A","slug":"qa-valid"}'
bad_post "name 101 chars"               "{\"name\":\"$V1\",\"slug\":\"qa-valid\"}"
bad_post "name a number"                '{"name":12,"slug":"qa-valid"}'
bad_post "slug missing"                 '{"name":"Valid Name"}'
bad_post "slug Bad_Slug"                '{"name":"Valid Name","slug":"Bad_Slug"}'
bad_post "slug -a"                      '{"name":"Valid Name","slug":"-a"}'
bad_post "slug a--b"                    '{"name":"Valid Name","slug":"a--b"}'
bad_post "slug a-"                      '{"name":"Valid Name","slug":"a-"}'
bad_post "slug 101 chars"               "{\"name\":\"Valid Name\",\"slug\":\"$V1\"}"
bad_post "description 2001 chars"       "{\"name\":\"Valid Name\",\"slug\":\"qa-valid\",\"description\":\"$V2000\"}"
bad_post "description null"             '{"name":"Valid Name","slug":"qa-valid","description":null}'
bad_post "isActive member (S-R4)"       '{"name":"Valid Name","slug":"qa-valid","isActive":true}'
bad_post "id member"                    '{"name":"Valid Name","slug":"qa-valid","id":5}'
bad_post "unknown member"               '{"name":"Valid Name","slug":"qa-valid","extra":1}'
bad_post "array body"                   '[]'
bad_post "malformed JSON"               '{"name":'
expect_val "no invalid body created a row" "count slug qa-valid" 0 "$(csql "SELECT count(*) FROM specialties WHERE slug='qa-valid'")"

echo
echo "=== 4. GET /api/specialties — list, filters, paging ==="
reset_rl
expect_ok "default list: 200, contract Specialty keys" GET "$S" 200 -H "$(auth "$T_P")"
expect_val "meta: nextCursor present, hasMore true, count 20" "meta" "true|20" "$(jfields meta.hasMore meta.count)"
ACTIVE_N="$(csql "SELECT count(*) FROM specialties WHERE is_active")"
echo "  (active rows in catalog: $ACTIVE_N)"
for q in "limit=0" "limit=101" "limit=1.5" "limit=1e1" "limit=05" "limit=abc" "limit=%205" "limit=-1" "cursor=%21%21%21" "cursor=$(longstr A 600)" "unknown=1" "includeInactive=yes" "includeInactive=1" "includeInactive=TRUE" "includeInactive=" "includeInactive=true&includeInactive=false"; do
  expect_error "GET ?$(printf "%s" "$q" | cut -c1-40) (patient) → 400" GET "$S?$q" 400 ValidationFailed -H "$(auth "$T_P")"
done
expect_error "GET ?includeInactive=yes (admin) → 400 (every role)" GET "$S?includeInactive=yes" 400 ValidationFailed -H "$AUTH_A"
expect_error "GET ?includeInactive=yes (doctor pending) → 400" GET "$S?includeInactive=yes" 400 ValidationFailed -H "$(auth "${T_DP:-$T_DA}")"
CUR_NUM="$(node -e 'process.stdout.write(Buffer.from(JSON.stringify([5,1])).toString("base64url"))')"
CUR_LONG="$(node -e 'process.stdout.write(Buffer.from(JSON.stringify(["a".repeat(101),1])).toString("base64url"))')"
CUR_TAMP="$(node -e 'process.stdout.write(Buffer.from("[\"x\"").toString("base64url"))')"
expect_error "GET cursor with numeric sortValue → 400" GET "$S?cursor=$CUR_NUM" 400 ValidationFailed -H "$(auth "$T_P")"
expect_error "GET cursor with 101-char name position → 400" GET "$S?cursor=$CUR_LONG" 400 ValidationFailed -H "$(auth "$T_P")"
expect_field "cursor 400: details[0].field" error.details.0.field cursor
expect_error "GET tampered cursor → 400"            GET "$S?cursor=$CUR_TAMP" 400 ValidationFailed -H "$(auth "$T_P")"
expect_error "GET ?includeInactive=yes (patient) again, for the field name" GET "$S?includeInactive=yes" 400 ValidationFailed -H "$(auth "$T_P")"
expect_field "400 details[0].field for bad includeInactive" error.details.0.field "includeInactive"
st="$(call GET "$S?limit=1" -H "$(auth "$T_P")")"
expect_val "limit=1 → count 1, hasMore true" "meta" "200|1|true" "$st|$(jfields meta.count)|$(jfields meta.hasMore)"

# walk every page with limit 7; compare with the database's own (name, id) order for the same visibility
walk() { # walk <token> <limit> <extra query> → ids joined by "," across all pages (pages counted in $WALK_PAGES)
  local cur="" all="" q st; WALK_PAGES=0; WALK_RESULT=""
  while :; do
    q="limit=$2$3"; [ -n "$cur" ] && q="$q&cursor=$cur"
    st="$(call GET "$S?$q" -H "$(auth "$1")")"; [ "$st" = 200 ] || { WALK_RESULT="ERR$st"; return; }
    WALK_PAGES=$((WALK_PAGES + 1))
    all="$all$([ -n "$all" ] && echo ,)$(ids_of)"
    [ "$(jfields meta.hasMore)" = "true" ] || break
    cur="$(jfields meta.nextCursor)"; [ "$WALK_PAGES" -gt 80 ] && break
  done
  WALK_RESULT="$all"
}
want_active="$(csql "SELECT string_agg(id::text, ',' ORDER BY name, id) FROM specialties WHERE is_active")"
walk "$T_P" 7 ""; got="$WALK_RESULT"
expect_val "paging limit=7 (patient): every active row once, DB order" "$WALK_PAGES pages" "$want_active" "$got"
dups="$(printf "%s" "$got" | tr ',' '\n' | sort | uniq -d | wc -l | tr -d ' ')"
expect_val "paging: no duplicate id across pages" "uniq -d" 0 "$dups"
walk "$T_P" 20 ""; got="$WALK_RESULT"
expect_val "paging default limit 20 → page 2 and last page reached (>= 2 pages)" "pages" "$want_active|1" "$got|$([ "$WALK_PAGES" -ge 2 ] && echo 1 || echo 0)"
st="$(call GET "$S?limit=100" -H "$(auth "$T_P")")"
expect_val "limit=100 accepted" "status|hasMore" "200|false" "$st|$(jfields meta.hasMore)"
expect_val "last page: nextCursor null" "meta.nextCursor" "null" "$(jfields meta.nextCursor)"
# cursor at the last row's name returns an empty page with the contract meta
LAST_CUR="$(node -e 'process.stdout.write(Buffer.from(JSON.stringify(["zzzzzzzz",2147483647])).toString("base64url"))')"
st="$(call GET "$S?cursor=$LAST_CUR" -H "$(auth "$T_P")")"
expect_val "cursor past the end → empty page" "status|meta" "200|null|false|0" "$st|$(jfields meta.nextCursor)|$(jfields meta.hasMore)|$(jfields meta.count)"

echo
echo "=== 5. PATCH /api/specialties/{id} (admin) ==="
audit_n() { csql "SELECT count(*) FROM audit_logs WHERE action='specialty.updated' AND entity_id=$1"; }
upd_at() { csql "SELECT updated_at::text FROM specialties WHERE id=$1"; }
NAME_A2="QA Spec $RUN A2"
before="$(upd_at "$ID_A")"
expect_ok "rename A → 200" PATCH "$S/$ID_A" 200 -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_A2\"}"
R="$(rid)"; expect_field "rename: new name returned" data.name "$NAME_A2"
expect_val "rename: audit changedFields = name, actor admin" "audit_logs" "$ADMIN_ID|admin|{\"changedFields\": \"name\"}" "$(csql "SELECT actor_user_id||'|'||actor_role||'|'||metadata::text FROM audit_logs WHERE request_id='$R'")"
after="$(upd_at "$ID_A")"
expect_val "rename: updated_at advanced (owner query)" "updated_at > before" 1 "$([ "$after" \> "$before" ] && echo 1 || echo 0)"
UPD_BEFORE="$(upd_at "$ID_A")"; AUD_BEFORE="$(audit_n "$ID_A")"
st="$(call PATCH "$S/$ID_A" -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_A2\",\"slug\":\"$SLUG_A\"}")"; noop1="$(jfields data.name data.slug data.updatedAt)"
expect_val "no-op PATCH (S1) → 200" "status" 200 "$st"
expect_val "no-op: updated_at and audit count unchanged" "owner query" "$UPD_BEFORE|$AUD_BEFORE" "$(upd_at "$ID_A")|$(audit_n "$ID_A")"
st="$(call PATCH "$S/$ID_A" -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_A2\",\"slug\":\"$SLUG_A\"}")"
expect_val "no-op: identical body twice (incl. updatedAt)" "body" "$noop1" "$(jfields data.name data.slug data.updatedAt)"
expect_ok "partly equal (name same, description new) → 200" PATCH "$S/$ID_A" 200 -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_A2\",\"description\":\"QA-DESC-2-$RUN\"}"
R="$(rid)"; expect_val "partly equal: audits only description" "metadata" "{\"changedFields\": \"description\"}" "$(csql "SELECT metadata::text FROM audit_logs WHERE request_id='$R'")"
SLUG_A2="qa-spec-$RUN-a2"
expect_ok "3-field change (slug, description null, isActive false) → 200" PATCH "$S/$ID_A" 200 -H "$AUTH_A" -H "$J" -d "{\"slug\":\"$SLUG_A2\",\"description\":null,\"isActive\":false}"
R="$(rid)"; expect_val "3-field: description cleared (null), isActive false" "body" "null|false" "$(jfields data.description data.isActive)"
expect_val "3-field: audit changedFields sorted" "metadata" "{\"changedFields\": \"description,isActive,slug\"}" "$(csql "SELECT metadata::text FROM audit_logs WHERE request_id='$R'")"
# visibility of the inactive row
reset_rl
for pair in "T_P|patient" "T_DA|doctor"; do
  eval "t=\${${pair%%|*}}"
  st="$(call GET "$S?limit=100&includeInactive=true" -H "$(auth "$t")")"
  has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
  expect_val "inactive A hidden from ${pair#*|} even with includeInactive=true (S-R6)" "status|contains" "200|0" "$st|$has"
done
st="$(call GET "$S?limit=100" -H "$AUTH_A")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
expect_val "inactive A hidden from admin by default" "status|contains" "200|0" "$st|$has"
st="$(call GET "$S?limit=100&includeInactive=false" -H "$AUTH_A")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
expect_val "inactive A hidden from admin with includeInactive=false" "status|contains" "200|0" "$st|$has"
st="$(call GET "$S?limit=100&includeInactive=true" -H "$AUTH_A")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
expect_val "inactive A shown to admin with includeInactive=true" "status|contains" "200|1" "$st|$has"
want_all="$(csql "SELECT string_agg(id::text, ',' ORDER BY name, id) FROM specialties")"
walk "$T_A" 9 "&includeInactive=true"; got="$WALK_RESULT"
expect_val "paging includeInactive=true (admin): all rows, DB order" "$WALK_PAGES pages" "$want_all" "$got"
expect_ok "reactivate A → 200" PATCH "$S/$ID_A" 200 -H "$AUTH_A" -H "$J" -d '{"isActive":true}'
st="$(call GET "$S?limit=100" -H "$(auth "$T_P")")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
expect_val "reactivated A visible to patient again" "status|contains" "200|1" "$st|$has"
expect_ok "PATCH own current slug → 200 (not 409)" PATCH "$S/$ID_A" 200 -H "$AUTH_A" -H "$J" -d "{\"slug\":\"$SLUG_A2\"}"
AUD_B="$(audit_n "$ID_B")"; B_BEFORE="$(csql "SELECT name||'|'||slug FROM specialties WHERE id=$ID_B")"
expect_error "PATCH B slug = A's slug → 409" PATCH "$S/$ID_B" 409 Conflict -H "$AUTH_A" -H "$J" -d "{\"slug\":\"$SLUG_A2\"}"
expect_field "409 slug: details[0].field" error.details.0.field slug
expect_error "PATCH B name = A's name → 409" PATCH "$S/$ID_B" 409 Conflict -H "$AUTH_A" -H "$J" -d "{\"name\":\"$NAME_A2\"}"
expect_field "409 name: details[0].field" error.details.0.field name
expect_val "409s: B unchanged, no audit row" "owner query" "$B_BEFORE|$AUD_B" "$(csql "SELECT name||'|'||slug FROM specialties WHERE id=$ID_B")|$(audit_n "$ID_B")"
expect_ok "PATCH ignores Idempotency-Key (different bodies, same key → both 200)" PATCH "$S/$ID_B" 200 -H "$AUTH_A" -H "$J" -H "Idempotency-Key: $K_A" -d "{\"description\":\"QA-DESC-B1-$RUN\"}"
expect_status "PATCH same key, different body → 200 (no 422)" PATCH "$S/$ID_B" 200 -H "$AUTH_A" -H "$J" -H "Idempotency-Key: $K_A" -d "{\"description\":\"QA-DESC-B2-$RUN\"}"
R_PATCH="$(rid)"
echo "  -- PATCH validation and ids"
bad_patch() { expect_error "PATCH invalid: $1" PATCH "$S/$ID_B" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d "$2"; }
bad_patch "{}"                    '{}'
expect_field "{} → details[0].field body" error.details.0.field body
bad_patch "name null"             '{"name":null}'
bad_patch "slug null"             '{"slug":null}'
bad_patch "isActive null"         '{"isActive":null}'
bad_patch 'isActive "false" string' '{"isActive":"false"}'
bad_patch "name 1 char"           '{"name":"A"}'
bad_patch "slug Bad_Slug"         '{"slug":"Bad_Slug"}'
bad_patch "description number"    '{"description":5}'
bad_patch "createdAt member"      '{"createdAt":"2026-01-01T00:00:00Z"}'
bad_patch "id member"             '{"id":1}'
bad_patch "array body"            '[]'
for id in abc 0 007 9007199254740993 999999 -1 1.5; do
  expect_error "PATCH /$id (admin) → 404" PATCH "$S/$id" 404 NotFound -H "$AUTH_A" -H "$J" -d '{"name":"Zz Unknown"}'
done
expect_error "PATCH malformed percent-encoding id → handled 4xx" PATCH "$S/%E0%A4%A" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d '{"name":"Zz"}'
expect_error "DELETE /api/specialties/{id} → no route (404)" DELETE "$S/$ID_B" 404 NotFound -H "$AUTH_A"

echo
echo "=== 6. Rate limit (S2): GET 60/min per IP, 120/min per user ==="
reset_rl
args=(); for _ in $(seq 1 60); do args+=(-o /dev/null "$S"); done
s60="$(curl -s -w "%{http_code} " -H "$(auth "$T_P")" "${args[@]}")"
ok60="$(printf "%s" "$s60" | tr ' ' '\n' | grep -c '^200$' || true)"
expect_val "60 GETs inside a minute from one IP → all 200" "count of 200" 60 "$ok60"
st="$(call GET "$S" -H "$(auth "$T_P")")"; f="$(jfields success error.code error.requestId)"
record "61st GET → 429 RateLimited" "GET /api/specialties" "429 RateLimited" "$st $(printf "%s" "$f" | cut -d'|' -f2)" "$([ "$st" = 429 ] && [ "$f" = "false|RateLimited|$(rid)" ] && [ "$(header X-Request-Id)" = "$(rid)" ] && echo 1 || echo 0)"
ra="$(header Retry-After)"
record "429 carries Retry-After >= 1" "header" ">=1" "$ra" "$([ -n "$ra" ] && [ "$ra" -ge 1 ] 2>/dev/null && echo 1 || echo 0)"
expect_error "429 also applies before the guard (no token)" GET "$S" 429 RateLimited
expect_error "POST is not limited by the GET limiter (invalid body still 400)" POST "$S" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d '{}'
reset_rl
expect_status "after the window reset → 200 again" GET "$S" 200 -H "$(auth "$T_P")"
ipk="$(rcli KEYS 'rl:specialties-list-ip:*' | wc -l | tr -d ' ')"
usk="$(rcli EXISTS "rl:specialties-list-user:$PATIENT_ID")"
record "Redis keys: rl:specialties-list-ip:<ip> and -user:<id> written" "KEYS / EXISTS" ">=1 / 1" "$ipk / $usk" "$([ "$ipk" -ge 1 ] && [ "$usk" = 1 ] && echo 1 || echo 0)"
reset_rl

# ================================================================================================================
compiled_checks() { # compiled_checks <base url> — #8 on the compiled build; A is made inactive first
  local C="$1/api/specialties" st has
  echo
  echo "=== 7. Compiled build (#8, spec §9.5) at $1 — node dist/server.js ==="
  csql "UPDATE specialties SET is_active = false WHERE id = $ID_A" >/dev/null
  expect_error "compiled: no token → 401" GET "$C" 401 Unauthorized
  st="$(call GET "$C?limit=100&includeInactive=false" -H "$AUTH_A")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
  expect_val "compiled: admin includeInactive=false omits the inactive row" "status|contains" "200|0" "$st|$has"
  st="$(call GET "$C?limit=100" -H "$AUTH_A")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
  expect_val "compiled: admin default omits the inactive row" "status|contains" "200|0" "$st|$has"
  st="$(call GET "$C?limit=100&includeInactive=true" -H "$AUTH_A")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
  expect_val "compiled: admin includeInactive=true includes it" "status|contains" "200|1" "$st|$has"
  st="$(call GET "$C?limit=100&includeInactive=true" -H "$(auth "$T_P")")"; has="$(ids_of | tr ',' '\n' | grep -cx "$ID_A" || true)"
  expect_val "compiled: patient includeInactive=true omits it" "status|contains" "200|0" "$st|$has"
  for q in "includeInactive=yes" "includeInactive=1" "includeInactive=TRUE" "includeInactive=" "includeInactive=true&includeInactive=false" "limit=1e1" "limit=05" "limit=%205" "limit=1.5" "limit=0" "limit=101"; do
    expect_error "compiled: GET ?$q → 400" GET "$C?$q" 400 ValidationFailed -H "$AUTH_A"
  done
  st="$(call GET "$C?limit=3" -H "$(auth "$T_P")")"
  expect_val "compiled: limit=3 → 3 items, hasMore" "status|count|hasMore" "200|3|true" "$st|$(jfields meta.count)|$(jfields meta.hasMore)"
  expect_error 'compiled: PATCH {"isActive":"false"} (string) → 400' PATCH "$C/$ID_B" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d '{"isActive":"false"}'
  expect_error "compiled: POST isActive member → 400" POST "$C" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d '{"name":"Valid Name","slug":"qa-valid","isActive":true}'
  expect_error "compiled: PATCH {} → 400" PATCH "$C/$ID_B" 400 ValidationFailed -H "$AUTH_A" -H "$J" -d '{}'
  expect_error "compiled: PATCH /abc (admin) → 404" PATCH "$C/abc" 404 NotFound -H "$AUTH_A" -H "$J" -d '{"name":"Zz"}'
  expect_error "compiled: POST patient → 403" POST "$C" 403 Forbidden -H "$(auth "$T_P")" -H "$J" -d "$BODY_RBAC"
  expect_ok "compiled: PATCH rename B (audit + envelope) → 200" PATCH "$C/$ID_B" 200 -H "$AUTH_A" -H "$J" -d "{\"description\":\"QA-DESC-B3-$RUN\"}"
}
if curl -s -o /dev/null "$COMPILED_URL/api/health/live" 2>/dev/null; then
  compiled_checks "$COMPILED_URL"
elif [ "$START_COMPILED" = "1" ]; then
  echo
  echo "=== 7a. Building and starting the compiled build on ${COMPILED_URL##*:} ==="
  ( cd "$REPO_DIR" && npm run build >"$TMP/build.log" 2>&1 ) || { echo "  npm run build failed (see below)"; tail -20 "$TMP/build.log"; exit 1; }
  ( cd "$REPO_DIR" && PORT="${COMPILED_URL##*:}" INTERNAL_PORT="$(( ${COMPILED_URL##*:} + 100 ))" NODE_ENV=development \
      node --env-file=.env dist/server.js >"$TMP/compiled.log" 2>&1 & )
  STARTED_COMPILED=1
  for _ in $(seq 1 40); do curl -s -o /dev/null "$COMPILED_URL/api/health/live" 2>/dev/null && break; pause 1; done
  curl -s -o /dev/null "$COMPILED_URL/api/health/live" 2>/dev/null || { echo "  compiled build did not start:"; tail -20 "$TMP/compiled.log"; exit 1; }
  echo "  compiled build up"
  compiled_checks "$COMPILED_URL"
else
  skip "compiled-build checks" "START_COMPILED=0 and $COMPILED_URL unreachable"
fi

echo
echo "=== 8. Log hygiene (tokens, Authorization, bodies, route labels) ==="
if [ -n "$CARE_LOG_FILE" ] && [ -f "$CARE_LOG_FILE" ]; then
  leaks=0
  for sig in "${TOKEN_SIGS[@]}"; do [ -n "$sig" ] && grep -qF "$sig" "$CARE_LOG_FILE" && leaks=$((leaks + 1)); done
  bearer="$(grep -ciE 'bearer |"authorization"' "$CARE_LOG_FILE" || true)"
  fixture="$(grep -cF "QA-DESC" "$CARE_LOG_FILE" || true)"
  pii="$(grep -ciE "$QA_EMAIL_PREFIX|@$QA_EMAIL_DOMAIN|password" "$CARE_LOG_FILE" || true)"
  record "log: token signatures / Authorization / description fixture / PII" "grep" "0 / 0 / 0 / 0" "$leaks / $bearer / $fixture / $pii" \
    "$([ "$leaks" = 0 ] && [ "$bearer" = 0 ] && [ "$fixture" = 0 ] && [ "$pii" = 0 ] && echo 1 || echo 0)"
  line="$(grep -F "\"requestId\":\"$R_PATCH\"" "$CARE_LOG_FILE" | grep -F request_completed | tail -1 || true)"
  route="$(printf "%s" "$line" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).route+"|"+JSON.parse(s).userId)}catch{process.stdout.write("<none>")}})')"
  expect_val "log: PATCH route label and userId" "request_completed" "/api/specialties/:id|$ADMIN_ID" "$route"
  bad_routes="$(grep -F request_completed "$CARE_LOG_FILE" | grep -F '"route":"/api/specialties' | grep -vcE '"route":"/api/specialties(/:id)?"' || true)"
  expect_val "log: every specialties route label is /api/specialties[/:id]" "count of others" 0 "$bad_routes"
else skip "log hygiene" "CARE_LOG_FILE not set"; fi

echo
echo "=== Result: $PASS pass / $FAIL fail / $SKIP skipped ($CASE cases) ==="
[ "$FAIL" = 0 ]
