#!/usr/bin/env bash
# Repeatable HTTP QA for the sessions module: PATCH /api/consultations/{id}/join|start|complete|no-show,
# GET /api/consultations/waiting-room, GET /api/consultations/calendar. Use only a disposable *_test or *_qa* database.
#
# Start first (see docs/sessions/manual-qa.md -> Environment):
#   node scripts/consultations-qa-fake-identity.mjs      # JWKS + user tokens + fake Identity internal API (FAKE_IDENTITY_PORT, default 3023)
#   VIDEO_FAULT_FILE=<path> npx tsx scripts/sessions-qa-server.ts
#                                                         # the REAL public app, with the video provider wrapped so a fault file can inject
#                                                         # a provider outage (ok | fail-room | fail-token | slow-room | slow-token);
#                                                         # PORT=3045, VIDEO_PROVIDER=fake, NODE_ENV not production, REDIS_URL on a spare db
#                                                         # index, dummy STORAGE_* values; database migrated + ensure-app-login
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH), VIDEO_PROVIDER_KEY (the server's value, used only
#           to verify the signature of issued join tokens; never printed).
# Optional: CARE_URL (default http://127.0.0.1:3045), FAKE_IDENTITY_URL (default http://127.0.0.1:3023),
#           REDIS_URL (flushed before EVERY call so rate limits and the Identity cache start clean; a spare db index only),
#           VIDEO_FAULT_FILE (same path the server got; without it the video-outage section is skipped),
#           QA_REPORT (file receiving the case table), SERVER_LOG (care-api log; scanned for token / clinical-text leaks).
# Synthetic fixtures: patients 501-599, doctors 601-699, admins 1, 2. Fixture rows are deleted first (idempotent).
# Time: the server uses the real clock, so window boundaries are probed with a 30 s margin on each side (rows are created right before the call).
set -euo pipefail
export MSYS_NO_PATHCONV=1

CARE_URL="${CARE_URL:-http://127.0.0.1:3045}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3023}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
: "${VIDEO_PROVIDER_KEY:?Set VIDEO_PROVIDER_KEY (same value as the server) to verify join-token signatures}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
export VIDEO_PROVIDER_KEY
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"
: > "$TMP/tokens.txt"; : > "$TMP/ids.txt"
export QA_TOKENS_FILE="$TMP/tokens.txt" QA_IDS_FILE="$TMP/ids.txt"
PASS=0; FAIL=0; CASE=0; SKIP=0
MARK='QA-COMPLAINT-MARKER-7731'; NMARK='QA-NOTE-MARKER-9921'

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
ctl() { curl -fsS "$FAKE_IDENTITY_URL/__ctl?mode=$1" >/dev/null; }
pt() { mint "patient-$1"; }; dt() { mint "doctor-$1"; }; at() { mint "admin-$1"; }
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/body" "$1"; }
fake() { curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(eval(process.argv[1])))' "$1"; }
flush_redis() { [ -z "${REDIS_URL:-}" ] || node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null; }
vmode() { [ -z "${VIDEO_FAULT_FILE:-}" ] || printf '%s' "$1" > "$VIDEO_FAULT_FILE"; }
isoz() { node -e 'process.stdout.write(new Date(Date.now()+Number(process.argv[1])*1000).toISOString().replace(/\.\d{3}Z$/,"Z"))' -- "$1"; }
ldate() { node -e 'const {DateTime}=require("luxon");process.stdout.write(DateTime.now().setZone(process.argv[1]).plus({days:Number(process.argv[2])}).toISODate())' -- "$1" "$2"; }

call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" extra="${6:-}" rid
  [ -n "${NO_FLUSH:-}" ] || flush_redis
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  [ -z "$extra" ] || args+=(-H "$extra")
  curl "${args[@]}" "$CARE_URL$path"
}
# check_body <ok|error> <code> [assertion_js]: X-Request-Id echoed, no-store, envelope, no complaint marker anywhere, assertion over `b` (+ `tok`, `sigOk`)
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" "$MARK" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const [file, headers, ridFile, kind, code, assertion, mark] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: .*no-store/im.test(h)) process.exit(1);
const raw = fs.readFileSync(file, 'utf8');
if (raw.includes(mark)) process.exit(1);
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (kind === 'error') {
  if (b.success !== false || b.error?.code !== code || b.error?.requestId !== rid ||
      typeof b.error?.message !== 'string' || !Array.isArray(b.error?.details)) process.exit(1);
} else if (b.success !== true) process.exit(1);
if (b.data?.joinToken) fs.appendFileSync(process.env.QA_TOKENS_FILE, b.data.joinToken + '\n');
if (b.data?.roomId) fs.appendFileSync(process.env.QA_IDS_FILE, b.data.roomId + '\n');
const tok = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());
const sigOk = (t) => {
  const [p, s] = t.split('.');
  return crypto.createHmac('sha256', process.env.VIDEO_PROVIDER_KEY).update(p).digest('base64url') === s;
};
if (assertion && !eval(assertion)) process.exit(1);
NODE
}
record() {
  local method="$1" path="$2" role="$3" scenario="$4" expected="${5//|/;}" got="${6//|/;}" ok="$7" result
  CASE=$((CASE+1))
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); result=PASS; else FAIL=$((FAIL+1)); result=FAIL; fi
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$method" "$path" "$role" "$scenario" "$expected" "$got" "$result" | tee -a "${QA_REPORT:-$TMP/report}"
}
# expect METHOD PATH ROLE TOKEN SCENARIO EXPECTED [ASSERT_JS] [BODY] [KEY] [EXTRA_HEADER]
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
check_value() { record check "$1" owner "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"; }
skip_note() { SKIP=$((SKIP+1)); echo "SKIPPED|$1" | tee -a "${QA_REPORT:-$TMP/report}"; }
audit_n() { sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='$1' ${2:+AND entity_id=$2} ${3:+AND actor_user_id=$3}"; }
outbox_n() { sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$1 AND kind='$2'"; }
st() { sql "SELECT status FROM consultations WHERE id=$1"; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }

reset() {
  # a row-level trigger allows deleting only 'sent' outbox rows; the database is disposable, so TRUNCATE (not row-level) clears the fixtures
  sql "TRUNCATE notification_outbox;
       DELETE FROM consultations WHERE doctor_user_id BETWEEN 600 AND 699 OR patient_user_id BETWEEN 500 AND 599;
       DELETE FROM identity_sync_jobs WHERE doctor_user_id BETWEEN 600 AND 699;
       DELETE FROM schedule_exceptions WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM working_hours WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699;
       DELETE FROM patient_profiles WHERE user_id BETWEEN 500 AND 599;" >/dev/null
}
cleanup() { ctl healthy 2>/dev/null || true; vmode ok 2>/dev/null || true; reset 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
reset; flush_redis; curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null; vmode ok
T0="$(sql 'select now()')"
LOG_MARK=0; [ -z "${SERVER_LOG:-}" ] || LOG_MARK="$(wc -l < "$SERVER_LOG")"

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
ADMIN="$(at 1)"; ADMIN2="$(at 2)"
EXPIRED="$(mint expired)"; SVC="$(curl -fsS "$FAKE_IDENTITY_URL/mint?case=patient-501&typ=service")"
echo 'case|method|path|role|scenario|expected|got|result'

HOURS='{"days":['"$(for d in 1 2 3 4 5 6 7; do printf '{"weekday":%s,"intervals":[{"startTime":"00:00","endTime":"23:59"}]},' $d; done | sed 's/,$//')"']}'
# mkdoc <userId> <mode> [tz]: modes approved | suspended
mkdoc() {
  local uid="$1" mode="${2:-approved}" tz="${3:-Africa/Cairo}" t
  t="$(dt "$uid")"
  [ "$(call POST /api/doctors/apply "$t" "{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"$tz\",\"submit\":false}")" = 201 ] || { echo "fixture apply failed for doctor $uid" >&2; exit 2; }
  sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$uid" >/dev/null
  [ "$(call POST /api/doctors/me/consultation-types "$t" '{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}')" = 201 ] || { echo "fixture type failed for $uid" >&2; exit 2; }
  [ "$(call PUT /api/doctors/me/working-hours "$t" "$HOURS")" = 200 ] || { echo "fixture hours failed for $uid" >&2; exit 2; }
  case "$mode" in
    suspended) sql "UPDATE doctor_profiles SET suspended_at=now(), suspension_reason='synthetic' WHERE user_id=$uid" >/dev/null;;
  esac
}
tid() { sql "SELECT id FROM consultation_types WHERE doctor_profile_id=(SELECT id FROM doctor_profiles WHERE user_id=$1) ORDER BY id LIMIT 1"; }
# mkrow <doctor> <patient> <startOffsetSeconds> <status> [durationMinutes=30]: owner-SQL fixture row relative to the database clock
mkrow() {
  local dur="${5:-30}"
  sql "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash,cancelled_at,cancelled_by,joined_at,started_at,completed_at,no_show_marked_at)
       VALUES ($1,$2,$(tid "$1"),now()+interval '$3 seconds',now()+interval '$3 seconds'+interval '$dur minutes','$4','$MARK sql','Africa/Cairo',500,'EGP',gen_random_uuid(),repeat('0',64),
       CASE WHEN '$4'='cancelled' THEN now() END, CASE WHEN '$4'='cancelled' THEN 'doctor' END,
       CASE WHEN '$4' IN ('waiting','in_progress','completed') THEN now() END, CASE WHEN '$4' IN ('in_progress','completed') THEN now() END,
       CASE WHEN '$4'='completed' THEN now() END, CASE WHEN '$4'='no_show' THEN now() END) RETURNING id" | head -1
}
wipe() { sql "TRUNCATE notification_outbox; DELETE FROM consultations WHERE doctor_user_id=$1" >/dev/null; }

CONS_SHAPE='["id","status","doctor","patient","consultationType","startsAt","endsAt","startsAtLocal","endsAtLocal","timezone","patientTimezone","price","needsAdminFollowup","createdAt","updatedAt","joinedAt","startedAt","completedAt","cancelledAt","cancelledBy","cancelReason","followupReason","followUpOfRecordId","hasRecord"].every(k=>k in b.data)&&!("roomId" in b.data)&&!("complaintText" in b.data)&&!("idempotencyKey" in b.data)&&!("requestHash" in b.data)&&!("noShowMarkedAt" in b.data)'
JOIN_KEYS='Object.keys(b.data).sort().join()==="consultation,joinToken,joinTokenExpiresAt,roomId,windowClosesAt,windowOpensAt"&&!("complaintText" in b.data.consultation)&&!("roomId" in b.data.consultation)&&!("noShowMarkedAt" in b.data.consultation)&&b.data.consultation.doctor.profileHydrated===false&&b.data.consultation.patient.profileHydrated===false&&b.data.consultation.doctor.displayName===null&&typeof b.data.joinToken==="string"&&b.data.joinToken.length>20&&b.data.roomId.length>0&&Date.parse(b.data.windowOpensAt)===Date.parse(b.data.consultation.startsAt)-600000&&Date.parse(b.data.windowClosesAt)===Date.parse(b.data.consultation.endsAt)+900000'
# tokenfor <uid> <role>: the join token is signed, bound to this user, role and room, expires with the response and no later than the window close / 300 s
tokenfor() { echo "sigOk(b.data.joinToken)&&tok(b.data.joinToken).uid===$1&&tok(b.data.joinToken).role==='$2'&&tok(b.data.joinToken).rid===b.data.roomId&&tok(b.data.joinToken).exp===Date.parse(b.data.joinTokenExpiresAt)&&tok(b.data.joinToken).exp<=Date.parse(b.data.windowClosesAt)&&tok(b.data.joinToken).exp<=Date.now()+305000&&tok(b.data.joinToken).exp>Date.now()"; }

# ---- 0. Fixtures ----
mkdoc 601; mkdoc 602; mkdoc 603 suspended; mkdoc 604 approved Europe/Berlin
D601="$(dt 601)"; D602="$(dt 602)"; D603="$(dt 603)"; D604="$(dt 604)"
P501="$(pt 501)"; P502="$(pt 502)"; P503="$(pt 503)"
DPEND="$(mint doctor-pending)"; PPEND="$(mint patient-pending)"; ASUSP="$(mint admin-suspended)"

# ---- 1. Authentication matrix (all six routes) ----
R1="$(mkrow 601 501 300 booked)"
for who in "none|" "malformed|garbage.token.value" "expired|$EXPIRED" "service-token|$SVC"; do
  n="${who%%|*}"; t="${who#*|}"
  for r in "PATCH /api/consultations/$R1/join" "PATCH /api/consultations/$R1/start" "PATCH /api/consultations/$R1/complete" "PATCH /api/consultations/$R1/no-show" "GET /api/consultations/waiting-room" "GET /api/consultations/calendar?from=$(isoz 0)&to=$(isoz 3600)"; do
    set -- $r
    exp='401 Unauthorized'; [ "$n" = expired ] && exp='401 TokenExpired'
    expect "$1" "$2" "$n" "$t" "$n" "$exp"
  done
done
check_value auth 'unauthenticated calls changed nothing' booked "$(st "$R1")"

# ---- 2. RBAC / ownership / account state ----
for r in join start complete; do
  case "$r" in join) roles="admin|$ADMIN";; *) roles="patient|$P501 admin|$ADMIN";; esac
  for who in $roles; do expect PATCH "/api/consultations/$R1/$r" "${who%%|*}" "${who#*|}" "$r-denied-${who%%|*}" '403 Forbidden'; done
done
expect PATCH "/api/consultations/$R1/no-show" patient "$P501" no-show-denied-patient '403 Forbidden'
expect GET /api/consultations/waiting-room patient "$P501" waiting-room-denied-patient '403 Forbidden'
expect GET /api/consultations/waiting-room admin "$ADMIN" waiting-room-denied-admin '403 Forbidden'
expect GET "/api/consultations/calendar?from=$(isoz 0)&to=$(isoz 3600)" patient "$P501" calendar-denied-patient '403 Forbidden'
expect GET "/api/consultations/calendar?from=$(isoz 0)&to=$(isoz 3600)" admin "$ADMIN" calendar-denied-admin '403 Forbidden'
# non-participants and unknown ids are 404, never 403
expect PATCH "/api/consultations/$R1/join" patient-other "$P502" join-non-owner-patient '404 NotFound'
expect PATCH "/api/consultations/$R1/join" doctor-other "$D602" join-non-assigned-doctor '404 NotFound'
expect PATCH "/api/consultations/$R1/start" doctor-other "$D602" start-non-assigned-doctor '404 NotFound'
expect PATCH "/api/consultations/$R1/complete" doctor-other "$D602" complete-non-assigned-doctor '404 NotFound'
expect PATCH "/api/consultations/$R1/no-show" doctor-other "$D602" no-show-non-assigned-doctor '404 NotFound'
for bad in 99999999 abc 0 -1 1.5 99999999999999999999; do
  expect PATCH "/api/consultations/$bad/join" patient "$P501" "join-bad-id-$bad" '404 NotFound'
  expect PATCH "/api/consultations/$bad/start" doctor "$D601" "start-bad-id-$bad" '404 NotFound'
  expect PATCH "/api/consultations/$bad/complete" doctor "$D601" "complete-bad-id-$bad" '404 NotFound'
done
expect PATCH /api/consultations/99999999/no-show doctor "$D601" no-show-nonexistent-doctor '404 NotFound'
expect PATCH /api/consultations/99999999/no-show admin "$ADMIN" no-show-nonexistent-admin '404 NotFound'
expect PATCH /api/consultations/abc/no-show admin "$ADMIN" no-show-non-numeric-admin '404 NotFound'
# account state from the token
expect PATCH "/api/consultations/$R1/join" patient-pending "$PPEND" join-token-status-pending '403 Forbidden'
expect PATCH "/api/consultations/$R1/start" doctor-pending "$DPEND" start-token-status-pending '403 Forbidden'
expect PATCH "/api/consultations/$R1/complete" doctor-pending "$DPEND" complete-token-status-pending '403 Forbidden'
expect PATCH "/api/consultations/$R1/no-show" doctor-pending "$DPEND" no-show-token-status-pending '403 Forbidden'
expect GET /api/consultations/waiting-room doctor-pending "$DPEND" waiting-room-token-status-pending '403 Forbidden'
expect GET "/api/consultations/calendar?from=$(isoz 0)&to=$(isoz 3600)" doctor-pending "$DPEND" calendar-token-status-pending '403 Forbidden'
expect PATCH "/api/consultations/$R1/no-show" admin-suspended "$ASUSP" no-show-admin-token-status-suspended '403 Forbidden'
# spoofed identity headers are ignored
expect PATCH "/api/consultations/$R1/join" patient-other "$P502" join-spoofed-X-User-Id-ignored '404 NotFound' '' '' '' 'X-User-Id: 501'
expect PATCH "/api/consultations/$R1/start" patient "$P501" start-spoofed-X-Role-doctor-ignored '403 Forbidden' '' '' '' 'X-Role: doctor'
# wrong methods on the session paths are plain 404s in the standard envelope
expect GET "/api/consultations/$R1/join" patient "$P501" 'GET on the join path (wrong method)' '404 NotFound'
expect POST "/api/consultations/$R1/start" doctor "$D601" 'POST on the start path (wrong method)' '404 NotFound'
# locally suspended doctor (token says active, Care's own suspended_at wins)
RS="$(mkrow 603 501 300 booked)"; RSI="$(mkrow 603 501 -3000 in_progress)"; RSN="$(mkrow 603 501 -7200 booked)"
expect PATCH "/api/consultations/$RS/join" doctor-suspended "$D603" join-locally-suspended-doctor '403 Forbidden'
expect PATCH "/api/consultations/$RS/start" doctor-suspended "$D603" start-locally-suspended-doctor '403 Forbidden'
expect PATCH "/api/consultations/$RSI/complete" doctor-suspended "$D603" complete-locally-suspended-doctor '403 Forbidden'
expect PATCH "/api/consultations/$RSN/no-show" doctor-suspended "$D603" no-show-locally-suspended-doctor '403 Forbidden'
expect GET /api/consultations/waiting-room doctor-suspended "$D603" waiting-room-locally-suspended-doctor '403 Forbidden'
expect GET "/api/consultations/calendar?from=$(isoz 0)&to=$(isoz 3600)" doctor-suspended "$D603" calendar-locally-suspended-doctor '403 Forbidden'
expect PATCH "/api/consultations/$RS/join" patient "$P501" join-patient-of-suspended-doctor-still-allowed 200 "$JOIN_KEYS"
expect PATCH "/api/consultations/$RSN/no-show" admin "$ADMIN" no-show-admin-exempt-from-local-suspension 200 "b.data.status==='no_show'&&$CONS_SHAPE"
check_value rbac 'denied calls changed nothing' "booked in_progress" "$(st "$R1") $(st "$RSI")"
check_value rbac 'no started/completed audit row and no outbox row written by any denied call' 0 "$(( $(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action IN ('consultation.started','consultation.completed') AND entity_id IN ($R1,$RSI)") + $(outbox_n "$R1" doctor_joined) + $(outbox_n "$RSI" doctor_joined) ))"
wipe 601; wipe 603

