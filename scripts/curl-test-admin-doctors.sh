#!/usr/bin/env bash
# Repeatable HTTP QA for PATCH /api/admin/doctors/{doctorUserId}/suspend and /reinstate (Integration Cases 3 and 4).
# Use only a disposable *_test or *_qa* database; the script refuses anything else.
#
# Start first (see docs/admin-doctors/manual-qa.md -> Environment):
#   node scripts/admin-doctors-qa-fake-identity.mjs      # JWKS + user tokens + fake Identity internal API (FAKE_IDENTITY_PORT, default 3021)
#   npx tsx src/server.ts   and   npx tsx src/worker.ts  # both with the same env: IDENTITY_JWKS_URL=<fake>/.well-known/jwks.json,
#                                                         # IDENTITY_INTERNAL_URL=<fake>, REDIS_URL on a spare db index, dummy STORAGE_* values
# The fake Identity is switched at runtime, without restarting Care: GET $FAKE_IDENTITY_URL/__ctl?mode=healthy|down|hang|conflict
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH).
# Optional: CARE_URL (default http://127.0.0.1:3031), FAKE_IDENTITY_URL (default http://127.0.0.1:3021),
#           REDIS_URL (flushed at start so rate-limit and idempotency state is clean; a spare db index only),
#           QA_REPORT (file receiving the case table), SERVER_LOG / WORKER_LOG (care-api / care-worker logs, scanned for leaks and alerts),
#           SYNC_WAIT_SECONDS (convergence timeout, default 120).
# Synthetic fixtures: doctors 4xx, patient 101, admins 1, 2, 3 (suspended token), 11..19, 90. The script resets doctors 4xx first (idempotent).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: stop argument path mangling of values containing "/"

CARE_URL="${CARE_URL:-http://127.0.0.1:3031}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
SYNC_WAIT_SECONDS="${SYNC_WAIT_SECONDS:-120}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"   # native curl/node need a Windows path under Git Bash
PASS=0; FAIL=0; CASE=0
MARK='SYNTHETIC-REASON-5521'

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
ctl() { curl -fsS "$FAKE_IDENTITY_URL/__ctl?mode=$1" >/dev/null; }
# jq-free JSON helpers: js <expression over b = parsed last body>
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=eval(process.argv[2]);process.stdout.write(String(r))' "$TMP/body" "$1"; }
# fake Identity call log helpers: fcount <userId> | flast <userId> <field>
fcount() { curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(c.patches.filter(p=>p.userId===Number(process.argv[1])).length))' "$1"; }
flast() { curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")).patches.filter(p=>p.userId===Number(process.argv[1]));process.stdout.write(String(c.length?c[c.length-1][process.argv[2]]:"none"))' "$1" "$2"; }
fuser() { curl -fsS "$FAKE_IDENTITY_URL/__user?id=$1" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).status)'; }
pid() { sql "select id from doctor_profiles where user_id=$1 and deleted_at is null"; }
audit_n() { sql "select count(*) from audit_logs where action='$2' and entity_id=(select id from doctor_profiles where user_id=$1) and entity_type='doctor_profile'"; }
job_n() { sql "select count(*) from identity_sync_jobs where doctor_user_id=$1 and kind='$2'"; }
# wait_sql <query> <expected> [timeoutSeconds]: poll until the query prints the expected value
wait_sql() { local end=$((SECONDS+${3:-$SYNC_WAIT_SECONDS})); while [ "$SECONDS" -lt "$end" ]; do [ "$(sql "$1")" = "$2" ] && return 0; sleep 2; done; return 1; }