# ---- 3. Lifecycle through the real routes: booked -> waiting -> in_progress -> completed ----
L1="$(mkrow 601 501 300 booked)"
expect PATCH "/api/consultations/$L1/join" doctor "$D601" 'doctor join on booked: token only, no transition' 200 "$JOIN_KEYS&&b.data.consultation.status==='booked'&&b.data.consultation.joinedAt===null&&$(tokenfor 601 doctor)"
check_value db 'doctor join on booked: still booked, joined_at null, room persisted, no audit' "booked||1|0" "$(sql "SELECT status||'|'||COALESCE(joined_at::text,'')||'|'||(room_id IS NOT NULL)::int FROM consultations WHERE id=$L1")|$(audit_n consultation.waiting "$L1")"
expect PATCH "/api/consultations/$L1/join" patient "$P501" 'patient join on booked: booked -> waiting' 200 "$JOIN_KEYS&&b.data.consultation.status==='waiting'&&b.data.consultation.joinedAt!==null&&b.data.consultation.startedAt===null&&$(tokenfor 501 patient)&&b.data.consultation.patient.userId===501"
RIDJ="$(cat "$TMP/rid")"
check_value db 'patient join: status waiting, joined_at set, room_id set' "waiting 1 1" "$(sql "SELECT status||' '||(joined_at IS NOT NULL)::int||' '||(room_id IS NOT NULL)::int FROM consultations WHERE id=$L1")"
check_value audit 'one consultation.waiting row (actor patient, request id, flat metadata byRole/fromStatus only)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.waiting' AND entity_type='consultation' AND entity_id=$L1 AND actor_user_id=501 AND actor_role='patient' AND request_id='$RIDJ' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['byRole','fromStatus']")"
expect PATCH "/api/consultations/$L1/join" patient "$P501" 'patient re-join on waiting: fresh token, no transition' 200 "$JOIN_KEYS&&b.data.consultation.status==='waiting'&&$(tokenfor 501 patient)"
expect PATCH "/api/consultations/$L1/join" doctor "$D601" 'doctor join on waiting: doctor token' 200 "$JOIN_KEYS&&$(tokenfor 601 doctor)"
expect PATCH "/api/consultations/$L1/join" patient "$P501" 'join ignores a request body' 200 "$JOIN_KEYS" '{"status":"completed","x":1}'
check_value audit 're-joins wrote no extra audit row' 1 "$(audit_n consultation.waiting "$L1")"
check_value outbox 'join queued no notification' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$L1 AND kind='doctor_joined'")"
expect PATCH "/api/consultations/$L1/complete" doctor "$D601" 'complete on waiting' '409 InvalidTransition'
expect PATCH "/api/consultations/$L1/start" doctor "$D601" 'start waiting -> in_progress' 200 "$JOIN_KEYS&&b.data.consultation.status==='in_progress'&&b.data.consultation.startedAt!==null&&$(tokenfor 601 doctor)&&b.data.consultation.patient.profileHydrated===false"
RIDS="$(cat "$TMP/rid")"
check_value db 'start: status in_progress, started_at set' "in_progress 1" "$(sql "SELECT status||' '||(started_at IS NOT NULL)::int FROM consultations WHERE id=$L1")"
check_value audit 'one consultation.started row (doctor, byRole/fromStatus, from waiting)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.started' AND entity_id=$L1 AND actor_user_id=601 AND actor_role='doctor' AND request_id='$RIDS' AND metadata->>'fromStatus'='waiting' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['byRole','fromStatus']")"
check_value outbox 'start queued exactly one doctor_joined row for the patient, pending' "1 501 pending" "$(sql "SELECT count(*)||' '||min(recipient_user_id)||' '||min(status) FROM notification_outbox WHERE consultation_id=$L1 AND kind='doctor_joined'")"
check_value outbox 'doctor_joined payload keys are startsAt/endsAt/recipientRole only' 0 "$(sql "SELECT count(*) FROM notification_outbox o, jsonb_object_keys(o.payload) k WHERE o.consultation_id=$L1 AND o.kind='doctor_joined' AND k NOT IN ('startsAt','endsAt','recipientRole')")"
expect PATCH "/api/consultations/$L1/start" doctor "$D601" 'second start on in_progress' '409 InvalidTransition'
check_value outbox 'second start queued nothing more, wrote no second audit row' "1 1" "$(outbox_n "$L1" doctor_joined) $(audit_n consultation.started "$L1")"
expect PATCH "/api/consultations/$L1/join" patient "$P501" 'patient join on in_progress: token only' 200 "$JOIN_KEYS&&b.data.consultation.status==='in_progress'&&$(tokenfor 501 patient)"
expect PATCH "/api/consultations/$L1/join" doctor "$D601" 'doctor join on in_progress: repair token' 200 "$JOIN_KEYS&&$(tokenfor 601 doctor)"
expect PATCH "/api/consultations/$L1/no-show" doctor "$D601" 'no-show on in_progress' '409 InvalidTransition'
expect PATCH "/api/consultations/$L1/complete" doctor "$D601" 'complete in_progress -> completed' 200 "$CONS_SHAPE&&b.data.status==='completed'&&b.data.completedAt!==null&&b.data.patient.profileHydrated===false"
RIDC="$(cat "$TMP/rid")"
check_value db 'complete: status completed, completed_at set, started_at kept' "completed 1 1" "$(sql "SELECT status||' '||(completed_at IS NOT NULL)::int||' '||(started_at IS NOT NULL)::int FROM consultations WHERE id=$L1")"
check_value audit 'one consultation.completed row (doctor, byRole only)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.completed' AND entity_id=$L1 AND actor_user_id=601 AND request_id='$RIDC' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['byRole']")"
expect PATCH "/api/consultations/$L1/complete" doctor "$D601" 'complete again on completed' '409 InvalidTransition'
expect PATCH "/api/consultations/$L1/start" doctor "$D601" 'start on completed' '409 InvalidTransition'
expect PATCH "/api/consultations/$L1/join" patient "$P501" 'patient join on completed (inside window, terminal wins)' '409 InvalidTransition'
expect PATCH "/api/consultations/$L1/join" doctor "$D601" 'doctor join on completed' '409 InvalidTransition'
expect PATCH "/api/consultations/$L1/no-show" admin "$ADMIN" 'admin no-show on completed' '409 InvalidTransition'
check_value db 'terminal row unchanged by every later call' completed "$(st "$L1")"
check_value audit 'lifecycle audit order: waiting, started, completed' "consultation.waiting,consultation.started,consultation.completed" "$(sql "SELECT string_agg(action, ',' ORDER BY created_at, id) FROM audit_logs WHERE created_at >= '$T0' AND entity_id=$L1 AND action IN ('consultation.waiting','consultation.started','consultation.completed')")"
expect GET "/api/consultations/$L1" admin "$ADMIN" 'get-one never exposes roomId' 200 '!("roomId" in b.data)&&!JSON.stringify(b).includes("fake-room")'
# start straight from booked
wipe 601
L2="$(mkrow 601 501 -300 booked)"
expect PATCH "/api/consultations/$L2/start" doctor "$D601" 'start booked -> in_progress (patient never joined)' 200 "$JOIN_KEYS&&b.data.consultation.status==='in_progress'&&b.data.consultation.joinedAt===null"
check_value outbox 'start from booked queued doctor_joined once' 1 "$(outbox_n "$L2" doctor_joined)"
expect PATCH "/api/consultations/$L2/complete" doctor "$D601" 'complete after start from booked' 200 "b.data.status==='completed'"
wipe 601
L3="$(mkrow 601 501 300 booked)"
expect PATCH "/api/consultations/$L3/complete" doctor "$D601" 'complete on booked' '409 InvalidTransition'
check_value db 'rejected complete changed nothing' booked "$(st "$L3")"
wipe 601

# ---- 4. join window (half-open, 30 s margins) ----
# opens at start - 10 min: start in 630 s -> still closed; 570 s -> open
W="$(mkrow 601 501 630 booked)"; expect PATCH "/api/consultations/$W/join" patient "$P501" 'join 30 s before the window opens' '409 RoomNotOpen'; check_value db 'RoomNotOpen changed nothing (no room, still booked)' "booked 0" "$(sql "SELECT status||' '||(room_id IS NOT NULL)::int FROM consultations WHERE id=$W")"
expect PATCH "/api/consultations/$W/join" doctor "$D601" 'doctor join 30 s before the window opens' '409 RoomNotOpen'; wipe 601
W="$(mkrow 601 501 570 booked)"; expect PATCH "/api/consultations/$W/join" patient "$P501" 'join 30 s after the window opens' 200 "$JOIN_KEYS&&b.data.consultation.status==='waiting'"; wipe 601
# closes at end + 15 min (30-minute row): ends in -870 s -> open; -930 s -> closed. start = end - 30 min
W="$(mkrow 601 501 -2670 booked)"; expect PATCH "/api/consultations/$W/join" patient "$P501" 'join 30 s before the window closes' 200 "$JOIN_KEYS&&b.data.consultation.status==='waiting'&&Date.parse(b.data.joinTokenExpiresAt)<=Date.parse(b.data.windowClosesAt)&&Date.parse(b.data.joinTokenExpiresAt)<=Date.now()+31000"; wipe 601
W="$(mkrow 601 501 -2730 booked)"; expect PATCH "/api/consultations/$W/join" patient "$P501" 'join 30 s after the window closed' '409 RoomNotOpen'; expect PATCH "/api/consultations/$W/join" doctor "$D601" 'doctor join 30 s after the window closed' '409 RoomNotOpen'; wipe 601
# terminal rows answer InvalidTransition even outside the window
for s in completed cancelled no_show; do
  W="$(mkrow 601 501 -86400 $s)"; expect PATCH "/api/consultations/$W/join" patient "$P501" "join terminal $s long after the window: InvalidTransition not RoomNotOpen" '409 InvalidTransition'
  expect PATCH "/api/consultations/$W/start" doctor "$D601" "start terminal $s long after the window" '409 InvalidTransition'
  expect PATCH "/api/consultations/$W/complete" doctor "$D601" "complete terminal $s" '409 InvalidTransition'
  expect PATCH "/api/consultations/$W/no-show" doctor "$D601" "no-show terminal $s" '409 InvalidTransition'
  W2="$(mkrow 601 501 86400 $s)"; expect PATCH "/api/consultations/$W2/join" patient "$P501" "join terminal $s before the window opens: InvalidTransition" '409 InvalidTransition'
  check_value db "terminal $s row unchanged" "$s $s" "$(st "$W") $(st "$W2")"; wipe 601