call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" extra="${6:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  [ -z "$extra" ] || args+=(-H "$extra")
  curl "${args[@]}" "$CARE_URL$path"
}
# Envelope check. kind=error: success=false, error.code, error.requestId, details array. kind=ok: success=true.
# X-Request-Id must be echoed and Cache-Control must be no-store. Optional JS assertion over b (body), h (headers), rid.
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: no-store\r?$/im.test(h)) process.exit(1);
const raw = fs.readFileSync(file, 'utf8');
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (kind === 'error') {
  if (b.success !== false || b.error?.code !== code || b.error?.requestId !== rid ||
      typeof b.error?.message !== 'string' || !Array.isArray(b.error?.details)) process.exit(1);
} else if (b.success !== true) process.exit(1);
if (assertion && !eval(assertion)) process.exit(1);
NODE
}
record() {
  local method="$1" path="$2" role="$3" scenario="$4" expected="${5//|/;}" got="${6//|/;}" ok="$7"
  CASE=$((CASE+1))
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); result=PASS; else FAIL=$((FAIL+1)); result=FAIL; fi
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$method" "$path" "$role" "$scenario" "$expected" "$got" "$result" | tee -a "${QA_REPORT:-$TMP/report}"
}
# expect METHOD PATH ROLE TOKEN SCENARIO EXPECTED [ASSERT_JS] [BODY] [KEY] [EXTRA_HEADER]
# EXPECTED: "200" / "202" (success envelope) or "<status> <ErrorCode>" (error envelope).
expect() {
  local method="$1" path="$2" role="$3" token="$4" scenario="$5" expected="$6" assertion="${7:-}" body="${8:-}" key="${9:-}" extra="${10:-}"
  local status ok=1 kind=ok code='' want="${expected%% *}"
  status="$(call "$method" "$path" "$token" "$body" "$key" "$extra")"
  [ "$expected" != "$want" ] && { kind=error; code="${expected#* }"; }
  [ "$status" = "$want" ] || ok=0
  check_body "$kind" "$code" "$assertion" || ok=0
  local got="$status"
  if [ "$kind" = error ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
  fi
  record "$method" "$path" "$role" "$scenario" "$expected" "$got" "$ok"
}
# check_value METHOD(check) DESCRIPTION ROLE EXPECTED ACTUAL  -> check_value <path> <role> <description> <expected> <actual>
check_value() { record check "$1" "$2" "$3" "$4" "$5" "$([ "$4" = "$5" ] && echo 1 || echo 0)"; }
# check_true <path> <role> <description> <0|1>
check_true() { record check "$1" "$2" "$3" 1 "$4" "$([ "$4" = 1 ] && echo 1 || echo 0)"; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }

reset() {
  sql "DELETE FROM identity_sync_jobs WHERE doctor_user_id BETWEEN 400 AND 499;
       DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 400 AND 499);
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 400 AND 499);
       DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 400 AND 499);
       DELETE FROM doctor_profiles WHERE user_id BETWEEN 400 AND 499;" >/dev/null
}
cleanup() { ctl healthy 2>/dev/null || true; reset 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
reset
ctl healthy
curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
if [ -n "${REDIS_URL:-}" ]; then
  node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null
fi
LOG_MARK_WORKER=0; LOG_MARK_API=0
[ -z "${SERVER_LOG:-}" ] || LOG_MARK_API="$(wc -l < "$SERVER_LOG")"
[ -z "${WORKER_LOG:-}" ] || LOG_MARK_WORKER="$(wc -l < "$WORKER_LOG")"

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
PATIENT="$(mint patient-101)"; EXPIRED="$(mint expired)"; ADMIN_SUSP="$(mint admin-suspended)"
adm() { mint "admin-$1"; }
echo 'case|method|path|role|scenario|expected|got|result'

# mkdoc <userId> [approved|draft]: a doctor profile through the real apply route, approved + synced via owner SQL, one active type.
mkdoc() {
  local uid="$1" mode="${2:-approved}" t
  t="$(mint "doctor-$uid")"
  local body="{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"Africa/Cairo\",\"submit\":false}"
  [ "$(call POST /api/doctors/apply "$t" "$body")" = 201 ] || { echo "fixture apply failed for doctor $uid" >&2; exit 2; }
  if [ "$mode" = approved ]; then
    sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$uid" >/dev/null
    [ "$(call POST /api/doctors/me/consultation-types "$t" '{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}')" = 201 ] || { echo "fixture type failed for doctor $uid" >&2; exit 2; }
  fi
}
dtoken() { mint "doctor-$1"; }
# doctor-side view (GET /api/doctors/me): prints "<isSuspended>/<isBookable>/<identitySyncStatus>"
dview() { call GET /api/doctors/me "$(dtoken "$1")" >/dev/null; js 'b.data.isSuspended+"/"+b.data.isBookable+"/"+b.data.identitySyncStatus'; }
SUSPEND() { echo "/api/admin/doctors/$1/suspend"; }
REINSTATE() { echo "/api/admin/doctors/$1/reinstate"; }
R_OK='{"reason":"Synthetic QA reason"}'
S_SHAPE='typeof b.data.doctorUserId==="number" && typeof b.data.suspendedAt==="string" && !Number.isNaN(Date.parse(b.data.suspendedAt)) && Array.isArray(b.data.flaggedConsultationIds) && b.data.flaggedConsultationIds.length===0'

# ---- 1. RBAC matrix, both routes (doctor 410 approved, never changed by this section) ----
mkdoc 410; mkdoc 411
ADMIN11="$(adm 11)"; ADMIN13="$(adm 13)"; DOC410="$(dtoken 410)"; DOC411="$(dtoken 411)"
for op in SUSPEND REINSTATE; do
  p="$($op 410)"; m="${op,,}"
  expect PATCH "$p" none '' "$m unauthenticated" '401 Unauthorized' '' "$R_OK"
  expect PATCH "$p" admin "$EXPIRED" "$m expired-token" '401 TokenExpired' '' "$R_OK"
  expect PATCH "$p" patient "$PATIENT" "$m wrong-role" '403 Forbidden' '' "$R_OK"
  expect PATCH "$p" doctor-other "$DOC411" "$m other-doctor" '403 Forbidden' '' "$R_OK"
  expect PATCH "$p" doctor-self "$DOC410" "$m target-doctor-themself" '403 Forbidden' '' "$R_OK"
  expect PATCH "$p" admin-suspended "$ADMIN_SUSP" "$m admin-token-status-suspended" '403 Forbidden' '' "$R_OK"
  expect PATCH "$p" patient "$PATIENT" "$m spoofed-X-User-Id-ignored" '403 Forbidden' '' "$R_OK" '' 'X-User-Id: 1'
done
check_value /api/admin/doctors/410 none 'RBAC matrix: no suspension, no job, no Identity call' '0/0/0' "$(sql "select (suspended_at is not null)::int from doctor_profiles where user_id=410")/$(job_n 410 suspension)/$(fcount 410)"

# ---- 2. Validation, both routes (doctor 410, admin 11): nothing may reach Identity or the database ----
V='400 ValidationFailed'
LONG2001="$(node -e 'process.stdout.write("a".repeat(2001))')"
for op in SUSPEND REINSTATE; do
  p="$($op 410)"; m="${op,,}"; VADMIN="$(adm $([ $op = SUSPEND ] && echo 12 || echo 14))"
  expect PATCH "$p" admin "$VADMIN" "$m reason-missing" "$V" 'b.error.details.some(d=>d.field==="reason")' '{}'
  expect PATCH "$p" admin "$VADMIN" "$m body-missing" "$V" '' ''
  expect PATCH "$p" admin "$VADMIN" "$m reason-2-chars" "$V" 'b.error.details.some(d=>d.field==="reason")' '{"reason":"ab"}'
  expect PATCH "$p" admin "$VADMIN" "$m reason-2001-chars" "$V" 'b.error.details.some(d=>d.field==="reason")' "{\"reason\":\"$LONG2001\"}"
  expect PATCH "$p" admin "$VADMIN" "$m reason-control-character" "$V" '' '{"reason":"bad\u0007reason"}'
  expect PATCH "$p" admin "$VADMIN" "$m reason-number" "$V" '' '{"reason":12345}'
  expect PATCH "$p" admin "$VADMIN" "$m reason-null" "$V" '' '{"reason":null}'
  expect PATCH "$p" admin "$VADMIN" "$m unknown-member-actorUserId" "$V" '' '{"reason":"Synthetic QA reason","actorUserId":99}'
  expect PATCH "$p" admin "$VADMIN" "$m unknown-member-status" "$V" '' '{"reason":"Synthetic QA reason","status":"active"}'
  p2="/api/admin/doctors/abc/${m}"
  expect PATCH "$p2" admin "$VADMIN" "$m doctorUserId-non-numeric" "$V" '' "$R_OK"
  expect PATCH "/api/admin/doctors/0/${m}" admin "$VADMIN" "$m doctorUserId-zero" "$V" '' "$R_OK"
  expect PATCH "/api/admin/doctors/-1/${m}" admin "$VADMIN" "$m doctorUserId-negative" "$V" '' "$R_OK"
  expect PATCH "/api/admin/doctors/1.5/${m}" admin "$VADMIN" "$m doctorUserId-fractional" "$V" '' "$R_OK"
done
check_value /api/admin/doctors/410 none 'validation failures: no suspension, no job, no Identity call' '0/0/0' "$(sql "select (suspended_at is not null)::int from doctor_profiles where user_id=410")/$(job_n 410 suspension)/$(fcount 410)"

# ---- 3. 404 (no live profile) and 409 (preconditions), both routes ----
mkdoc 412 draft; mkdoc 413; mkdoc 414; mkdoc 415; mkdoc 416; mkdoc 417; mkdoc 418
sql "UPDATE doctor_profiles SET verification_status='submitted', submitted_at=now() WHERE user_id=413" >/dev/null
sql "UPDATE doctor_profiles SET verification_status='rejected', decided_at=now() WHERE user_id=414" >/dev/null
sql "UPDATE doctor_profiles SET identity_sync_status='pending' WHERE user_id=415" >/dev/null
sql "UPDATE doctor_profiles SET identity_sync_status='failed' WHERE user_id=416" >/dev/null
sql "UPDATE doctor_profiles SET deleted_at=now() WHERE user_id=418" >/dev/null
for op in SUSPEND REINSTATE; do
  m="${op,,}"
  expect PATCH "$($op 99999)" admin "$ADMIN13" "$m unknown-doctor" '404 NotFound' '' "$R_OK"
  expect PATCH "$($op 101)" admin "$ADMIN13" "$m patient-user-id-has-no-profile" '404 NotFound' '' "$R_OK"
  expect PATCH "$($op 418)" admin "$ADMIN13" "$m soft-deleted-profile" '404 NotFound' '' "$R_OK"
done
expect PATCH "$(SUSPEND 412)" admin "$ADMIN13" 'suspend draft-doctor' '409 InvalidTransition' '' "$R_OK"
expect PATCH "$(SUSPEND 413)" admin "$ADMIN13" 'suspend submitted-doctor' '409 InvalidTransition' '' "$R_OK"
expect PATCH "$(SUSPEND 414)" admin "$ADMIN13" 'suspend rejected-doctor' '409 InvalidTransition' '' "$R_OK"
expect PATCH "$(SUSPEND 415)" admin "$ADMIN13" 'suspend approved-but-sync-pending' '409 InvalidTransition' '' "$R_OK"
expect PATCH "$(SUSPEND 416)" admin "$ADMIN13" 'suspend approved-but-sync-failed' '409 InvalidTransition' '' "$R_OK"
check_value 'doctors 412-416' none 'rejected suspends: no job, no suspension, no Identity call' '0/0/0' "$(sql "select count(*) from doctor_profiles where user_id between 412 and 416 and suspended_at is not null")/$(sql "select count(*) from identity_sync_jobs where doctor_user_id between 412 and 416")/$(curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).patches.filter(p=>p.userId>=412&&p.userId<=416).length))')"
# reinstate on never-suspended doctors is a no-op 200 (BR13), even for non-approved ones
expect PATCH "$(REINSTATE 412)" admin "$ADMIN13" 'reinstate never-suspended draft-doctor (no-op)' 200 'b.data.doctorUserId===412' "$R_OK"
expect PATCH "$(REINSTATE 417)" admin "$ADMIN13" 'reinstate never-suspended approved-doctor (no-op)' 200 'b.data.identitySyncStatus==="synced" && typeof b.data.reinstatedAt==="string"' "$R_OK"
# suspended but sync pending/failed -> reinstate 409 (BR9), set up by owner SQL
sql "UPDATE doctor_profiles SET suspended_at=now(), suspended_by=1, suspension_reason='QA synthetic', identity_sync_status='pending' WHERE user_id=415" >/dev/null
sql "UPDATE doctor_profiles SET suspended_at=now(), suspended_by=1, suspension_reason='QA synthetic', identity_sync_status='failed' WHERE user_id=416" >/dev/null
expect PATCH "$(REINSTATE 415)" admin "$ADMIN13" 'reinstate suspended-but-suspension-sync-pending' '409 InvalidTransition' '' "$R_OK"
expect PATCH "$(REINSTATE 416)" admin "$ADMIN13" 'reinstate suspended-but-suspension-sync-failed' '409 InvalidTransition' '' "$R_OK"
check_value 'doctors 415,416' none 'rejected reinstates: still suspended, no job' '2/0' "$(sql "select count(*) from doctor_profiles where user_id in (415,416) and suspended_at is not null")/$(sql "select count(*) from identity_sync_jobs where doctor_user_id in (415,416)")"

# state <userId>: "<suspended 0|1>/<suspended_by>/<identity_sync_status>"
state() { sql "select (suspended_at is not null)::int||'/'||coalesce(suspended_by::text,'-')||'/'||identity_sync_status from doctor_profiles where user_id=$1"; }
jobs() { sql "select coalesce(string_agg(kind||':'||status, ',' order by id), 'none') from identity_sync_jobs where doctor_user_id=$1"; }
WH=/api/doctors/me/working-hours
sync_wait() { wait_sql "select identity_sync_status from doctor_profiles where user_id=$1" synced; }

# ---- 4. Happy path (doctor 420, Identity healthy) ----
mkdoc 420; A21="$(adm 21)"; D420="$(dtoken 420)"
expect PATCH "$(SUSPEND 420)" admin "$A21" 'suspend happy path, Identity healthy' 200 "$S_SHAPE && b.data.doctorUserId===420 && b.data.identitySyncStatus==='synced'" '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 420)" admin 'X-Request-Id forwarded to Identity' "$(cat "$TMP/rid")" "$(flast 420 requestId)"
check_value "$(SUSPEND 420)" admin 'Identity got one PATCH: suspended, actorUserId = token subject' '1/suspended/21' "$(fcount 420)/$(flast 420 status)/$(flast 420 actorUserId)"
check_value "$(SUSPEND 420)" admin 'Identity account status' suspended "$(fuser 420)"
check_value "$(SUSPEND 420)" admin 'local state: suspended / by admin 21 / synced; job succeeded' '1/21/synced|suspension:succeeded' "$(state 420)|$(jobs 420)"
check_value /api/doctors/me doctor 'doctor view: isSuspended / isBookable / sync' 'true/false/synced' "$(dview 420)"
expect PUT "$WH" doctor "$D420" 'suspended doctor blocked from doctor actions (doctor_not_suspended)' '403 Forbidden' '' '{"days":[]}'
check_value audit-logs admin 'audit: doctor.suspended x1, identity_sync.synced x1 (actor admin), reason text absent' '1/1/0' "$(audit_n 420 doctor.suspended)/$(sql "select count(*) from audit_logs where action='identity_sync.synced' and actor_role='admin' and entity_id=$(pid 420)")/$(sql "select count(*) from audit_logs where metadata::text like '%Synthetic QA reason%'")"
expect PATCH "$(SUSPEND 420)" admin "$A21" 're-suspend already suspended + synced (no-op)' 200 "$S_SHAPE" '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 420)" admin 'no-op: suspendedAt equals the committed value, no new PATCH, job, or audit row' "$(sql "select to_char(suspended_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS')||'/1/1/1' from doctor_profiles where user_id=420")" "$(js 'b.data.suspendedAt.slice(0,19)')/$(fcount 420)/$(job_n 420 suspension)/$(audit_n 420 doctor.suspended)"
expect PATCH "$(REINSTATE 420)" admin "$A21" 'reinstate happy path, Identity healthy' 200 "b.data.doctorUserId===420 && b.data.identitySyncStatus==='synced' && typeof b.data.reinstatedAt==='string' && !Number.isNaN(Date.parse(b.data.reinstatedAt)) && b.identitySync===undefined" '{"reason":"Synthetic QA reason"}'
check_value "$(REINSTATE 420)" admin 'X-Request-Id forwarded to Identity' "$(cat "$TMP/rid")" "$(flast 420 requestId)"
check_value "$(REINSTATE 420)" admin 'Identity got PATCH active; account active' '2/active/21/active' "$(fcount 420)/$(flast 420 status)/$(flast 420 actorUserId)/$(fuser 420)"
check_value "$(REINSTATE 420)" admin 'local state: unsuspended / synced; reinstatement job succeeded' '0/-/synced|suspension:succeeded,reinstatement:succeeded' "$(state 420)|$(jobs 420)"
check_value /api/doctors/me doctor 'doctor view after reinstate: bookable again' 'false/true/synced' "$(dview 420)"
expect PUT "$WH" doctor "$D420" 'reinstated doctor can use doctor actions again' 200 '' '{"days":[]}'
check_value audit-logs admin 'audit: doctor.reinstated x1' 1 "$(audit_n 420 doctor.reinstated)"
expect PATCH "$(REINSTATE 420)" admin "$A21" 'reinstate not-suspended doctor (no-op, S7/BR13)' 200 "b.data.identitySyncStatus==='synced' && b.identitySync===undefined"  '{"reason":"Synthetic QA reason"}'
check_value "$(REINSTATE 420)" admin 'no-op: no new PATCH, job, or audit row' '2/2/1' "$(fcount 420)/$(sql "select count(*) from identity_sync_jobs where doctor_user_id=420")/$(audit_n 420 doctor.reinstated)"