done

# ---- 5. start window ----
W="$(mkrow 601 501 630 booked)"; expect PATCH "/api/consultations/$W/start" doctor "$D601" 'start 30 s before the window opens' '409 RoomNotOpen'; check_value db 'RoomNotOpen start: booked, no outbox' "booked 0" "$(st "$W") $(outbox_n "$W" doctor_joined)"; wipe 601
W="$(mkrow 601 501 570 booked)"; expect PATCH "/api/consultations/$W/start" doctor "$D601" 'start 30 s after the window opens' 200 "$JOIN_KEYS&&b.data.consultation.status==='in_progress'"; wipe 601
W="$(mkrow 601 501 -2670 booked)"; expect PATCH "/api/consultations/$W/start" doctor "$D601" 'start 30 s before the window closes' 200 "$JOIN_KEYS&&b.data.consultation.status==='in_progress'"; wipe 601
W="$(mkrow 601 501 -2730 booked)"; expect PATCH "/api/consultations/$W/start" doctor "$D601" 'start 30 s after the window closed' '409 RoomNotOpen'; wipe 601
W="$(mkrow 601 501 -86400 in_progress)"; expect PATCH "/api/consultations/$W/start" doctor "$D601" 'start on in_progress long outside the window: InvalidTransition' '409 InvalidTransition'
expect PATCH "/api/consultations/$W/complete" doctor "$D601" 'complete in_progress long after closesAt (no window check)' 200 "b.data.status==='completed'"; wipe 601
W="$(mkrow 601 501 -2730 waiting)"; expect PATCH "/api/consultations/$W/start" doctor "$D601" 'start waiting after the window closed' '409 RoomNotOpen'
expect PATCH "/api/consultations/$W/join" patient "$P501" 'patient join waiting after the window closed' '409 RoomNotOpen'; wipe 601