# ---- 5. Suspend with Identity down: 503, durable job, worker converges (doctor 421) ----
mkdoc 421; A22="$(adm 22)"; D421="$(dtoken 421)"
ctl down
expect PATCH "$(SUSPEND 421)" admin "$A22" 'suspend, Identity down (5xx)' '503 IdentityUnavailable' "b.suspension==='applied-locally, session-revocation-pending' && b.data.identitySyncStatus==='pending' && b.data.doctorUserId===421 && typeof b.data.suspendedAt==='string' && Array.isArray(b.data.flaggedConsultationIds) && b.success===false" '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 421)" admin '503: at least the 3 inline attempts reached Identity' 1 "$([ "$(fcount 421)" -ge 3 ] && echo 1 || echo 0)"
check_value "$(SUSPEND 421)" admin '503: suspended locally, sync pending, one suspension job pending' '1/22/pending|suspension:pending' "$(state 421)|$(jobs 421)"
check_value /api/doctors/me doctor 'doctor view while pending: suspended, unbookable' 'true/false/pending' "$(dview 421)"
expect PUT "$WH" doctor "$D421" 'locally suspended doctor blocked while Identity is unconfirmed' '403 Forbidden' '' '{"days":[]}'
check_value audit-logs admin 'audit: doctor.suspended x1, identity_sync.pending x1' '1/1' "$(audit_n 421 doctor.suspended)/$(audit_n 421 identity_sync.pending)"
BEFORE="$(fcount 421)"
expect PATCH "$(SUSPEND 421)" admin "$A22" 're-suspend while pending (S6): same 503, not 200' '503 IdentityUnavailable' "b.suspension==='applied-locally, session-revocation-pending' && b.data.identitySyncStatus==='pending'" '{"reason":"Synthetic QA reason"}'
AFTER="$(fcount 421)"
check_value "$(SUSPEND 421)" admin 'S6 re-suspend: no new job/audit row, no inline attempts (at most 1 worker attempt)' '1/1/1' "$(job_n 421 suspension)/$(audit_n 421 doctor.suspended)/$([ $((AFTER-BEFORE)) -le 1 ] && echo 1 || echo 0)"
check_true internal-job doctor 'worker keeps retrying with no attempt cap: consecutive_failures >= 3 while job stays pending' "$(wait_sql "select (consecutive_failures>=3 and status='pending')::int from identity_sync_jobs where doctor_user_id=421" 1 150 && echo 1 || echo 0)"
if [ -n "${WORKER_LOG:-}" ]; then
  check_true worker-log observer 'IdentitySuspensionSyncFailing page logged' "$([ "$(tail -n +"$((LOG_MARK_WORKER+1))" "$WORKER_LOG" | grep -c 'IdentitySuspensionSyncFailing' || true)" -ge 1 ] && echo 1 || echo 0)"
fi
ctl healthy
check_true internal-job doctor 'Identity back: worker converges the job to synced' "$(sync_wait 421 && echo 1 || echo 0)"
check_value "$(SUSPEND 421)" admin 'converged: state synced, job succeeded, Identity suspended' '1/22/synced|suspension:succeeded|suspended' "$(state 421)|$(jobs 421)|$(fuser 421)"
check_value audit-logs system 'audit: identity_sync.synced written by actor system' 1 "$(sql "select count(*) from audit_logs where action='identity_sync.synced' and actor_role='system' and entity_id=$(pid 421)")"
check_value /api/doctors/me doctor 'doctor view after convergence' 'true/false/synced' "$(dview 421)"
C421="$(fcount 421)"
expect PATCH "$(SUSPEND 421)" admin "$A22" 'suspend after convergence (no-op, synced -> 200)' 200 "$S_SHAPE && b.data.identitySyncStatus==='synced'" '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 421)" admin 'no Identity call by the no-op' "$C421" "$(fcount 421)"

# ---- 6. Suspend with Identity hanging (timeouts) (doctor 422) ----
mkdoc 422; A23="$(adm 23)"
ctl hang
expect PATCH "$(SUSPEND 422)" admin "$A23" 'suspend, Identity hangs (client timeout)' '503 IdentityUnavailable' "b.suspension==='applied-locally, session-revocation-pending' && b.data.identitySyncStatus==='pending'" '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 422)" admin 'hang: suspended locally, job pending' '1/23/pending|suspension:pending' "$(state 422)|$(jobs 422)"
ctl healthy
check_true internal-job doctor 'hang cleared: worker converges to synced' "$(sync_wait 422 && echo 1 || echo 0)"
check_value "$(SUSPEND 422)" admin 'hang converged: Identity suspended' 'suspended' "$(fuser 422)"