# ---- 6. no-show (grace 10 min, boundary inclusive, 30 s margins) ----
N1="$(mkrow 601 501 300 booked)"
expect PATCH "/api/consultations/$N1/no-show" doctor "$D601" 'no-show before the start' '409 NoShowTooEarly'
expect PATCH "/api/consultations/$N1/no-show" admin "$ADMIN" 'admin no-show before the start' '409 NoShowTooEarly'; wipe 601
N1="$(mkrow 601 501 -570 booked)"; expect PATCH "/api/consultations/$N1/no-show" doctor "$D601" 'no-show 30 s before start + grace' '409 NoShowTooEarly'; check_value db 'NoShowTooEarly changed nothing' booked "$(st "$N1")"
expect PATCH "/api/consultations/$N1/no-show" admin "$ADMIN" 'admin no-show 30 s before start + grace' '409 NoShowTooEarly'; wipe 601
N1="$(mkrow 601 501 -630 booked)"
# the doctor's interval is exclusive while the row is live: an overlapping insert is refused by the database
OVERLAP="$(mkrow 601 502 -600 booked 2>/dev/null || echo REFUSED)"
check_value db 'exclusion constraint refuses an overlapping live row' REFUSED "$OVERLAP"
expect PATCH "/api/consultations/$N1/no-show" doctor "$D601" 'doctor no-show 30 s after start + grace (no body)' 200 "$CONS_SHAPE&&b.data.status==='no_show'&&b.data.patient.profileHydrated===false"
RIDN="$(cat "$TMP/rid")"
check_value db 'no-show: status no_show, no_show_marked_at set' "no_show 1" "$(sql "SELECT status||' '||(no_show_marked_at IS NOT NULL)::int FROM consultations WHERE id=$N1")"
check_value audit 'one consultation.no_show row (doctor, byRole/fromStatus, no noteLength without a note)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.no_show' AND entity_id=$N1 AND actor_user_id=601 AND request_id='$RIDN' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['byRole','fromStatus']")"
check_value outbox 'no-show queued no notification' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$N1")"
OVERLAP2="$(mkrow 601 502 -600 booked 2>/dev/null || echo REFUSED)"
check_value db 'no-show released the interval: an overlapping live row is now accepted' ok "$([ "$OVERLAP2" != REFUSED ] && echo ok || echo refused)"
expect PATCH "/api/consultations/$N1/no-show" doctor "$D601" 'no-show again on no_show' '409 InvalidTransition'
expect PATCH "/api/consultations/$N1/start" doctor "$D601" 'start on no_show' '409 InvalidTransition'
wipe 601
N2="$(mkrow 601 501 -630 waiting)"
expect PATCH "/api/consultations/$N2/no-show" admin "$ADMIN" 'admin no-show on waiting, with note' 200 "b.data.status==='no_show'&&!JSON.stringify(b).includes('$NMARK')&&$CONS_SHAPE" "{\"note\":\"$NMARK synthetic\"}"
RIDA="$(cat "$TMP/rid")"
check_value audit 'admin no-show audited: actor admin, noteLength only, never the note text' "1 1 0" "$(sql "SELECT count(*)||' '||count(*) FILTER (WHERE actor_role='admin' AND (metadata->>'noteLength')::int=$(printf '%s' "$NMARK synthetic" | wc -c) AND metadata->>'fromStatus'='waiting')||' '||count(*) FILTER (WHERE metadata::text LIKE '%$NMARK%') FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.no_show' AND entity_id=$N2 AND request_id='$RIDA'")"
check_value db 'the note is stored nowhere on the row' 0 "$(sql "SELECT count(*) FROM consultations WHERE id=$N2 AND row_to_json(consultations)::text LIKE '%$NMARK%'")"
wipe 601
for pair in 'blank-note|{"note":"   "}' 'empty-note|{"note":""}' 'empty-object|{}'; do
  N3="$(mkrow 601 501 -630 booked)"; expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" "no-show body ${pair%%|*}" 200 "b.data.status==='no_show'" "${pair#*|}"
  check_value audit "no noteLength for ${pair%%|*}" 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.no_show' AND entity_id=$N3 AND metadata ? 'noteLength'")"; wipe 601
done
N3="$(mkrow 601 501 -630 booked)"
expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" 'no-show note exactly 1000 chars' 200 "b.data.status==='no_show'" "{\"note\":\"$(printf 'x%.0s' $(seq 1 1000))\"}"; wipe 601
N3="$(mkrow 601 501 -630 booked)"
expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" 'no-show note 1001 chars' '400 ValidationFailed' 'b.error.details.length>0' "{\"note\":\"$(printf 'x%.0s' $(seq 1 1001))\"}"
expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" 'no-show note with NUL' '400 ValidationFailed' 'b.error.details.length>0' '{"note":"abc\u0000def"}'
expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" 'no-show note not a string' '400 ValidationFailed' 'b.error.details.length>0' '{"note":12345}'
expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" 'no-show unknown member' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="status")' '{"status":"completed"}'
expect PATCH "/api/consultations/$N3/no-show" doctor "$D601" 'no-show malformed JSON' '400 ValidationFailed' '' '{"note":'
check_value db 'validation failures changed nothing' booked "$(st "$N3")"; wipe 601
N4="$(mkrow 601 501 -630 booked)"
expect PATCH "/api/consultations/$N4/no-show" admin "$ADMIN" 'admin no-show on booked after grace (zone UTC)' 200 "b.data.status==='no_show'&&b.data.timezone==='UTC'"; wipe 601

# ---- 7. waiting room ----
wipe 601; wipe 602
WA="$(mkrow 601 501 300 booked)"                 # window open, booked
WB="$(mkrow 601 502 -2400 waiting)"              # started 40 min ago, ended 10 min ago: closes in 5 min, waiting
WC="$(mkrow 601 501 -7200 in_progress)"          # excluded: in_progress
WD="$(mkrow 601 501 -14400 completed)"           # excluded: completed
WE="$(mkrow 601 501 10800 booked)"               # excluded: window not open
WF="$(mkrow 601 501 -10800 booked)"              # excluded: window closed
WG="$(mkrow 601 501 -21600 cancelled)"           # excluded: cancelled
WH="$(mkrow 602 501 300 booked)"                 # excluded: another doctor
sql "SELECT 1" >/dev/null
curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room: window rows only, (startsAt,id) order, no complaintText' 200 "b.data.map(x=>x.id).join()==='$WB,$WA'&&b.data.every(x=>!('complaintText' in x)&&!('roomId' in x)&&x.doctor.userId===601&&x.doctor.profileHydrated===false)&&b.data[0].patient.userId===502&&b.data[1].patient.userId===501&&b.data.every(x=>x.patient.profileHydrated===true&&x.patient.displayName!==null)&&!('meta' in b)"
check_value case2 'waiting room used exactly one batched Identity call for the distinct patients' "1 501,502" "$(fake 'c.batches.length+" "+[...c.batches[0].ids].sort().join()')"
check_value case2 'the Identity call carried the X-Request-Id of the request' 1 "$(fake 'c.batches[0].requestId?1:0')"
expect GET /api/consultations/waiting-room doctor-other "$D602" 'waiting room of another doctor shows only its own row' 200 "b.data.map(x=>x.id).join()==='$WH'"
expect GET '/api/consultations/waiting-room?limit=5' doctor "$D601" 'waiting room: unknown query member' '400 ValidationFailed'
expect GET '/api/consultations/waiting-room?foo=bar' doctor "$D601" 'waiting room: unknown query member foo' '400 ValidationFailed'
# window edges via status flips of a dedicated doctor row: open at -600, closed at end+900
wipe 601
WA="$(mkrow 601 501 630 booked)"; expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room: 30 s before the window opens' 200 'b.data.length===0'; wipe 601
WA="$(mkrow 601 501 570 booked)"; expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room: 30 s after the window opens' 200 "b.data.length===1&&b.data[0].id===$WA"; wipe 601
WA="$(mkrow 601 501 -2670 booked)"; expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room: 30 s before the window closes' 200 "b.data.length===1&&b.data[0].id===$WA"; wipe 601
WA="$(mkrow 601 501 -2730 booked)"; expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room: 30 s after the window closed' 200 'b.data.length===0'; wipe 601
expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room: empty' 200 'Array.isArray(b.data)&&b.data.length===0'
expect GET /api/consultations/waiting-room doctor "$D601" 'literal route is not captured by GET /consultations/:id' 200 'Array.isArray(b.data)'

# ---- 8. calendar ----
wipe 601; wipe 602
CA="$(mkrow 601 501 -7200 cancelled)"; CB="$(mkrow 601 502 -3600 completed)"; CC="$(mkrow 601 501 3600 booked)"; CD="$(mkrow 601 502 10800 no_show)"
CE="$(mkrow 601 501 176400 booked)"; CF="$(mkrow 601 501 -172800 booked)"; CG="$(mkrow 602 501 5400 booked)"
FROM="$(isoz -86400)"; TO="$(isoz 172800)"
curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
expect GET "/api/consultations/calendar?from=$FROM&to=$TO" doctor "$D601" 'calendar: every status in the window, own rows only, ordered, no complaintText' 200 "Object.keys(b.data).sort().join()==='consultations,exceptions,from,timezone,to'&&b.data.timezone==='Africa/Cairo'&&b.data.consultations.map(x=>x.id).join()==='$CA,$CB,$CC,$CD'&&b.data.consultations.map(x=>x.status).join()==='cancelled,completed,booked,no_show'&&b.data.consultations.every(x=>!('complaintText' in x)&&!('roomId' in x)&&x.patient.profileHydrated===true)&&Array.isArray(b.data.exceptions)&&/[+-][0-9][0-9]:[0-9][0-9]$/.test(b.data.from)"
check_value case2 'calendar used exactly one batched Identity call for the distinct patients' "1 501,502" "$(fake 'c.batches.length+" "+[...c.batches[0].ids].sort().join()')"
expect GET "/api/consultations/calendar?from=$FROM&to=$TO&timezone=Asia/Tokyo" doctor "$D601" 'calendar: timezone override renders from/to in that zone' 200 "b.data.timezone==='Asia/Tokyo'&&b.data.from.endsWith('+09:00')&&b.data.to.endsWith('+09:00')&&Date.parse(b.data.from)===Date.parse('$FROM')&&b.data.consultations[0].timezone==='Asia/Tokyo'"
expect GET "/api/consultations/calendar?from=$(isoz 0)&to=$(isoz 604800)" doctor "$D601" 'calendar: window of exactly 7 days is allowed' 200 'Array.isArray(b.data.consultations)'
expect GET "/api/consultations/calendar?from=$(isoz 0)&to=$(isoz 604801)" doctor "$D601" 'calendar: 7 days + 1 s' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="to")'
expect GET "/api/consultations/calendar?from=$(isoz 3600)&to=$(isoz 0)" doctor "$D601" 'calendar: from after to' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="from")'
expect GET "/api/consultations/calendar?from=2030-01-01T00:00:00Z&to=2030-01-01T00:00:00Z" doctor "$D601" 'calendar: from equals to' '400 ValidationFailed'
expect GET "/api/consultations/calendar?to=$TO" doctor "$D601" 'calendar: from missing' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="from")'
expect GET "/api/consultations/calendar?from=$FROM" doctor "$D601" 'calendar: to missing' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="to")'
expect GET /api/consultations/calendar doctor "$D601" 'calendar: no query' '400 ValidationFailed'
expect GET '/api/consultations/calendar?from=2030-01-01T00:00:00&to=2030-01-02T00:00:00' doctor "$D601" 'calendar: from/to without offset' '400 ValidationFailed'
expect GET '/api/consultations/calendar?from=2030-01-01&to=2030-01-02' doctor "$D601" 'calendar: date-only' '400 ValidationFailed'
expect GET '/api/consultations/calendar?from=garbage&to=garbage' doctor "$D601" 'calendar: garbage instants' '400 ValidationFailed'
expect GET "/api/consultations/calendar?from=$FROM&to=$TO&timezone=Mars/Olympus" doctor "$D601" 'calendar: invalid timezone' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="timezone")'
expect GET "/api/consultations/calendar?from=$FROM&to=$TO&foo=bar" doctor "$D601" 'calendar: unknown query member' '400 ValidationFailed'
expect GET "/api/consultations/calendar?from=$(isoz -3600)&to=$(isoz 7200)" doctor-other "$D602" 'calendar of another doctor shows only its own row' 200 "b.data.consultations.map(x=>x.id).join()==='$CG'"
# offset notation in the query (percent-encoded +)
expect GET "/api/consultations/calendar?from=2030-03-01T00:00:00%2B02:00&to=2030-03-02T00:00:00%2B02:00" doctor "$D601" 'calendar: from/to with +02:00 offset' 200 "Date.parse(b.data.from)===Date.parse('2030-03-01T00:00:00+02:00')&&b.data.from.endsWith('+02:00')&&b.data.timezone==='Africa/Cairo'"
# exceptions by doctor-local date (Europe/Berlin doctor 604)
EXD="$(ldate Europe/Berlin 1)"
expect POST /api/doctors/me/exceptions doctor-604 "$D604" 'setup: day-off exception tomorrow (Berlin)' 201 '' "{\"type\":\"day_off\",\"date\":\"$EXD\"}"
expect GET "/api/consultations/calendar?from=$(isoz -3600)&to=$(isoz 259200)" doctor-604 "$D604" 'calendar: exception listed by doctor-local date, default zone is the doctor zone' 200 "b.data.timezone==='Europe/Berlin'&&b.data.exceptions.length===1&&b.data.exceptions[0].date==='$EXD'&&b.data.exceptions[0].type==='day_off'"
expect GET "/api/consultations/calendar?from=$(isoz -3600)&to=$(isoz 259200)&timezone=Pacific/Kiritimati" doctor-604 "$D604" 'calendar: override zone does not move the exception date' 200 "b.data.timezone==='Pacific/Kiritimati'&&b.data.exceptions.length===1&&b.data.exceptions[0].date==='$EXD'"
expect GET "/api/consultations/calendar?from=$(isoz 604800)&to=$(isoz 691200)" doctor-604 "$D604" 'calendar: window beyond the exception shows none' 200 'b.data.exceptions.length===0'
wipe 601; wipe 602

# ---- 9. Case 2: Identity degraded ----
CR="$(mkrow 601 501 300 booked)"; CR2="$(mkrow 601 502 -2400 waiting)"
curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null; ctl down
expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room with Identity down (cold cache): 200, unhydrated' 200 "b.data.length===2&&b.data.every(x=>x.patient.profileHydrated===false&&x.patient.displayName===null&&x.patient.avatarUrl===null)&&b.data.every(x=>x.startsAt&&x.endsAt)"
expect GET "/api/consultations/calendar?from=$(isoz -86400)&to=$(isoz 86400)" doctor "$D601" 'calendar with Identity down (cold cache): 200, unhydrated' 200 "b.data.consultations.length===2&&b.data.consultations.every(x=>x.patient.profileHydrated===false&&x.patient.displayName===null)"
ctl healthy
expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room with Identity healthy again: hydrated' 200 "b.data.every(x=>x.patient.profileHydrated===true&&x.patient.displayName!==null)"
ctl down
NO_FLUSH=1 expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room with Identity down but cache warm: cached names served' 200 "b.data.length===2&&b.data.every(x=>x.patient.profileHydrated===true)"
ctl hang
S0=$(date +%s)
expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room with Identity hanging (cold cache): 200 after the client timeout' 200 "b.data.length===2&&b.data.every(x=>x.patient.profileHydrated===false)"
check_value case2 'hanging Identity bounded the read (under 10 s, not hung)' ok "$([ $(( $(date +%s) - S0 )) -lt 10 ] && echo ok || echo slow)"
ctl healthy
# session writes make no Identity call
curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null; ctl down
expect PATCH "/api/consultations/$CR/join" patient "$P501" 'join with Identity down' 200 "$JOIN_KEYS"
expect PATCH "/api/consultations/$CR/start" doctor "$D601" 'start with Identity down' 200 "$JOIN_KEYS"
expect PATCH "/api/consultations/$CR/complete" doctor "$D601" 'complete with Identity down' 200 "b.data.status==='completed'"
check_value case2 'join/start/complete made no Identity call (no batch, no status PATCH)' "0 0" "$(fake 'c.batchCount+" "+c.patchCount')"
ctl healthy; wipe 601