# ---- 7. Identity answers 409 InvalidStatusTransition: failed, no retry loop (doctors 423, 424) ----
mkdoc 423; A24="$(adm 24)"
ctl conflict
expect PATCH "$(SUSPEND 423)" admin "$A24" 'suspend, Identity 409' '503 IdentityUnavailable' "b.suspension==='applied-locally, session-revocation-pending' && b.data.identitySyncStatus==='failed'" '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 423)" admin '409: exactly one Identity call (no inline retry); local suspension kept; job failed' '1|1/24/failed|suspension:failed' "$(fcount 423)|$(state 423)|$(jobs 423)"
check_value internal-job system 'job last_error_code' InvalidStatusTransition "$(sql "select last_error_code from identity_sync_jobs where doctor_user_id=423")"
check_value /api/doctors/me doctor 'doctor view after 409' 'true/false/failed' "$(dview 423)"
sleep 25   # two or more worker polls (10 s each)
check_value "$(SUSPEND 423)" system 'no retry loop: still one Identity call 25 s later (>= 2 worker ticks)' 1 "$(fcount 423)"
if [ -n "${WORKER_LOG:-}" ] || [ -n "${SERVER_LOG:-}" ]; then
  n=0; [ -z "${SERVER_LOG:-}" ] || n=$((n + $(tail -n +"$((LOG_MARK_API+1))" "$SERVER_LOG" | grep -c 'IdentitySyncTransitionRejected' || true)))
  [ -z "${WORKER_LOG:-}" ] || n=$((n + $(tail -n +"$((LOG_MARK_WORKER+1))" "$WORKER_LOG" | grep -c 'IdentitySyncTransitionRejected' || true)))
  check_true logs observer 'IdentitySyncTransitionRejected page logged' "$([ "$n" -ge 1 ] && echo 1 || echo 0)"