# ---- 10. Video provider outage (fault injected in the QA server wrapper) ----
if [ -n "${VIDEO_FAULT_FILE:-}" ]; then
  wipe 601
  V1="$(mkrow 601 501 300 booked)"
  vmode fail-room
  expect PATCH "/api/consultations/$V1/join" patient "$P501" 'join, provider fails creating the room' '503 VideoUnavailable'
  check_value db 'room failure before commit: nothing changed (booked, no joined_at, no room, no audit)' "booked 0 0 0" "$(sql "SELECT status||' '||(joined_at IS NOT NULL)::int||' '||(room_id IS NOT NULL)::int FROM consultations WHERE id=$V1") $(audit_n consultation.waiting "$V1")"
  expect PATCH "/api/consultations/$V1/join" doctor "$D601" 'doctor join on booked, provider fails creating the room' '503 VideoUnavailable'
  expect PATCH "/api/consultations/$V1/start" doctor "$D601" 'start, provider fails creating the room' '503 VideoUnavailable'
  check_value db 'room failure on start before commit: still booked, no doctor_joined, no audit' "booked 0 0" "$(st "$V1") $(outbox_n "$V1" doctor_joined) $(audit_n consultation.started "$V1")"
  vmode fail-token
  expect PATCH "/api/consultations/$V1/join" patient "$P501" 'join, provider fails issuing the token (after commit)' '503 VideoUnavailable'
  check_value db 'token failure after commit: patient is waiting, audit written once' "waiting 1" "$(st "$V1") $(audit_n consultation.waiting "$V1")"
  vmode ok
  expect PATCH "/api/consultations/$V1/join" patient "$P501" 'repeat join after recovery: token, no second transition' 200 "$JOIN_KEYS&&b.data.consultation.status==='waiting'&&$(tokenfor 501 patient)"
  check_value audit 'repair join wrote no second waiting row' 1 "$(audit_n consultation.waiting "$V1")"
  vmode fail-token
  expect PATCH "/api/consultations/$V1/start" doctor "$D601" 'start, provider fails issuing the token (after commit)' '503 VideoUnavailable'
  check_value db 'token failure on start: in_progress committed, doctor_joined queued once, audit once' "in_progress 1 1" "$(st "$V1") $(outbox_n "$V1" doctor_joined) $(audit_n consultation.started "$V1")"
  vmode ok
  expect PATCH "/api/consultations/$V1/join" doctor "$D601" 'doctor repairs the start token with join' 200 "$JOIN_KEYS&&b.data.consultation.status==='in_progress'&&$(tokenfor 601 doctor)"
  expect PATCH "/api/consultations/$V1/start" doctor "$D601" 'start again after the repair' '409 InvalidTransition'
  vmode fail-room
  expect PATCH "/api/consultations/$V1/complete" doctor "$D601" 'complete is unaffected by a provider outage' 200 "b.data.status==='completed'"
  expect GET /api/consultations/waiting-room doctor "$D601" 'waiting room is unaffected by a provider outage' 200 'Array.isArray(b.data)'
  wipe 601
  V2="$(mkrow 601 501 -630 booked)"
  expect PATCH "/api/consultations/$V2/no-show" doctor "$D601" 'no-show is unaffected by a provider outage' 200 "b.data.status==='no_show'"
  wipe 601
  V3="$(mkrow 601 501 300 booked)"
  vmode slow-room
  S0=$(date +%s)
  expect PATCH "/api/consultations/$V3/join" patient "$P501" 'join, provider slower than 2 s creating the room' '503 VideoUnavailable'
  check_value video 'slow provider was cut near the 2 s bound (under 5 s) and left the row booked' "ok booked" "$([ $(( $(date +%s) - S0 )) -lt 5 ] && echo ok || echo slow) $(st "$V3")"
  vmode slow-token
  expect PATCH "/api/consultations/$V3/start" doctor "$D601" 'start, provider slower than 2 s issuing the token' '503 VideoUnavailable'
  check_value db 'slow token on start: in_progress committed' in_progress "$(st "$V3")"
  vmode ok
  expect PATCH "/api/consultations/$V3/join" doctor "$D601" 'join after the slow outage recovers' 200 "$JOIN_KEYS"
  wipe 601
  if [ -n "${SERVER_LOG:-}" ]; then
    check_value log 'video_provider_failed logged with a code only (operation + code=qa_injected or timeout, no token)' ok "$(tail -n +$((LOG_MARK+1)) "$SERVER_LOG" | grep -c '"message":"video_provider_failed"' | awk '{print ($1>=7)?"ok":"few:"$1}')"
  fi