fi
expect PATCH "$(SUSPEND 423)" admin "$A24" 're-suspend while failed (S6): same 503, data failed' '503 IdentityUnavailable' "b.data.identitySyncStatus==='failed'" '{"reason":"Synthetic QA reason"}'
expect PATCH "$(REINSTATE 423)" admin "$A24" 'reinstate while suspension sync failed' '409 InvalidTransition' '' '{"reason":"Synthetic QA reason"}'
check_value "$(SUSPEND 423)" admin 'still one Identity call, one job, one audit row' '1/1/1' "$(fcount 423)/$(job_n 423 suspension)/$(audit_n 423 doctor.suspended)"
ctl healthy

mkdoc 424; A25="$(adm 25)"
expect PATCH "$(SUSPEND 424)" admin "$A25" 'suspend for the reinstate-409 case' 200 "$S_SHAPE" '{"reason":"Synthetic QA reason"}'
ctl conflict
expect PATCH "$(REINSTATE 424)" admin "$A25" 'reinstate, Identity 409' 202 "b.identitySync==='failed' && b.data.identitySyncStatus==='failed' && b.data.doctorUserId===424 && typeof b.data.reinstatedAt==='string'" '{"reason":"Synthetic QA reason"}'
check_value "$(REINSTATE 424)" admin 'reinstate 409: unsuspended locally, sync failed, one extra Identity call' '2|0/-/failed|suspension:succeeded,reinstatement:failed' "$(fcount 424)|$(state 424)|$(jobs 424)"
check_value /api/doctors/me doctor 'doctor view: not suspended but unbookable' 'false/false/failed' "$(dview 424)"
sleep 25
check_value "$(REINSTATE 424)" system 'no retry loop after reinstate 409' 2 "$(fcount 424)"
expect PATCH "$(REINSTATE 424)" admin "$A25" 'reinstate again while failed (S6): 202 failed re-report' 202 "b.identitySync==='failed' && b.data.identitySyncStatus==='failed'" '{"reason":"Synthetic QA reason"}'
expect PATCH "$(SUSPEND 424)" admin "$A25" 'suspend while reinstatement unsynced (S7)' '409 InvalidTransition' '' '{"reason":"Synthetic QA reason"}'
check_value "$(REINSTATE 424)" admin 'no extra PATCH, one reinstatement job, one doctor.reinstated audit row' '2/1/1' "$(fcount 424)/$(job_n 424 reinstatement)/$(audit_n 424 doctor.reinstated)"
ctl healthy

# ---- 8. Reinstate with Identity down: 202 pending, then converge (doctor 425) ----
mkdoc 425; A26="$(adm 26)"; D425="$(dtoken 425)"
expect PATCH "$(SUSPEND 425)" admin "$A26" 'suspend for the reinstate-down case' 200 "$S_SHAPE" '{"reason":"Synthetic QA reason"}'
ctl down
expect PATCH "$(REINSTATE 425)" admin "$A26" 'reinstate, Identity down' 202 "b.identitySync==='pending' && b.data.identitySyncStatus==='pending' && b.data.doctorUserId===425 && Object.keys(b).includes('data')" '{"reason":"Synthetic QA reason"}'
check_value "$(REINSTATE 425)" admin 'reinstate pending: >= 3 inline attempts, unsuspended locally, reinstatement job pending' "1|0/-/pending|suspension:succeeded,reinstatement:pending" "$([ "$(fcount 425)" -ge 4 ] && echo 1 || echo 0)|$(state 425)|$(jobs 425)"
check_value /api/doctors/me doctor 'doctor view: not suspended, still unbookable until synced' 'false/false/pending' "$(dview 425)"
expect PUT "$WH" doctor "$D425" 'doctor-action guards pass once unsuspended (even while sync pending)' 200 '' '{"days":[]}'
expect PATCH "$(REINSTATE 425)" admin "$A26" 'blind retry while pending (S6): 202 pending, no new job' 202 "b.identitySync==='pending'" '{"reason":"Synthetic QA reason"}'
expect PATCH "$(SUSPEND 425)" admin "$A26" 'suspend while reinstatement unsynced (S7)' '409 InvalidTransition' '' '{"reason":"Synthetic QA reason"}'
check_value "$(REINSTATE 425)" admin 'one reinstatement job, one suspension job, one doctor.reinstated audit row' '1/1/1' "$(job_n 425 reinstatement)/$(job_n 425 suspension)/$(audit_n 425 doctor.reinstated)"
ctl healthy
check_true internal-job doctor 'Identity back: worker converges the reinstatement to synced' "$(sync_wait 425 && echo 1 || echo 0)"
check_value "$(REINSTATE 425)" admin 'converged: Identity active, job succeeded' 'active|suspension:succeeded,reinstatement:succeeded' "$(fuser 425)|$(jobs 425)"
check_value /api/doctors/me doctor 'doctor view after convergence: bookable again' 'false/true/synced' "$(dview 425)"
check_value audit-logs system 'audit: reinstatement identity_sync.synced by actor system' 1 "$(sql "select count(*) from audit_logs where action='identity_sync.synced' and actor_role='system' and entity_id=$(pid 425)")"
expect PATCH "$(REINSTATE 425)" admin "$A26" 'reinstate after convergence (no-op, 200)' 200 "b.data.identitySyncStatus==='synced' && b.identitySync===undefined" '{"reason":"Synthetic QA reason"}'

# ---- 9. Idempotency-Key (doctors 426, 427) ----
mkdoc 426; mkdoc 427; A27="$(adm 27)"
K1="$(uuid)"; K2="$(uuid)"; K3="$(uuid)"
expect PATCH "$(SUSPEND 426)" admin "$A27" 'suspend with Idempotency-Key (first)' 200 "$S_SHAPE" '{"reason":"Synthetic QA reason"}' "$K1"
cp "$TMP/body" "$TMP/idem1"
expect PATCH "$(SUSPEND 426)" admin "$A27" 'same key + same body replays the stored 200' 200 "$S_SHAPE" '{"reason":"Synthetic QA reason"}' "$K1"
check_value "$(SUSPEND 426)" admin 'replay body is byte-identical; one Identity call; one job' "identical;1;1" "$([ "$(cat "$TMP/idem1")" = "$(cat "$TMP/body")" ] && echo identical || echo DIFFERENT);$(fcount 426);$(job_n 426 suspension)"
expect PATCH "$(SUSPEND 426)" admin "$A27" 'same key + different body' '422 IdempotencyConflict' '' '{"reason":"A different synthetic reason"}' "$K1"
expect PATCH "$(SUSPEND 426)" admin "$A27" 'Idempotency-Key not a UUID' '400 ValidationFailed' '' '{"reason":"Synthetic QA reason"}' 'not-a-uuid'
ctl down
expect PATCH "$(REINSTATE 426)" admin "$A27" 'reinstate with key, Identity down (first)' 202 "b.identitySync==='pending'" '{"reason":"Synthetic QA reason"}' "$K2"
cp "$TMP/body" "$TMP/idem2"
expect PATCH "$(REINSTATE 426)" admin "$A27" 'same key replays the stored 202' 202 "b.identitySync==='pending'" '{"reason":"Synthetic QA reason"}' "$K2"
check_value "$(REINSTATE 426)" admin 'stored 202 replayed byte-identically; one reinstatement job; one audit row' "identical;1;1" "$([ "$(cat "$TMP/idem2")" = "$(cat "$TMP/body")" ] && echo identical || echo DIFFERENT);$(job_n 426 reinstatement);$(audit_n 426 doctor.reinstated)"
expect PATCH "$(REINSTATE 426)" admin "$A27" 'reinstate same key + different body' '422 IdempotencyConflict' '' '{"reason":"A different synthetic reason"}' "$K2"
expect PATCH "$(SUSPEND 427)" admin "$A27" 'suspend with key, Identity down (503)' '503 IdentityUnavailable' "b.data.identitySyncStatus==='pending'" '{"reason":"Synthetic QA reason"}' "$K3"
ctl healthy
check_true internal-job doctor 'doctors 426 and 427 converge after Identity returns' "$(sync_wait 426 && sync_wait 427 && echo 1 || echo 0)"
expect PATCH "$(SUSPEND 427)" admin "$A27" 'same key after a 503: not stored, re-executes (now the synced no-op -> 200)' 200 "$S_SHAPE && b.data.identitySyncStatus==='synced'" '{"reason":"Synthetic QA reason"}' "$K3"