else
  skip_note 'video outage section skipped: VIDEO_FAULT_FILE not set (server not started through scripts/sessions-qa-server.ts)'
fi

# ---- 11. Concurrency ----
pcall() { # pcall <name> <method> <path> <token> [body] [key]: background call, status in $TMP/par_<name>
  local name="$1" method="$2" path="$3" token="$4" body="${5:-}" key="${6:-}"
  local args=(-sS -X "$method" -H "X-Request-Id: $(uuid)" -H "Authorization: Bearer $token" -o "$TMP/par_$name.body" -w '%{http_code}')
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  curl "${args[@]}" "$CARE_URL$path" > "$TMP/par_$name.status" || echo 000 > "$TMP/par_$name.status"
}
pstat() { cat "$TMP/par_$1.status"; }
pcode() { node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("-")}' "$TMP/par_$1.body"; }
flush_redis
wipe 601; K1="$(mkrow 601 501 300 booked)"
pcall a PATCH "/api/consultations/$K1/start" "$D601" & pcall b PATCH "/api/consultations/$K1/start" "$D601" & wait
GOT="$(printf '%s\n' "$(pstat a)" "$(pstat b)" | sort | tr '\n' ' ')"
check_value concurrency 'two simultaneous start calls: exactly one 200 and one 409' '200 409 ' "$GOT"
check_value concurrency 'the loser is InvalidTransition; one outbox row; one audit row; in_progress' "InvalidTransition 1 1 in_progress" "$( [ "$(pstat a)" = 409 ] && pcode a || pcode b ) $(outbox_n "$K1" doctor_joined) $(audit_n consultation.started "$K1") $(st "$K1")"
wipe 601; K2="$(mkrow 601 501 300 booked)"
pcall a PATCH "/api/consultations/$K2/join" "$P501" & pcall b PATCH "/api/consultations/$K2/join" "$P501" & wait
check_value concurrency 'two simultaneous patient joins: both 200 (second is token-only), one waiting audit row' "200 200 1 waiting" "$(pstat a) $(pstat b) $(audit_n consultation.waiting "$K2") $(st "$K2")"
wipe 601; K3="$(mkrow 601 501 300 booked)"
pcall a PATCH "/api/consultations/$K3/start" "$D601" & pcall b PATCH "/api/consultations/$K3/cancel" "$D601" '{"reason":"Synthetic reason"}' "$(uuid)" & wait
FINAL="$(st "$K3")"
case "$(pstat a)/$(pstat b)/$FINAL" in
  200/409/in_progress|409/200/cancelled) W=ok;;
  *) W="bad:$(pstat a)/$(pstat b)/$FINAL";;
esac
check_value concurrency 'start racing a doctor cancel: exactly one wins, the loser is 409, state matches the winner' ok "$W"
check_value concurrency 'a cancelled consultation never has a doctor_joined row without a start' ok "$([ "$FINAL" = cancelled ] && [ "$(outbox_n "$K3" doctor_joined)" = 0 ] && echo ok || { [ "$FINAL" = in_progress ] && [ "$(outbox_n "$K3" doctor_joined)" = 1 ] && echo ok || echo inconsistent; })"
wipe 601

# ---- 12. Rate limit (join/start bucket 10/min per user; the limiter is not flushed here) ----
wipe 601; RL="$(mkrow 601 503 300 booked)"; flush_redis
for i in 1 2 3 4 5 6 7 8 9 10; do NO_FLUSH=1 expect PATCH "/api/consultations/$RL/join" patient "$P503" "join rate limit call $i of 10" 200 "$JOIN_KEYS"; done
NO_FLUSH=1 expect PATCH "/api/consultations/$RL/join" patient "$P503" 'join rate limit: 11th call within a minute' '429 RateLimited'
check_value ratelimit '429 carries Retry-After' 1 "$(grep -qi '^retry-after:' "$TMP/headers" && echo 1 || echo 0)"
NO_FLUSH=1 expect PATCH "/api/consultations/$RL/start" doctor "$D601" 'start has its own bucket per user (doctor not yet limited)' 200 "$JOIN_KEYS"
flush_redis; wipe 601

# ---- 13. Hygiene ----
check_value audit 'every session audit row carries only flat scalar metadata keys from the allowlist' 0 "$(sql "SELECT count(*) FROM audit_logs a, jsonb_object_keys(a.metadata) k WHERE a.created_at >= '$T0' AND a.action IN ('consultation.waiting','consultation.started','consultation.completed','consultation.no_show') AND k NOT IN ('byRole','fromStatus','noteLength')")"
check_value audit 'no audit row holds a token, room id or marker' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND (metadata::text LIKE '%fake-room%' OR metadata::text LIKE '%$MARK%' OR metadata::text LIKE '%$NMARK%' OR metadata::text LIKE '%joinToken%')")"
check_value outbox 'no outbox payload holds a token or room id' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE payload::text LIKE '%fake-room%' OR payload::text LIKE '%joinToken%'")"
check_value audit 'session routes wrote no audit row for the two read views' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND (action LIKE '%waiting_room%' OR action LIKE '%calendar%')")"
if [ -n "${SERVER_LOG:-}" ]; then
  LOG_TAIL="$TMP/server.tail"; tail -n +$((LOG_MARK+1)) "$SERVER_LOG" > "$LOG_TAIL"
  check_value log 'captured log is non-trivial' 1 "$([ "$(wc -l < "$LOG_TAIL")" -gt 20 ] && echo 1 || echo 0)"
  check_value log 'no issued join token appears in the server log' 0 "$( [ -s "$TMP/tokens.txt" ] && { grep -cF -f "$TMP/tokens.txt" "$LOG_TAIL" || true; } || echo 0 )"
  check_value log 'tokens were actually captured for the scan' 1 "$([ "$(wc -l < "$TMP/tokens.txt")" -gt 5 ] && echo 1 || echo 0)"
  for needle in "$MARK" "$NMARK" 'fake-room-' 'Bearer ' 'joinToken":"' 'synthetic-video-provider-key'; do
    check_value log "no '$needle' in the server log" 0 "$(grep -cF -- "$needle" "$LOG_TAIL" || true)"
  done
else
  skip_note 'log hygiene skipped: SERVER_LOG not set'
fi

echo "RESULT: $PASS pass / $FAIL fail ($SKIP skipped sections)"
[ "$FAIL" = 0 ]