# ---- 10. Concurrency: two parallel suspends on doctor 429 ----
mkdoc 429; A28="$(adm 28)"
for i in 1 2; do
  (curl -sS -o "$TMP/par$i" -w '%{http_code}' -X PATCH -H "Authorization: Bearer $A28" -H 'Content-Type: application/json' -H "X-Request-Id: $(uuid)" --data-binary '{"reason":"Synthetic QA reason"}' "$CARE_URL$(SUSPEND 429)" > "$TMP/parcode$i") &
done
wait
PAR="$(cat "$TMP/parcode1") $(cat "$TMP/parcode2")"
check_true "$(SUSPEND 429)" admin "two parallel suspends both answer 200 or 503 (got: $PAR)" "$(case "$PAR" in "200 200"|"200 503"|"503 200"|"503 503") echo 1;; *) echo 0;; esac)"
sync_wait 429 || true
check_value "$(SUSPEND 429)" admin 'exactly one job, one doctor.suspended row, one Identity PATCH' '1/1/1' "$(job_n 429 suspension)/$(audit_n 429 doctor.suspended)/$(fcount 429)"

# ---- 11. Reason handling: 500 code point clamp towards Identity, full text stored locally (doctor 428) ----
mkdoc 428; A29="$(adm 29)"
BIG="$(node -e "process.stdout.write('$MARK'+'y'.repeat(1979))")"
expect PATCH "$(SUSPEND 428)" admin "$A29" 'suspend with a 2000-char reason (max allowed)' 200 "$S_SHAPE && b.data.identitySyncStatus==='synced'" "{\"reason\":\"$BIG\"}"
check_value "$(SUSPEND 428)" admin 'Identity received exactly 500 code points; Care stored all 2000' '500/2000' "$(flast 428 reasonCodePoints)/$(sql "select char_length(suspension_reason) from doctor_profiles where user_id=428")"
expect PATCH "$(REINSTATE 428)" admin "$A29" 'reinstate with a 3-char reason (min allowed)' 200 "b.data.identitySyncStatus==='synced'" '{"reason":"abc"}'
check_value "$(REINSTATE 428)" admin 'Identity received the 3-char reason untouched' 3 "$(flast 428 reasonCodePoints)"
EMOJI="$(node -e 'process.stdout.write("\u{1F600}".repeat(600))')"
expect PATCH "$(SUSPEND 428)" admin "$A29" 'suspend with a 600-emoji reason (1200 UTF-16 units)' 200 "b.data.identitySyncStatus==='synced'" "{\"reason\":\"$EMOJI\"}"
check_value "$(SUSPEND 428)" admin 'emoji reason clamped to exactly 500 code points (no split surrogate; Identity accepted)' '500/suspended' "$(flast 428 reasonCodePoints)/$(fuser 428)"
expect PATCH "$(REINSTATE 428)" admin "$A29" 'reinstate after emoji case' 200 "b.data.identitySyncStatus==='synced'" '{"reason":"abc"}'
check_value audit-logs observer 'reason marker/text never in audit metadata' 0 "$(sql "select count(*) from audit_logs where metadata::text like '%$MARK%' or metadata::text like '%Synthetic QA reason%'")"
if [ -n "${SERVER_LOG:-}" ]; then
  check_value server-log observer 'reason marker/text never in the care-api log' 0 "$(tail -n +"$((LOG_MARK_API+1))" "$SERVER_LOG" | grep -c -e "$MARK" -e 'Synthetic QA reason' || true)"
fi
if [ -n "${WORKER_LOG:-}" ]; then
  check_value worker-log observer 'reason marker/text never in the care-worker log' 0 "$(tail -n +"$((LOG_MARK_WORKER+1))" "$WORKER_LOG" | grep -c -e "$MARK" -e 'Synthetic QA reason' || true)"
fi

# ---- 12. Rate limit: admin-write 30/min per admin, shared by both routes ----
A90="$(adm 90)"; ok=1
for i in $(seq 1 30); do
  [ "$(call PATCH "$(SUSPEND 99999)" "$A90" "$R_OK")" = 404 ] || ok=0
done
check_true admin-doctors-write admin 'first 30 requests in the window are not limited (404 for the absent doctor)' "$ok"
expect PATCH "$(REINSTATE 99999)" admin "$A90" 'request 31 (other route, same bucket)' '429 RateLimited' ''  "$R_OK"
check_true admin-doctors-write admin 'Retry-After present on 429' "$(grep -qi '^retry-after:' "$TMP/headers" && echo 1 || echo 0)"

echo "RESULT: $PASS pass / $FAIL fail"
[ "$FAIL" = 0 ]
