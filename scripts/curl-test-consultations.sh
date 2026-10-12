#!/usr/bin/env bash
# Repeatable HTTP QA for the consultations module: POST /api/consultations, GET /api/consultations, GET /api/consultations/{id},
# PATCH .../reschedule, PATCH .../cancel, GET /api/patients/{patientUserId}. Use only a disposable *_test or *_qa* database.
#
# Start first (see docs/consultations/manual-qa.md -> Environment):
#   node scripts/consultations-qa-fake-identity.mjs   # JWKS + user tokens + fake Identity internal API (FAKE_IDENTITY_PORT, default 3023)
#   npx tsx src/server.ts                              # IDENTITY_JWKS_URL / IDENTITY_INTERNAL_URL -> the fake; REDIS_URL on a spare db index;
#                                                      # PORT=3043; dummy STORAGE_* values; database migrated + ensure-app-login
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH).
# Optional: CARE_URL (default http://127.0.0.1:3043), FAKE_IDENTITY_URL (default http://127.0.0.1:3023),
#           REDIS_URL (flushed at start and during the idempotency section; a spare db index only),
#           QA_REPORT (file receiving the case table), SERVER_LOG (care-api log; scanned for clinical-text leaks).
# Synthetic fixtures: patients 501-599, doctors 601-699, admins 1, 2, 77. Fixture rows are deleted first (idempotent).
set -euo pipefail
export MSYS_NO_PATHCONV=1

CARE_URL="${CARE_URL:-http://127.0.0.1:3043}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3023}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"
PASS=0; FAIL=0; CASE=0
MARK='QA-COMPLAINT-MARKER-7731'; RMARK='QA-REASON-MARKER-4410'

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
ctl() { curl -fsS "$FAKE_IDENTITY_URL/__ctl?mode=$1" >/dev/null; }
pt() { mint "patient-$1"; }; dt() { mint "doctor-$1"; }; at() { mint "admin-$1"; }
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/body" "$1"; }
fake() { curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(eval(process.argv[1])))' "$1"; }
flush_redis() { [ -z "${REDIS_URL:-}" ] || node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null; }
# slot <daysAhead> <HH:MM> [zone]: ISO-8601 with offset, local wall clock in zone on (zone today + N days)
slot() { node -e 'const {DateTime}=require("luxon");const [d,t,z]=[Number(process.argv[1]),process.argv[2],process.argv[3]||"Africa/Cairo"];const [h,m]=t.split(":").map(Number);process.stdout.write(DateTime.now().setZone(z).plus({days:d}).set({hour:h,minute:m,second:0,millisecond:0}).toISO({suppressMilliseconds:true}))' -- "$1" "$2" "${3:-}"; }
slotutc() { node -e 'const {DateTime}=require("luxon");process.stdout.write(DateTime.fromISO(process.argv[1]).toUTC().toISO({suppressMilliseconds:true}))' "$1"; }
sdate() { node -e 'const {DateTime}=require("luxon");const [d,t,z]=process.argv.slice(1);const [h,m]=t.split(":").map(Number);process.stdout.write(DateTime.fromISO(d,{zone:z}).set({hour:h,minute:m}).toISO({suppressMilliseconds:true}))' "$1" "$2" "$3"; }
ldate() { node -e 'const {DateTime}=require("luxon");process.stdout.write(DateTime.now().setZone(process.argv[1]).plus({days:Number(process.argv[2])}).toISODate())' -- "$1" "$2"; }
wday() { node -e 'const {DateTime}=require("luxon");process.stdout.write(String(DateTime.fromISO(process.argv[1]).weekday))' "$1"; }

ADMIN_TOKENS=''
call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" extra="${6:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  [ -z "$extra" ] || args+=(-H "$extra")
  if [ -n "$token" ] && [ "$method" != GET ] && [ -z "${NO_THROTTLE:-}" ]; then
    local f="$TMP/w_${token: -14}" n=0 lim=9
    case " $ADMIN_TOKENS " in *" ${token: -14} "*) lim=55;; esac
    [ ! -f "$f" ] || n="$(cat "$f")"
    n=$((n+1))
    if [ "$n" -ge "$lim" ]; then sleep 61; n=1; fi
    printf '%s' "$n" > "$f"
  fi
  curl "${args[@]}" "$CARE_URL$path"
}
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: .*no-store/im.test(h)) process.exit(1);
let b; try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(1); }
if (kind === 'error') {
  if (b.success !== false || b.error?.code !== code || b.error?.requestId !== rid ||
      typeof b.error?.message !== 'string' || !Array.isArray(b.error?.details)) process.exit(1);
} else if (b.success !== true) process.exit(1);
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
hdr_has() { grep -qi -- "$1" "$TMP/headers" && echo 1 || echo 0; }
audit_n() { sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='$1' ${2:+AND entity_id=$2} ${3:+AND actor_user_id=$3}"; }
outbox_n() { sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$1 AND kind='$2'"; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }

reset() {
  sql "DELETE FROM notification_outbox WHERE consultation_id IN (SELECT id FROM consultations WHERE doctor_user_id BETWEEN 600 AND 699 OR patient_user_id BETWEEN 500 AND 599);
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
cleanup() { ctl healthy 2>/dev/null || true; reset 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
reset; flush_redis; curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
T0="$(sql 'select now()')"
LOG_MARK=0; [ -z "${SERVER_LOG:-}" ] || LOG_MARK="$(wc -l < "$SERVER_LOG")"

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
ADMIN="$(at 1)"; ADMIN2="$(at 2)"; ADMIN77="$(at 77)"
ADMIN_TOKENS="${ADMIN: -14} ${ADMIN2: -14} ${ADMIN77: -14}"
EXPIRED="$(mint expired)"; SVC="$(curl -fsS "$FAKE_IDENTITY_URL/mint?case=patient-501&typ=service")"
echo 'case|method|path|role|scenario|expected|got|result'

HOURS='{"days":['"$(for d in 1 2 3 4 5 6 7; do printf '{"weekday":%s,"intervals":[{"startTime":"09:00","endTime":"17:00"}]},' $d; done | sed 's/,$//')"']}'
# mkdoc <userId> <mode> [tz]: modes approved | draft (unapproved) | unsynced | notaccepting | notype (inactive type) | suspended
mkdoc() {
  local uid="$1" mode="${2:-approved}" tz="${3:-Africa/Cairo}" t
  t="$(dt "$uid")"
  [ "$(call POST /api/doctors/apply "$t" "{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"$tz\",\"submit\":false}")" = 201 ] || { echo "fixture apply failed for doctor $uid" >&2; exit 2; }
  sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$uid" >/dev/null
  [ "$(call POST /api/doctors/me/consultation-types "$t" '{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}')" = 201 ] || { echo "fixture type failed for $uid" >&2; exit 2; }
  [ "$(call PUT /api/doctors/me/working-hours "$t" "$HOURS")" = 200 ] || { echo "fixture hours failed for $uid" >&2; exit 2; }
  case "$mode" in
    draft) sql "UPDATE doctor_profiles SET verification_status='draft', decided_at=NULL WHERE user_id=$uid" >/dev/null;;
    unsynced) sql "UPDATE doctor_profiles SET identity_sync_status='pending' WHERE user_id=$uid" >/dev/null;;
    notaccepting) sql "UPDATE doctor_profiles SET is_accepting_patients=false WHERE user_id=$uid" >/dev/null;;
    notype) sql "UPDATE consultation_types SET is_active=false WHERE doctor_profile_id=(SELECT id FROM doctor_profiles WHERE user_id=$uid)" >/dev/null;;
    suspended) sql "UPDATE doctor_profiles SET suspended_at=now(), suspension_reason='synthetic' WHERE user_id=$uid" >/dev/null;;
  esac
}
tid() { sql "SELECT id FROM consultation_types WHERE doctor_profile_id=(SELECT id FROM doctor_profiles WHERE user_id=$1) ORDER BY id LIMIT 1"; }
# mkrow <doctor> <patient> <startOffsetMinutes> <status>: owner-SQL fixture row (30 min), used for policy-window and terminal states
mkrow() {
  sql "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash,cancelled_at,cancelled_by)
       VALUES ($1,$2,$(tid "$1"),now()+interval '$3 minutes',now()+interval '$3 minutes'+interval '30 minutes','$4','$MARK sql','Africa/Cairo',500,'EGP',gen_random_uuid(),repeat('0',64),
       CASE WHEN '$4'='cancelled' THEN now() END, CASE WHEN '$4'='cancelled' THEN 'patient' END) RETURNING id" | head -1
}
cbody() { # cbody <doctor> <type> <startsAt> [tz]
  printf '{"doctorId":%s,"typeId":%s,"startsAt":"%s","complaintText":"%s synthetic","patientTimezone":"%s"}' "$1" "$2" "$3" "$MARK" "${4:-Europe/Berlin}"
}
# book <patientTok> <doctor> <daysAhead> <HH:MM> [scenario] [expected]: books via the real route, sets BID on 201
book() {
  local tok="$1" doc="$2" d="$3" t="$4" sc="${5:-book}" exp="${6:-201}"
  expect POST /api/consultations patient "$tok" "$sc" "$exp" '' "$(cbody "$doc" "$(tid "$doc")" "$(slot "$d" "$t")")" "$(uuid)"
  BID="$(js 'b.data?.id ?? ""' 2>/dev/null || true)"
}
SHAPE='["id","status","doctor","patient","consultationType","startsAt","endsAt","startsAtLocal","endsAtLocal","timezone","patientTimezone","price","needsAdminFollowup","createdAt","updatedAt","joinedAt","startedAt","completedAt","cancelledAt","cancelledBy","cancelReason","followupReason","followUpOfRecordId","hasRecord"].every(k=>k in b.data)&&!("roomId" in b.data)&&!("idempotencyKey" in b.data)&&!("requestHash" in b.data)'

# ---- 0. Fixtures ----
for u in 601 602 603 604 611 612 613 614 615; do mkdoc "$u"; done
mkdoc 605 approved Europe/Berlin
mkdoc 606 draft; mkdoc 607 unsynced; mkdoc 608 notaccepting; mkdoc 609 notype; mkdoc 610 suspended
D601="$(dt 601)"; D602="$(dt 602)"; D603="$(dt 603)"; D604="$(dt 604)"; D610="$(dt 610)"; D611="$(dt 611)"
T601="$(tid 601)"; T602="$(tid 602)"; T603="$(tid 603)"; T604="$(tid 604)"; T605="$(tid 605)"; T612="$(tid 612)"
P501="$(pt 501)"; P502="$(pt 502)"; P503="$(pt 503)"
sql "SELECT 1" >/dev/null

# ---- 1. Happy-path booking, response shape, audit, outbox ----
S1="$(slot 3 10:00)"; K1="$(uuid)"
expect POST /api/consultations patient "$P501" book-happy-path 201 "$SHAPE&&b.data.status==='booked'&&b.data.doctor.userId===601&&b.data.patient.userId===501&&b.data.doctor.profileHydrated===false&&b.data.doctor.displayName===null&&b.data.consultationType.durationMinutes===30&&b.data.price.amount===500&&b.data.price.currency==='EGP'&&Date.parse(b.data.endsAt)-Date.parse(b.data.startsAt)===1800000&&b.data.complaintText.includes('$MARK')&&b.data.timezone==='Europe/Berlin'&&b.data.patientTimezone==='Europe/Berlin'&&b.data.needsAdminFollowup===false&&b.data.hasRecord===false&&b.data.startsAt.endsWith('Z')&&/[+-]\\d\\d:\\d\\d\$/.test(b.data.startsAtLocal)" "$(cbody 601 "$T601" "$S1")" "$K1"
C1="$(js b.data.id)"; RID1="$(cat "$TMP/rid")"
check_value audit 'book writes one consultation.booked row (metadata ids/instants only)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.booked' AND entity_type='consultation' AND entity_id=$C1 AND actor_user_id=501 AND actor_role='patient' AND request_id='$RID1' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['consultationTypeId','doctorUserId','endsAt','patientUserId','startsAt']")"
check_value outbox 'book queues booking_confirmed for patient and doctor' '2 501,601' "$(sql "SELECT count(*) || ' ' || string_agg(recipient_user_id::text, ',' ORDER BY recipient_user_id) FROM notification_outbox WHERE consultation_id=$C1 AND kind='booking_confirmed' AND status='pending'")"
check_value outbox 'outbox payload keys are ids/instants only (no text)' 0 "$(sql "SELECT count(*) FROM notification_outbox o, jsonb_object_keys(o.payload) k WHERE o.consultation_id=$C1 AND k NOT IN ('startsAt','endsAt','previousStartsAt','byRole','recipientRole')")"
check_value db 'row has server-derived ends_at, price snapshot, canonical patient_timezone, idempotency key persisted' "30 500 EGP Europe/Berlin $K1" "$(sql "SELECT (extract(epoch from ends_at-starts_at)/60)::int || ' ' || price || ' ' || currency || ' ' || patient_timezone || ' ' || idempotency_key FROM consultations WHERE id=$C1")"
expect POST /api/consultations patient "$P502" patient-timezone-canonicalized 201 "b.data.patientTimezone==='Africa/Cairo'" "$(cbody 601 "$T601" "$(slot 3 12:00)" africa/cairo)" "$(uuid)"
CTZ="$(js b.data.id)"
expect POST /api/consultations patient "$P502" start-in-utc-notation-equal-instant 201 "b.data.startsAt==='$(node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' "$(slot 3 13:00)")'" "$(cbody 601 "$T601" "$(slotutc "$(slot 3 13:00)")")" "$(uuid)"
expect POST /api/consultations patient "$P502" back-to-back-adjacent-slot-allowed 201 "" "$(cbody 601 "$T601" "$(slot 3 10:30)")" "$(uuid)"
expect POST /api/consultations patient "$P502" last-slot-of-day-16:30-allowed 201 "" "$(cbody 601 "$T601" "$(slot 3 16:30)")" "$(uuid)"
expect POST /api/consultations patient "$P503" identity-headers-ignored-patient-from-token 201 "b.data.patient.userId===503" "$(cbody 601 "$T601" "$(slot 4 09:00)")" "$(uuid)" 'X-User-Id: 502'
expect POST /api/consultations patient "$P503" complaint-with-newline-and-unicode-allowed 201 "" "{\"doctorId\":601,\"typeId\":$T601,\"startsAt\":\"$(slot 4 09:30)\",\"complaintText\":\"line one\\nline two \u00e9\u00e8\",\"patientTimezone\":\"Africa/Cairo\"}" "$(uuid)"
expect POST /api/consultations patient "$P503" complaint-exactly-3-code-points 201 "" "{\"doctorId\":601,\"typeId\":$T601,\"startsAt\":\"$(slot 4 10:00)\",\"complaintText\":\"abc\",\"patientTimezone\":\"Africa/Cairo\"}" "$(uuid)"

# ---- 2. RBAC / authentication matrix ----
BK="$(cbody 601 "$T601" "$(slot 5 09:00)")"
for who in "none|" "malformed|garbage.token.value" "expired|$EXPIRED" "service-token|$SVC"; do
  n="${who%%|*}"; t="${who#*|}"
  for r in "POST /api/consultations $(uuid)" "GET /api/consultations" "GET /api/consultations/$C1" "PATCH /api/consultations/$C1/reschedule $(uuid)" "PATCH /api/consultations/$C1/cancel $(uuid)" "GET /api/patients/501"; do
    set -- $r; body=''; [ "$1" = POST ] && body="$BK"; [ "$1" = PATCH ] && body='{}'
    exp='401 Unauthorized'; [ "$n" = expired ] && exp='401 TokenExpired'
    expect "$1" "$2" "$n" "$t" "$n" "$exp" '' "$body" "${3:-}"
  done
done
for who in "doctor|$D601" "admin|$ADMIN" "doctor-pending|$(mint doctor-pending)" "patient-pending|$(mint patient-pending)" "patient-rejected|$(mint patient-rejected)" "patient-suspended|$(mint patient-suspended)"; do
  n="${who%%|*}"; t="${who#*|}"
  expect POST /api/consultations "$n" "$t" "book-denied-$n" '403 Forbidden' '' "$BK" "$(uuid)"
done
expect POST /api/consultations patient-unverified "$(mint patient-unverified)" book-email-not-verified '403 EmailNotVerified' '' "$BK" "$(uuid)"
expect POST /api/consultations admin "$ADMIN" book-spoofed-X-Role-patient-ignored '403 Forbidden' '' "$BK" "$(uuid)" 'X-Role: patient'
check_value rbac 'denied bookings created no row' 0 "$(sql "SELECT count(*) FROM consultations WHERE patient_user_id IN (591,592,593,594) OR (doctor_user_id=601 AND starts_at::date > now()::date + 4 AND created_at >= '$T0' AND patient_user_id NOT IN (501,502,503))")"
# list
for who in "doctor-pending|$(mint doctor-pending)" "doctor-rejected|$(mint doctor-rejected)" "patient-pending|$(mint patient-pending)" "patient-rejected|$(mint patient-rejected)" "patient-suspended|$(mint patient-suspended)" "admin-suspended|$(mint admin-suspended)"; do
  n="${who%%|*}"; t="${who#*|}"
  expect GET /api/consultations "$n" "$t" "list-denied-$n" '403 Forbidden'
done
expect GET /api/consultations patient-unverified "$(mint patient-unverified)" unverified-email-patient-can-list 200 'b.data.length===0'
# get-one ownership
expect GET "/api/consultations/$C1" patient-owner "$P501" get-owner 200 "b.data.id===$C1&&b.data.complaintText.includes('$MARK')"
expect GET "/api/consultations/$C1" doctor-assigned "$D601" get-assigned-doctor 200 "b.data.id===$C1&&b.data.complaintText.includes('$MARK')"
expect GET "/api/consultations/$C1" admin "$ADMIN" get-admin-view-without-complaint 200 "!('complaintText' in b.data)&&b.data.doctor.userId===601"
expect GET "/api/consultations/$C1" patient-other "$P502" get-non-owner-patient '404 NotFound'
expect GET "/api/consultations/$C1" doctor-other "$D602" get-non-assigned-doctor '404 NotFound'
expect GET "/api/consultations/99999999" patient "$P501" get-nonexistent '404 NotFound'
expect GET "/api/consultations/99999999" admin "$ADMIN" get-nonexistent-admin '404 NotFound'
for bad in abc 0 -1 1.5 99999999999999999999; do expect GET "/api/consultations/$bad" patient "$P501" "get-bad-id-$bad" '404 NotFound'; done
expect GET "/api/consultations/$C1" patient-pending "$(mint patient-pending)" get-token-status-pending '403 Forbidden'
check_value audit 'get-one by patient and doctor each wrote consultation.read, admin wrote none' '1 1 0' "$(audit_n consultation.read "$C1" 501) $(audit_n consultation.read "$C1" 601) $(audit_n consultation.read "$C1" 1)"
check_value audit 'consultation.read metadata is {viewerRole} only' 0 "$(sql "SELECT count(*) FROM audit_logs a, jsonb_object_keys(a.metadata) k WHERE a.created_at >= '$T0' AND a.action='consultation.read' AND k<>'viewerRole'")"
# reschedule / cancel ownership and role
NEWR="$(slot 9 10:00)"
expect PATCH "/api/consultations/$C1/reschedule" doctor "$D601" reschedule-doctor-role-denied '403 Forbidden' '' "{\"startsAt\":\"$NEWR\"}" "$(uuid)"
expect PATCH "/api/consultations/$C1/reschedule" patient-other "$P502" reschedule-non-owner '404 NotFound' '' "{\"startsAt\":\"$NEWR\"}" "$(uuid)"
expect PATCH "/api/consultations/abc/reschedule" patient "$P501" reschedule-non-numeric-id '404 NotFound' '' "{\"startsAt\":\"$NEWR\"}" "$(uuid)"
expect PATCH "/api/consultations/99999999/reschedule" admin "$ADMIN" reschedule-nonexistent-admin '404 NotFound' '' "{\"startsAt\":\"$NEWR\",\"reason\":\"Synthetic reason\"}" "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" patient-other "$P502" cancel-non-owner-patient '404 NotFound' '' '{}' "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" doctor-other "$D602" cancel-non-assigned-doctor '404 NotFound' '' '{"reason":"Synthetic reason"}' "$(uuid)"
expect PATCH "/api/consultations/99999999/cancel" admin "$ADMIN" cancel-nonexistent-admin '404 NotFound' '' '{"reason":"Synthetic reason"}' "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" doctor-pending "$(mint doctor-pending)" cancel-doctor-token-pending '403 Forbidden' '' '{"reason":"Synthetic reason"}' "$(uuid)"
check_value rbac 'denied/not-found writes changed nothing' 'booked' "$(sql "SELECT status FROM consultations WHERE id=$C1")"
# patients/{id}
expect PATCH /api/patients/me patient "$P501" setup-patient-profile 200 '' '{"timezone":"Africa/Cairo","allergies":["TEST-ALLERGEN-A"]}'
expect GET /api/patients/501 patient-self "$P501" patient-profile-self 200 "b.data.userId===501&&Object.keys(b.data).sort().join()==='allergies,bloodType,chronicConditions,createdAt,dateOfBirth,gender,id,timezone,updatedAt,userId'"
expect GET /api/patients/501 doctor-related "$D601" patient-profile-related-doctor 200 "b.data.userId===501&&b.data.allergies[0]==='TEST-ALLERGEN-A'"
check_value audit 'patient_profile.read by the doctor audited (patientUserId + viewerRole)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.read' AND actor_user_id=601 AND actor_role='doctor' AND request_id='$(cat "$TMP/rid")' AND metadata::text IN ('{\"viewerRole\": \"doctor\", \"patientUserId\": 501}','{\"patientUserId\": 501, \"viewerRole\": \"doctor\"}')")"
expect GET /api/patients/501 doctor-unrelated "$D602" patient-profile-unrelated-doctor '404 NotFound'
expect GET /api/patients/501 patient-other "$P502" patient-profile-other-patient '404 NotFound'
expect GET /api/patients/501 admin "$ADMIN" patient-profile-admin-denied '403 Forbidden' '!JSON.stringify(b).includes("TEST-ALLERGEN")'
expect GET /api/patients/501 doctor-pending "$(mint doctor-pending)" patient-profile-doctor-token-pending '403 Forbidden'
expect GET /api/patients/501 patient-pending "$(mint patient-pending)" patient-profile-patient-token-pending '403 Forbidden'
for bad in abc 0 -1 99999999; do expect GET "/api/patients/$bad" doctor "$D601" "patient-profile-bad-id-$bad" '404 NotFound'; done
expect GET /api/patients/502 doctor-related-no-profile "$D601" patient-profile-not-created-yet '404 NotFound'
A_PR="$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.read' AND actor_user_id IN (1,602,502,690,591)")"
check_value audit 'no patient_profile.read rows for admin, unrelated doctor, other patient, pending tokens' 0 "$A_PR"

# ---- 3. Validation matrix ----
VN=0
vtok() { VN=$((VN+1)); pt $((520+VN)); }
v400() { # v400 <scenario> <body> [assert]
  expect POST /api/consultations patient "$(vtok)" "$1" '400 ValidationFailed' "b.error.details.length>0&&!JSON.stringify(b).includes('SENTINEL')${3:+&&$3}" "$2" "$(uuid)"
}
OKS="$(slot 6 09:00)"
bj() { printf '{"doctorId":601,"typeId":%s,"startsAt":"%s","complaintText":"synthetic","patientTimezone":"Africa/Cairo"%s}' "$T601" "$OKS" "${1:-}"; }
v400 unknown-member-patientUserId "$(bj ',"patientUserId":999')" 'b.error.details.some(d=>d.field==="patientUserId")'
v400 unknown-member-price "$(bj ',"price":1')"
v400 unknown-member-endsAt "$(bj ',"endsAt":"2030-01-01T00:00:00Z"')"
v400 unknown-member-durationMinutes "$(bj ',"durationMinutes":5')"
v400 followUpOfRecordId-not-supported "$(bj ',"followUpOfRecordId":5')" 'b.error.details.some(d=>d.field==="followUpOfRecordId")'
v400 doctorId-string '{"doctorId":"601","typeId":1,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 doctorId-zero '{"doctorId":0,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 doctorId-negative '{"doctorId":-3,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 doctorId-float '{"doctorId":1.5,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 typeId-missing '{"doctorId":601,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}' 'b.error.details.some(d=>d.field==="typeId")'
v400 typeId-null '{"doctorId":601,"typeId":null,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 startsAt-without-offset '{"doctorId":601,"typeId":1,"startsAt":"2030-01-01T10:00:00","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}' 'b.error.details.some(d=>d.field==="startsAt")'
v400 startsAt-date-only '{"doctorId":601,"typeId":1,"startsAt":"2030-01-01","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 startsAt-number '{"doctorId":601,"typeId":1,"startsAt":1893456000,"complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 startsAt-garbage '{"doctorId":601,"typeId":1,"startsAt":"SENTINEL","complaintText":"synthetic","patientTimezone":"Africa/Cairo"}'
v400 complaint-missing '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","patientTimezone":"Africa/Cairo"}' 'b.error.details.some(d=>d.field==="complaintText")'
v400 complaint-blank '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"    ","patientTimezone":"Africa/Cairo"}'
v400 complaint-2-chars '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"ab","patientTimezone":"Africa/Cairo"}'
v400 complaint-4001-chars "{\"doctorId\":601,\"typeId\":1,\"startsAt\":\"$OKS\",\"complaintText\":\"$(printf 'x%.0s' $(seq 1 4001))\",\"patientTimezone\":\"Africa/Cairo\"}"
v400 complaint-nul-char '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"abc\u0000def","patientTimezone":"Africa/Cairo"}'
v400 complaint-not-string '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","complaintText":12345,"patientTimezone":"Africa/Cairo"}'
v400 patientTimezone-missing '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"synthetic"}' 'b.error.details.some(d=>d.field==="patientTimezone")'
v400 patientTimezone-invalid-zone '{"doctorId":601,"typeId":1,"startsAt":"'"$OKS"'","complaintText":"synthetic","patientTimezone":"Mars/Olympus"}'
v400 patientTimezone-65-chars "{\"doctorId\":601,\"typeId\":1,\"startsAt\":\"$OKS\",\"complaintText\":\"synthetic\",\"patientTimezone\":\"$(printf 'A%.0s' $(seq 1 65))\"}"
v400 body-is-array '[]'
v400 body-empty-object '{}'
expect POST /api/consultations patient "$(vtok)" body-absent '400 ValidationFailed' '' '' "$(uuid)"
expect POST /api/consultations patient "$(vtok)" malformed-json '400 ValidationFailed' '' '{"doctorId":' "$(uuid)"
expect POST /api/consultations patient "$(vtok)" missing-idempotency-key '400 ValidationFailed' 'b.error.details.some(d=>d.field==="Idempotency-Key")' "$(bj)"
expect POST /api/consultations patient "$(vtok)" non-uuid-idempotency-key '400 ValidationFailed' 'b.error.details.some(d=>d.field==="Idempotency-Key")' "$(bj)" 'not-a-uuid'
expect POST /api/consultations patient "$(vtok)" empty-idempotency-key-header '400 ValidationFailed' '' "$(bj)" '' 'Idempotency-Key:'
expect PATCH "/api/consultations/$C1/reschedule" patient "$P501" reschedule-missing-key '400 ValidationFailed' '' "{\"startsAt\":\"$NEWR\"}"
expect PATCH "/api/consultations/$C1/cancel" patient "$P501" cancel-missing-key '400 ValidationFailed' '' '{}'
check_value db 'no validation-failure created a row' 0 "$(sql "SELECT count(*) FROM consultations WHERE patient_user_id BETWEEN 521 AND 560")"
# reschedule validation (owner patient 501 on C1, outside window)
rv() { expect PATCH "/api/consultations/$C1/reschedule" patient "$P501" "$1" '400 ValidationFailed' "b.error.details.length>0${3:+&&$3}" "$2" "$(uuid)"; }
rv reschedule-startsAt-missing '{}' 'b.error.details.some(d=>d.field==="startsAt")'
rv reschedule-startsAt-no-offset '{"startsAt":"2030-01-01T10:00:00"}'
rv reschedule-unknown-member '{"startsAt":"'"$NEWR"'","status":"cancelled"}'
rv reschedule-reason-2-chars '{"startsAt":"'"$NEWR"'","reason":"ab"}'
rv reschedule-reason-1001-chars "{\"startsAt\":\"$NEWR\",\"reason\":\"$(printf 'x%.0s' $(seq 1 1001))\"}"
rv reschedule-reason-blank '{"startsAt":"'"$NEWR"'","reason":"     "}'
expect PATCH "/api/consultations/$C1/reschedule" patient "$P501" reschedule-no-body '400 ValidationFailed' '' '' "$(uuid)"
expect PATCH "/api/consultations/$C1/reschedule" admin "$ADMIN" reschedule-admin-reason-required '400 ValidationFailed' 'b.error.details.some(d=>d.field==="reason")' "{\"startsAt\":\"$NEWR\"}" "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" patient "$P501" cancel-no-body '400 ValidationFailed' '' '' "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" patient "$P501" cancel-reason-2-chars '400 ValidationFailed' '' '{"reason":"ab"}' "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" patient "$P501" cancel-reason-1001-chars '400 ValidationFailed' '' "{\"reason\":\"$(printf 'x%.0s' $(seq 1 1001))\"}" "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" patient "$P501" cancel-unknown-member '400 ValidationFailed' '' '{"status":"completed"}' "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" doctor "$D601" cancel-doctor-reason-required '400 ValidationFailed' 'b.error.details.some(d=>d.field==="reason")' '{}' "$(uuid)"
expect PATCH "/api/consultations/$C1/cancel" admin "$ADMIN" cancel-admin-reason-required '400 ValidationFailed' 'b.error.details.some(d=>d.field==="reason")' '{}' "$(uuid)"
check_value db 'reschedule/cancel validation failures changed nothing' 'booked' "$(sql "SELECT status FROM consultations WHERE id=$C1")"
# list / get query validation
lv() { expect GET "$2" "${3:-patient}" "${4:-$P501}" "$1" '400 ValidationFailed' 'b.error.details.length>0'; }
lv list-scope-invalid '/api/consultations?scope=bogus'
lv list-limit-0 '/api/consultations?limit=0'
lv list-limit-101 '/api/consultations?limit=101'
lv list-limit-not-int '/api/consultations?limit=abc'
lv list-cursor-garbage '/api/consultations?cursor=%%garbage'
lv list-status-invalid '/api/consultations?status=bogus'
lv list-status-repeated-param '/api/consultations?status=booked&status=cancelled'
lv list-status-7-values '/api/consultations?status=booked,booked,waiting,in_progress,completed,cancelled,no_show'
lv list-from-no-offset '/api/consultations?from=2030-01-01T00:00:00'
lv list-from-after-to "/api/consultations?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z"
lv list-from-equals-to "/api/consultations?from=2030-01-01T00:00:00Z&to=2030-01-01T00:00:00Z"
lv list-timezone-invalid '/api/consultations?timezone=Mars/Olympus'
lv list-unknown-param '/api/consultations?foo=bar'
lv list-admin-doctorUserId-not-int '/api/consultations?doctorUserId=abc' admin "$ADMIN"
lv list-admin-needsAdminFollowup-not-bool '/api/consultations?needsAdminFollowup=yes' admin "$ADMIN"
lv get-timezone-invalid "/api/consultations/$C1?timezone=Mars/Olympus"
expect GET '/api/consultations?doctorUserId=601' patient "$P501" list-admin-filter-doctorUserId-by-patient '403 Forbidden'
expect GET '/api/consultations?patientUserId=501' doctor "$D601" list-admin-filter-patientUserId-by-doctor '403 Forbidden'
expect GET '/api/consultations?needsAdminFollowup=true' patient "$P501" list-admin-filter-followup-by-patient '403 Forbidden'
expect GET '/api/consultations?needsAdminFollowup=false' doctor "$D601" list-admin-filter-followup-false-by-doctor '403 Forbidden'

# ---- 4. Booking business rules ----
expect POST /api/consultations patient "$(pt 531)" doctor-unknown '404 NotFound' '' "$(cbody 99999 "$T601" "$(slot 3 11:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 531)" type-unknown '404 NotFound' '' "$(cbody 601 99999999 "$(slot 3 11:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 531)" type-of-another-doctor '404 NotFound' '' "$(cbody 601 "$T602" "$(slot 3 11:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 531)" doctorId-is-a-patient-user '404 NotFound' '' "$(cbody 501 "$T601" "$(slot 3 11:00)")" "$(uuid)"
for pair in "606|unapproved" "607|identity-unsynced" "608|not-accepting" "609|no-active-type" "610|locally-suspended"; do
  d="${pair%%|*}"; n="${pair#*|}"
  expect POST /api/consultations patient "$(pt 532)" "doctor-$n" '409 DoctorNotBookable' '' "$(cbody "$d" "$(tid "$d")" "$(slot 3 11:00)")" "$(uuid)"
done
expect POST /api/consultations patient "$(pt 533)" start-in-past-yesterday '422 BookingInPast' '' "$(cbody 601 "$T601" "$(slot -1 10:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 533)" start-one-minute-ago '422 BookingInPast' '' "$(cbody 601 "$T601" "$(node -e 'process.stdout.write(new Date(Date.now()-60000).toISOString())')")" "$(uuid)"
expect POST /api/consultations patient "$(pt 533)" start-61-days-ahead '422 BeyondBookingHorizon' '' "$(cbody 601 "$T601" "$(slot 61 10:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 533)" start-59-days-ahead-allowed 201 '' "$(cbody 601 "$T601" "$(slot 59 10:00)")" "$(uuid)"
for pair in "08:00|before-hours" "08:30|before-hours-half" "17:00|at-closing-time" "16:45|off-grid-16:45" "10:15|off-grid-10:15" "17:30|after-hours"; do
  expect POST /api/consultations patient "$(pt 534)" "outside-hours-${pair#*|}-${pair%%|*}" '422 OutsideWorkingHours' '' "$(cbody 601 "$T601" "$(slot 7 "${pair%%|*}")")" "$(uuid)"
done
expect POST /api/consultations patient "$(pt 535)" off-grid-by-one-minute '422 OutsideWorkingHours' '' "$(cbody 601 "$T601" "$(node -e 'const {DateTime}=require("luxon");process.stdout.write(DateTime.fromISO(process.argv[1]).plus({minutes:1}).toISO({suppressMilliseconds:true}))' "$(slot 7 10:00)")")" "$(uuid)"
# exceptions: day off and custom hours on D604-independent doctor 614
D614="$(dt 614)"; T614="$(tid 614)"
DOFF="$(ldate Africa/Cairo 8)"; CUST="$(ldate Africa/Cairo 9)"
expect POST /api/doctors/me/exceptions doctor "$D614" setup-day-off 201 '' "{\"type\":\"day_off\",\"date\":\"$DOFF\"}"
expect POST /api/doctors/me/exceptions doctor "$D614" setup-custom-hours-12-14 201 '' "{\"type\":\"custom_hours\",\"date\":\"$CUST\",\"startTime\":\"12:00\",\"endTime\":\"14:00\"}"
expect POST /api/consultations patient "$(pt 535)" booking-on-day-off '422 OutsideWorkingHours' '' "$(cbody 614 "$T614" "$(slot 8 10:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 535)" custom-hours-before-window '422 OutsideWorkingHours' '' "$(cbody 614 "$T614" "$(slot 9 10:00)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 535)" custom-hours-inside-window 201 '' "$(cbody 614 "$T614" "$(slot 9 12:30)")" "$(uuid)"
expect POST /api/consultations patient "$(pt 535)" custom-hours-last-slot-13:30 201 '' "$(cbody 614 "$T614" "$(slot 9 13:30)")" "$(uuid)"
# slot conflicts
expect POST /api/consultations patient "$(pt 536)" slot-taken-same-start '409 SlotUnavailable' '' "$(cbody 601 "$T601" "$S1")" "$(uuid)"
expect POST /api/consultations patient "$P501" slot-taken-by-self-other-key '409 SlotUnavailable' '' "$(cbody 601 "$T601" "$S1")" "$(uuid)"
check_value db 'exactly one live consultation at the contested slot' 1 "$(sql "SELECT count(*) FROM consultations WHERE doctor_user_id=601 AND starts_at='$(slotutc "$S1")'")"
# DST (Europe/Berlin, change on 2026-10-25)
D605T="$T605"
expect POST /api/consultations patient "$(pt 537)" dst-before-change-09:00-berlin 201 "b.data.startsAt==='2026-10-24T07:00:00.000Z'&&b.data.startsAtLocal.endsWith('+02:00')" "$(cbody 605 "$D605T" "$(sdate 2026-10-24 09:00 Europe/Berlin)" Europe/Berlin)" "$(uuid)"
expect POST /api/consultations patient "$(pt 537)" dst-after-change-09:00-berlin 201 "b.data.startsAt==='2026-10-26T08:00:00.000Z'&&b.data.startsAtLocal.endsWith('+01:00')" "$(cbody 605 "$D605T" "$(sdate 2026-10-26 09:00 Europe/Berlin)" Europe/Berlin)" "$(uuid)"
expect POST /api/consultations patient "$(pt 537)" dst-change-day-last-slot-16:30 201 "b.data.startsAt==='2026-10-25T15:30:00.000Z'" "$(cbody 605 "$D605T" "$(sdate 2026-10-25 16:30 Europe/Berlin)" Europe/Berlin)" "$(uuid)"
expect POST /api/consultations patient "$(pt 537)" dst-off-grid-09:15 '422 OutsideWorkingHours' '' "$(cbody 605 "$D605T" "$(sdate 2026-10-26 09:15 Europe/Berlin)" Europe/Berlin)" "$(uuid)"
expect POST /api/consultations patient "$(pt 538)" dst-utc-notation-evaluated-in-doctor-zone-11:00-berlin 201 "b.data.startsAtLocal.startsWith('2026-10-26T09:00')===false&&b.data.timezone==='Europe/Berlin'" "$(cbody 605 "$D605T" "2026-10-26T10:00:00Z" Europe/Berlin)" "$(uuid)"

# ---- 5. Idempotency ----
KI="$(uuid)"; BI="$(cbody 601 "$T601" "$(slot 10 10:00)")"
expect POST /api/consultations patient "$(pt 540)" idem-first-call 201 '' "$BI" "$KI"
IDI="$(js b.data.id)"; CA1="$(js b.data.createdAt)"
expect POST /api/consultations patient "$(pt 540)" idem-replay-same-body-same-response 201 "b.data.id===$IDI&&b.data.createdAt==='$CA1'" "$BI" "$KI"
expect POST /api/consultations patient "$(pt 540)" idem-same-key-different-body '422 IdempotencyConflict' '' "$(cbody 601 "$T601" "$(slot 10 11:00)")" "$KI"
check_value db 'replay and conflict created exactly one row for the key' 1 "$(sql "SELECT count(*) FROM consultations WHERE idempotency_key='$KI'")"
expect POST /api/consultations patient "$(pt 541)" idem-same-key-other-principal-is-independent 201 "b.data.id!==$IDI" "$(cbody 601 "$T601" "$(slot 10 12:00)")" "$KI"
flush_redis
expect POST /api/consultations patient "$(pt 540)" idem-db-replay-after-redis-loss 201 "b.data.id===$IDI" "$BI" "$KI"
flush_redis
expect POST /api/consultations patient "$(pt 540)" idem-db-conflict-after-redis-loss '422 IdempotencyConflict' '' "$(cbody 601 "$T601" "$(slot 10 11:00)")" "$KI"
# parallel same key
KP="$(uuid)"; BP="$(cbody 601 "$T601" "$(slot 10 14:00)")"; PT542="$(pt 542)"
for i in 1 2 3 4 5 6; do
  ( curl -sS -o "$TMP/ip$i.body" -D "$TMP/ip$i.hdr" -w '%{http_code}' -X POST -H "Authorization: Bearer $PT542" -H 'Content-Type: application/json' -H "Idempotency-Key: $KP" -H "X-Request-Id: $(uuid)" --data-binary "$BP" "$CARE_URL/api/consultations" > "$TMP/ip$i.status" ) &
done
wait
ST="$(for i in 1 2 3 4 5 6; do cat "$TMP/ip$i.status"; echo; done | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
BADST="$(for i in 1 2 3 4 5 6; do cat "$TMP/ip$i.status"; echo; done | grep -vcE '^(201|409)$' || true)"
check_value idempotency 'six parallel same-key requests answer only 201 (original/replay) or 409 Conflict (in flight)' 0 "$BADST"
check_value idempotency 'in-flight 409s carry code Conflict + Retry-After: 1; all 201s share one id' 1 "$(node -e '
const fs=require("fs");let ids=new Set(),ok=1;for(let i=1;i<=6;i++){const s=fs.readFileSync(process.argv[1]+"/ip"+i+".status","utf8");const b=JSON.parse(fs.readFileSync(process.argv[1]+"/ip"+i+".body","utf8"));
if(s==="201")ids.add(b.data.id);else if(!(b.error.code==="Conflict"&&/^retry-after: 1/im.test(fs.readFileSync(process.argv[1]+"/ip"+i+".hdr","utf8"))))ok=0}
process.stdout.write(String(ok&&ids.size===1?1:0))' "$TMP")"
check_value idempotency 'exactly one row for the parallel key' 1 "$(sql "SELECT count(*) FROM consultations WHERE idempotency_key='$KP'")"

# ---- 6. Concurrency on one slot ----
SLOTC="$(slot 11 10:00)"; BC="$(cbody 612 "$T612" "$SLOTC")"
for i in 1 2 3 4 5 6 7 8; do
  ( curl -sS -o "$TMP/c$i.body" -w '%{http_code}' -X POST -H "Authorization: Bearer $(pt $((550+i)))" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" -H "X-Request-Id: $(uuid)" --data-binary "$BC" "$CARE_URL/api/consultations" > "$TMP/c$i.status" ) &
done
wait
check_value concurrency '8 parallel bookings of one slot: exactly one 201' 1 "$(for i in 1 2 3 4 5 6 7 8; do cat "$TMP/c$i.status"; echo; done | grep -c '^201$' || true)"
check_value concurrency '... and seven 409 SlotUnavailable (no 5xx)' 7 "$(for i in 1 2 3 4 5 6 7 8; do s="$(cat "$TMP/c$i.status")"; [ "$s" = 409 ] && grep -q '"code":"SlotUnavailable"' "$TMP/c$i.body" && echo y; done | wc -l | tr -d ' ')"
check_value concurrency 'exactly one row, one booking audit row, two outbox rows for the slot' '1 1 2' "$(sql "SELECT (SELECT count(*) FROM consultations WHERE doctor_user_id=612 AND starts_at='$(slotutc "$SLOTC")') || ' ' || (SELECT count(*) FROM audit_logs a JOIN consultations c ON c.id=a.entity_id WHERE a.created_at >= '$T0' AND a.action='consultation.booked' AND c.doctor_user_id=612) || ' ' || (SELECT count(*) FROM notification_outbox o JOIN consultations c ON c.id=o.consultation_id WHERE c.doctor_user_id=612)")"
check_value concurrency 'loser rows leave no outbox/audit residue (rollback)' 0 "$(sql "SELECT count(*) FROM notification_outbox o WHERE o.consultation_id NOT IN (SELECT id FROM consultations)")"

# ---- 7. Reschedule ----
book "$(pt 560)" 613 12 10:00 reschedule-fixture-book; R1="$BID"
sql "UPDATE consultations SET reminder_24h_sent_at=now(), reminder_1h_sent_at=now(), needs_admin_followup=true, followup_reason='schedule_blocked' WHERE id=$R1" >/dev/null
NEWS="$(slot 12 11:30)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-patient-outside-window 200 "$SHAPE&&b.data.status==='booked'&&b.data.id===$R1&&b.data.startsAt==='$(node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' "$NEWS")'&&Date.parse(b.data.endsAt)-Date.parse(b.data.startsAt)===1800000&&b.data.needsAdminFollowup===false&&b.data.followupReason===null&&b.data.complaintText.includes('$MARK')" "{\"startsAt\":\"$NEWS\"}" "$(uuid)"
RR="$(cat "$TMP/rid")"
check_value db 'reschedule updated the same row, cleared reminders and follow-up flag' '1 false' "$(sql "SELECT count(*) FILTER (WHERE reminder_24h_sent_at IS NULL AND reminder_1h_sent_at IS NULL AND followup_reason IS NULL) || ' ' || bool_or(needs_admin_followup)::text FROM consultations WHERE id=$R1")"
check_value audit 'consultation.rescheduled audited for a patient caller (byRole, from/to; no reason text)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.rescheduled' AND entity_id=$R1 AND actor_role='patient' AND request_id='$RR' AND metadata->>'byRole'='patient' AND metadata ? 'fromStartsAt' AND metadata ? 'toStartsAt'")"
check_value outbox 'reschedule queued rescheduled for both parties' 2 "$(outbox_n "$R1" rescheduled)"
UPD="$(sql "SELECT updated_at FROM consultations WHERE id=$R1")"; AUDN="$(audit_n consultation.rescheduled "$R1")"; OBN="$(outbox_n "$R1" rescheduled)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-same-start-noop 200 '' "{\"startsAt\":\"$NEWS\"}" "$(uuid)"
check_value db 'same-start reschedule: no write, no audit, no outbox' "$UPD $AUDN $OBN" "$(sql "SELECT updated_at FROM consultations WHERE id=$R1") $(audit_n consultation.rescheduled "$R1") $(outbox_n "$R1" rescheduled)"
KR="$(uuid)"; NEWS2="$(slot 12 14:00)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-key-first 200 '' "{\"startsAt\":\"$NEWS2\"}" "$KR"
UA="$(js b.data.updatedAt)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-replay-same-key 200 "b.data.updatedAt==='$UA'" "{\"startsAt\":\"$NEWS2\"}" "$KR"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-same-key-different-body '422 IdempotencyConflict' '' "{\"startsAt\":\"$(slot 12 15:00)\"}" "$KR"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-off-grid '422 OutsideWorkingHours' '' "{\"startsAt\":\"$(slot 12 15:15)\"}" "$(uuid)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-outside-hours '422 OutsideWorkingHours' '' "{\"startsAt\":\"$(slot 12 18:00)\"}" "$(uuid)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-to-past '422 BookingInPast' '' "{\"startsAt\":\"$(slot -1 10:00)\"}" "$(uuid)"
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-beyond-horizon '422 BeyondBookingHorizon' '' "{\"startsAt\":\"$(slot 61 10:00)\"}" "$(uuid)"
book "$(pt 561)" 613 13 10:00 reschedule-target-fixture-book
expect PATCH "/api/consultations/$R1/reschedule" patient "$(pt 560)" reschedule-onto-taken-slot '409 SlotUnavailable' '' "{\"startsAt\":\"$(slot 13 10:00)\"}" "$(uuid)"
check_value db 'failed reschedules left the row at its last good time' "$(slotutc "$NEWS2" | sed 's/Z$//')" "$(sql "SELECT to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') FROM consultations WHERE id=$R1")"
# concurrent reschedules onto one free slot
book "$(pt 562)" 613 14 09:00 reschedule-race-fixture-1; RA="$BID"
book "$(pt 563)" 613 14 10:00 reschedule-race-fixture-2; RB="$BID"
TGT="$(slot 15 10:00)"; PA="$(pt 562)"; PB="$(pt 563)"
( curl -sS -o "$TMP/ra.body" -w '%{http_code}' -X PATCH -H "Authorization: Bearer $PA" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" --data-binary "{\"startsAt\":\"$TGT\"}" "$CARE_URL/api/consultations/$RA/reschedule" > "$TMP/ra.status" ) &
( curl -sS -o "$TMP/rb.body" -w '%{http_code}' -X PATCH -H "Authorization: Bearer $PB" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" --data-binary "{\"startsAt\":\"$TGT\"}" "$CARE_URL/api/consultations/$RB/reschedule" > "$TMP/rb.status" ) &
wait
check_value concurrency 'two reschedules onto one slot: one 200 and one 409 SlotUnavailable' '200 409' "$(printf '%s\n' "$(cat "$TMP/ra.status")" "$(cat "$TMP/rb.status")" | sort | tr '\n' ' ' | sed 's/ $//')"
check_value concurrency 'the loser kept its old interval; one row at the target' 1 "$(sql "SELECT count(*) FROM consultations WHERE doctor_user_id=613 AND starts_at='$(slotutc "$TGT")'")"
# policy window (owner-SQL rows relative to now; +-5 min of the 120 min boundary)
W_IN="$(mkrow 611 565 115 booked)"; W_PAST="$(mkrow 611 566 -40 booked)"
expect PATCH "/api/consultations/$W_IN/reschedule" patient "$(pt 565)" reschedule-patient-inside-window-115min '409 PolicyWindowViolation' '' "{\"startsAt\":\"$(slot 16 10:00)\"}" "$(uuid)"
expect PATCH "/api/consultations/$W_PAST/reschedule" patient "$(pt 566)" reschedule-patient-start-already-past '409 PolicyWindowViolation' '' "{\"startsAt\":\"$(slot 16 10:00)\"}" "$(uuid)"
W_OUT="$(mkrow 613 567 125 booked)"
expect PATCH "/api/consultations/$W_OUT/reschedule" patient "$(pt 567)" reschedule-patient-outside-window-125min 200 '' "{\"startsAt\":\"$(slot 17 10:00)\"}" "$(uuid)"
expect PATCH "/api/consultations/$W_IN/reschedule" admin "$ADMIN" reschedule-admin-inside-window-with-reason 200 "!('complaintText' in b.data)&&b.data.status==='booked'&&b.data.timezone==='UTC'" "{\"startsAt\":\"$(slot 16 11:00)\",\"reason\":\"Synthetic $RMARK\"}" "$(uuid)"
check_value audit 'admin reschedule audited with byRole=admin and reasonLength only' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.rescheduled' AND entity_id=$W_IN AND actor_role='admin' AND metadata->>'byRole'='admin' AND (metadata->>'reasonLength')::int=$(( ${#RMARK} + 10 )) AND metadata::text NOT LIKE '%$RMARK%'")"
expect PATCH "/api/consultations/$W_PAST/reschedule" admin "$ADMIN" reschedule-admin-past-started-row 200 '' "{\"startsAt\":\"$(slot 16 12:00)\",\"reason\":\"Synthetic reason\"}" "$(uuid)"
# state errors
for st in waiting in_progress completed no_show cancelled; do
  off=$((500 + RANDOM % 1)); case $st in waiting) off=600;; in_progress) off=700;; completed) off=800;; no_show) off=900;; cancelled) off=1000;; esac
  rid_="$(mkrow 614 568 $off $st)"
  expect PATCH "/api/consultations/$rid_/reschedule" patient "$(pt 568)" "reschedule-status-$st" '409 InvalidTransition' '' "{\"startsAt\":\"$(slot 18 10:00)\"}" "$(uuid)"
done
# bookable guard on reschedule: flip doctor 612 not accepting
book "$(pt 569)" 612 19 10:00 reschedule-guard-fixture-book; RG="$BID"
sql "UPDATE doctor_profiles SET is_accepting_patients=false WHERE user_id=612" >/dev/null
expect PATCH "/api/consultations/$RG/reschedule" patient "$(pt 569)" reschedule-doctor-not-accepting '409 DoctorNotBookable' '' "{\"startsAt\":\"$(slot 19 11:00)\"}" "$(uuid)"
sql "UPDATE doctor_profiles SET is_accepting_patients=true WHERE user_id=612" >/dev/null

# ---- 8. Cancel ----
book "$(pt 570)" 613 20 10:00 cancel-fixture-book; X1="$BID"
expect PATCH "/api/consultations/$X1/cancel" patient "$(pt 570)" cancel-patient-outside-window-empty-body 200 "$SHAPE&&b.data.status==='cancelled'&&b.data.cancelledBy==='patient'&&b.data.cancelReason===null&&typeof b.data.cancelledAt==='string'&&b.data.complaintText.includes('$MARK')" '{}' "$(uuid)"
RC="$(cat "$TMP/rid")"
check_value audit 'consultation.cancelled audited (byRole, fromStatus; request id)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.cancelled' AND entity_id=$X1 AND request_id='$RC' AND metadata->>'byRole'='patient' AND metadata->>'fromStatus'='booked'")"
check_value outbox 'cancel queued cancelled for both parties' 2 "$(outbox_n "$X1" cancelled)"
book "$(pt 571)" 613 20 10:00 cancel-releases-slot-rebook-same-start
expect PATCH "/api/consultations/$X1/cancel" patient "$(pt 570)" cancel-already-cancelled-new-key '409 InvalidTransition' '' '{}' "$(uuid)"
book "$(pt 572)" 613 21 10:00 cancel-with-reason-fixture; X2="$BID"; KC="$(uuid)"
expect PATCH "/api/consultations/$X2/cancel" patient "$(pt 572)" cancel-patient-with-reason 200 "b.data.cancelReason==='Synthetic $RMARK'" "{\"reason\":\"Synthetic $RMARK\"}" "$KC"
CAT="$(js b.data.cancelledAt)"
expect PATCH "/api/consultations/$X2/cancel" patient "$(pt 572)" cancel-replay-same-key 200 "b.data.cancelledAt==='$CAT'" "{\"reason\":\"Synthetic $RMARK\"}" "$KC"
expect PATCH "/api/consultations/$X2/cancel" patient "$(pt 572)" cancel-same-key-different-body '422 IdempotencyConflict' '' '{"reason":"Another synthetic reason"}' "$KC"
check_value audit 'cancel audit stores reasonLength, never the reason' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='consultation.cancelled' AND entity_id=$X2 AND metadata ? 'reasonLength' AND metadata::text NOT LIKE '%$RMARK%'")"
expect GET "/api/consultations/$X2" patient "$(pt 572)" get-cancelled-shows-reason-to-owner 200 "b.data.status==='cancelled'&&b.data.cancelReason.includes('$RMARK')"
expect GET "/api/consultations/$X2" admin "$ADMIN" get-cancelled-admin-no-complaint 200 "!('complaintText' in b.data)&&b.data.cancelledBy==='patient'"
# policy window
C_IN="$(mkrow 611 573 160 booked)"
sql "UPDATE consultations SET starts_at=now()+interval '115 minutes', ends_at=now()+interval '145 minutes' WHERE id=$C_IN" >/dev/null
expect PATCH "/api/consultations/$C_IN/cancel" patient "$(pt 573)" cancel-patient-inside-window-115min '409 PolicyWindowViolation' '' '{}' "$(uuid)"
C_OUT="$(mkrow 613 574 125 booked)"
expect PATCH "/api/consultations/$C_OUT/cancel" patient "$(pt 574)" cancel-patient-outside-window-125min 200 '' '{}' "$(uuid)"
expect PATCH "/api/consultations/$C_IN/cancel" doctor "$D611" cancel-doctor-inside-window-with-reason 200 "b.data.cancelledBy==='doctor'" '{"reason":"Synthetic doctor reason"}' "$(uuid)"
C_ADM="$(mkrow 611 575 50 booked)"
expect PATCH "/api/consultations/$C_ADM/cancel" admin "$ADMIN" cancel-admin-inside-window-with-reason 200 "b.data.cancelledBy==='admin'&&!('complaintText' in b.data)" '{"reason":"Synthetic admin reason"}' "$(uuid)"
C_WAIT="$(mkrow 614 576 300 waiting)"
expect PATCH "/api/consultations/$C_WAIT/cancel" patient "$(pt 576)" cancel-waiting-allowed 200 "b.data.status==='cancelled'" '{}' "$(uuid)"
for st in in_progress completed no_show cancelled; do
  case $st in in_progress) off=400;; completed) off=450;; no_show) off=500;; cancelled) off=550;; esac
  rid_="$(mkrow 612 577 $((off+400)) $st)"
  expect PATCH "/api/consultations/$rid_/cancel" patient "$(pt 577)" "cancel-status-$st" '409 InvalidTransition' '' '{}' "$(uuid)"
done
rid_="$(mkrow 612 578 1500 in_progress)"
expect PATCH "/api/consultations/$rid_/cancel" admin "$ADMIN" cancel-admin-terminal-or-active-in_progress '409 InvalidTransition' '' '{"reason":"Synthetic reason"}' "$(uuid)"
check_value db 'chk_consultations_cancel_shape holds: every cancelled row has cancelled_at and cancelled_by' 0 "$(sql "SELECT count(*) FROM consultations WHERE status='cancelled' AND (cancelled_at IS NULL OR cancelled_by IS NULL)")"

# ---- 9. Reads: list, scope, pagination, hydration (Case 2) ----
flush_redis; curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
PL="$(pt 580)"
for h in 09:00 09:30 10:00 10:30 11:00; do book "$PL" 601 22 "$h" "list-fixture-book-$h"; done
expect GET '/api/consultations?limit=2' patient "$PL" list-patient-page-1 200 "b.data.length===2&&b.meta.hasMore===true&&typeof b.meta.nextCursor==='string'&&b.meta.count===2&&b.data.every(c=>c.patient.userId===580&&!('complaintText' in c))&&b.data[0].startsAt<b.data[1].startsAt&&b.data[0].doctor.profileHydrated===true&&b.data[0].doctor.displayName==='Synthetic User 601'&&b.data[0].patient.profileHydrated===false"
CUR="$(js b.meta.nextCursor)"; P1IDS="$(js 'b.data.map(c=>c.id).join()')"
check_value case2 'one batched Identity call for the page, ids = distinct counterpart (601) only' '1 601' "$(fake 'c.batchCount+" "+c.batches[0].ids.join()')"
check_value case2 'batch call forwards the request id' "$(cat "$TMP/rid")" "$(fake 'c.batches[0].requestId')"
expect GET "/api/consultations?limit=2&cursor=$CUR" patient "$PL" list-patient-page-2 200 "b.data.length===2&&b.meta.hasMore===true&&!'$P1IDS'.split(',').includes(String(b.data[0].id))"
CUR2="$(js b.meta.nextCursor)"; P2IDS="$(js 'b.data.map(c=>c.id).join()')"
check_value case2 'cache hit: page 2 added no Identity call' 1 "$(fake 'c.batchCount')"
expect GET "/api/consultations?limit=2&cursor=$CUR2" patient "$PL" list-patient-page-3-last 200 "b.data.length===1&&b.meta.hasMore===false&&b.meta.nextCursor===null"
check_value pagination 'pages cover all 5 rows once, in ascending order' 5 "$(echo "$P1IDS,$P2IDS,$(js 'b.data[0].id')" | tr ',' '\n' | sort -u | wc -l | tr -d ' ')"
expect GET '/api/consultations' patient "$PL" list-default-limit-and-scope-upcoming 200 'b.data.length===5&&b.data.every(c=>Date.parse(c.endsAt)>Date.now())'
expect GET '/api/consultations?scope=past' patient "$PL" list-scope-past-empty 200 'b.data.length===0'
expect GET '/api/consultations?scope=all&status=cancelled' patient "$PL" list-status-filter-empty 200 'b.data.length===0'
expect GET '/api/consultations?status=booked,waiting&scope=all' patient "$PL" list-status-comma-list 200 'b.data.length===5'
expect GET "/api/consultations?from=$(slot 22 09:00 Africa/Cairo | sed 's/+/%2B/')&to=$(slot 22 10:30 Africa/Cairo | sed 's/+/%2B/')" patient "$PL" list-from-to-bounds-startsAt 200 'b.data.length===3'
expect GET '/api/consultations?timezone=Asia/Tokyo&limit=1' patient "$PL" list-timezone-override-honored 200 "b.data[0].timezone==='Asia/Tokyo'&&b.data[0].startsAtLocal.endsWith('+09:00')"
expect GET '/api/consultations?limit=1' patient "$PL" list-default-tz-is-patientTimezone 200 "b.data[0].timezone==='Europe/Berlin'"
# past scope with completed rows (doctor 611 has completed fixture rows via owner SQL, patient 581)
sql "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash)
     SELECT 611,581,$(tid 611),now()-interval '1 day'*g-interval '1 hour',now()-interval '1 day'*g-interval '30 minutes','completed','$MARK past','Africa/Cairo',500,'EGP',gen_random_uuid(),repeat('0',64) FROM generate_series(1,3) g" >/dev/null
expect GET '/api/consultations?scope=past' patient "$(pt 581)" list-scope-past-descending 200 'b.data.length===3&&b.data[0].startsAt>b.data[1].startsAt&&b.data[1].startsAt>b.data[2].startsAt&&b.data.every(c=>Date.parse(c.endsAt)<=Date.now())'
expect GET '/api/consultations?scope=upcoming' patient "$(pt 581)" list-scope-upcoming-excludes-past 200 'b.data.length===0'
expect GET '/api/consultations?scope=all' patient "$(pt 581)" list-scope-all-ascending 200 'b.data.length===3&&b.data[0].startsAt<b.data[2].startsAt'
# doctor / admin viewers
expect GET '/api/consultations?limit=3' doctor "$D601" list-doctor-own-rows-doctor-timezone-default 200 "b.data.every(c=>c.doctor.userId===601)&&b.data[0].timezone==='Africa/Cairo'&&b.data[0].patient.profileHydrated===true&&b.data[0].doctor.profileHydrated===false&&b.data.every(c=>!('complaintText' in c))"
expect GET '/api/consultations?limit=100&scope=all' doctor "$D602" list-other-doctor-sees-none-of-601 200 'b.data.length===0'
expect GET '/api/consultations?scope=all&limit=100' admin "$ADMIN" list-admin-all-both-sides-hydrated-no-complaint 200 "b.data.length>10&&b.data.every(c=>!('complaintText' in c))&&b.data[0].timezone==='UTC'&&b.data.filter(c=>c.doctor.profileHydrated&&c.patient.profileHydrated).length>0"
expect GET '/api/consultations?scope=all&doctorUserId=601&patientUserId=580&limit=100' admin "$ADMIN" list-admin-filter-doctor-and-patient 200 'b.data.length===5&&b.data.every(c=>c.doctor.userId===601&&c.patient.userId===580)'
expect GET '/api/consultations?scope=all&patientUserId=580&timezone=America/New_York&limit=1' admin "$ADMIN" list-admin-timezone-override 200 "b.data[0].timezone==='America/New_York'"
# Case 2 degrade
for m in down hang slow; do
  flush_redis; ctl "$m"
  T_A=$SECONDS
  expect GET '/api/consultations?limit=2' patient "$PL" "case2-list-identity-$m" 200 "b.data.length===2&&($( [ $m = slow ] && echo "b.data[0].doctor.profileHydrated===true" || echo "b.data.every(c=>c.doctor.profileHydrated===false&&c.doctor.displayName===null&&c.doctor.avatarUrl===null)" ))&&b.data.every(c=>c.price.amount===500&&typeof c.startsAt==='string')"
  expect GET "/api/consultations/$(js 'b.data[0].id')" patient "$PL" "case2-get-identity-$m" 200 "$( [ $m = slow ] && echo "b.data.doctor.profileHydrated===true" || echo "b.data.doctor.profileHydrated===false&&b.data.doctor.displayName===null" )&&b.data.complaintText.includes('$MARK')"
  expect GET '/api/consultations?limit=2&scope=all' admin "$ADMIN" "case2-admin-list-identity-$m" 200 "b.data.length===2"
done
ctl healthy; flush_redis
expect GET '/api/consultations?limit=2' patient "$PL" case2-recovers-when-identity-healthy 200 'b.data.every(c=>c.doctor.profileHydrated===true)'
check_value case2 'cache-primed second call made no extra Identity call' "$(fake 'c.batchCount')" "$(call GET '/api/consultations?limit=2' "$PL" >/dev/null; fake 'c.batchCount')"
expect POST /api/consultations patient "$(pt 582)" book-while-identity-down-never-waits 201 'b.data.doctor.profileHydrated===false' "$(cbody 601 "$T601" "$(slot 23 10:00)")" "$(uuid)"

# ---- 10. Follow-up flags ----
# 10a. doctor suspension (Case 3, fake Identity healthy) flags future non-terminal rows only
S3A="$(slot 24 09:00)"
for h in 09:00 09:30 10:00; do book "$(pt 585)" 603 25 "$h" "suspension-fixture-book-$h"; eval "F$(echo $h | tr -d :)=$BID"; done
F_CANC="$BID"; expect PATCH "/api/consultations/$F1000/cancel" patient "$(pt 585)" suspension-fixture-cancel-one 200 '' '{}' "$(uuid)"
F_PAST="$(mkrow 603 586 -300 completed)"
expect PATCH /api/admin/doctors/603/suspend admin "$ADMIN2" suspend-doctor-flags-consultations 200 "b.data.flaggedConsultationIds.length===2&&b.data.flaggedConsultationIds.map(Number).sort().join()==='$(echo $F0900 $F0930 | tr ' ' '\n' | sort -n | tr '\n' ',' | sed 's/,$//')'" '{"reason":"Synthetic QA reason"}' "$(uuid)"
check_value followup 'flagged rows: doctor_suspended, status unchanged (never cancelled)' '2 booked' "$(sql "SELECT count(*) || ' ' || min(status) FROM consultations WHERE id IN ($F0900,$F0930) AND needs_admin_followup AND followup_reason='doctor_suspended'")"
check_value followup 'cancelled and completed rows were not flagged' 0 "$(sql "SELECT count(*) FROM consultations WHERE id IN ($F1000,$F_PAST) AND needs_admin_followup")"
check_value audit 'consultation.flagged_for_followup audit rows written (ids only)' 1 "$([ "$(audit_n consultation.flagged_for_followup)" -ge 1 ] && echo 1 || echo 0)"
expect POST /api/consultations patient "$(pt 587)" book-suspended-doctor-blocked '409 DoctorNotBookable' '' "$(cbody 603 "$T603" "$(slot 26 10:00)")" "$(uuid)"
expect PATCH "/api/consultations/$F0900/cancel" doctor "$D603" cancel-by-locally-suspended-doctor '403 Forbidden' '' '{"reason":"Synthetic reason"}' "$(uuid)"
expect GET "/api/consultations/$F0900" doctor "$D603" suspended-doctor-can-still-read-own 200 'b.data.needsAdminFollowup===true&&b.data.followupReason==="doctor_suspended"&&b.data.status==="booked"'
expect GET /api/patients/585 doctor-suspended "$D603" patient-profile-suspended-doctor '403 Forbidden'
expect GET '/api/consultations?needsAdminFollowup=true&doctorUserId=603' admin "$ADMIN" followup-queue-lists-flagged-rows 200 "b.data.length===2&&b.data.every(c=>c.needsAdminFollowup&&c.followupReason==='doctor_suspended'&&c.status==='booked')&&b.data[0].startsAt<=b.data[1].startsAt"
expect GET '/api/consultations?needsAdminFollowup=true&doctorUserId=603&status=cancelled' admin "$ADMIN" followup-queue-intersects-status-filter 200 'b.data.length===0'
expect PATCH "/api/consultations/$F0900/reschedule" admin "$ADMIN" reschedule-flagged-row-on-suspended-doctor '409 DoctorNotBookable' '' "{\"startsAt\":\"$(slot 26 11:00)\",\"reason\":\"Synthetic reason\"}" "$(uuid)"
expect PATCH "/api/consultations/$F0900/cancel" admin "$ADMIN" admin-cancels-flagged-row 200 "b.data.status==='cancelled'" '{"reason":"Synthetic reason"}' "$(uuid)"
expect GET '/api/consultations?needsAdminFollowup=true&doctorUserId=603' admin "$ADMIN" followup-queue-drops-cancelled-row 200 "b.data.length===1&&b.data[0].id===$F0930"
expect GET '/api/consultations?needsAdminFollowup=false&doctorUserId=603&scope=all&limit=100' admin "$ADMIN" followup-false-filter 200 "b.data.every(c=>c.needsAdminFollowup===false)"
# 10b. schedule block with confirmConflicts (doctor 604)
book "$(pt 588)" 604 28 10:00 block-fixture-day28-A; BK1="$BID"
book "$(pt 589)" 604 28 11:00 block-fixture-day28-B; BK2="$BID"
book "$(pt 589)" 604 29 10:00 block-fixture-day29; BK3="$BID"
book "$(pt 588)" 604 30 10:00 block-fixture-day30-custom; BK4="$BID"
WD28="$(wday "$(ldate Africa/Cairo 28)")"
HOURS_NO28='{"days":['"$(for d in 1 2 3 4 5 6 7; do [ "$d" = "$WD28" ] || printf '{"weekday":%s,"intervals":[{"startTime":"09:00","endTime":"17:00"}]},' $d; done | sed 's/,$//')"'],"confirmConflicts":false}'
expect PUT /api/doctors/me/working-hours doctor "$D604" hours-removal-without-confirm-lists-real-ids '409 ScheduleConflictsUnconfirmed' "JSON.stringify(b).includes('$BK1')&&JSON.stringify(b).includes('$BK2')&&!JSON.stringify(b).includes('\"id\":$BK3')" "$HOURS_NO28"
check_value followup 'unconfirmed block flagged nothing' 0 "$(sql "SELECT count(*) FROM consultations WHERE doctor_user_id=604 AND needs_admin_followup")"
expect PUT /api/doctors/me/working-hours doctor "$D604" hours-removal-with-confirm-applies 200 '' "${HOURS_NO28/\"confirmConflicts\":false/\"confirmConflicts\":true}"
check_value followup 'confirmed block flags the two day-28 rows schedule_blocked, others untouched, none cancelled' '2 booked' "$(sql "SELECT count(*) || ' ' || min(status) FROM consultations WHERE id IN ($BK1,$BK2) AND needs_admin_followup AND followup_reason='schedule_blocked'")"
check_value followup 'unaffected rows not flagged' 0 "$(sql "SELECT count(*) FROM consultations WHERE id IN ($BK3,$BK4) AND needs_admin_followup")"
check_value outbox 'schedule_blocked queued to each affected patient' '2 588,589' "$(sql "SELECT count(*) || ' ' || string_agg(recipient_user_id::text, ',' ORDER BY recipient_user_id) FROM notification_outbox WHERE consultation_id IN ($BK1,$BK2) AND kind='schedule_blocked'")"
check_value audit 'schedule.conflicts_confirmed audited' 1 "$([ "$(audit_n schedule.conflicts_confirmed)" -ge 1 ] && echo 1 || echo 0)"
expect GET "/api/consultations/$BK1" doctor "$D604" flagged-row-visible-to-doctor 200 "b.data.needsAdminFollowup===true&&b.data.followupReason==='schedule_blocked'&&b.data.status==='booked'"
# day_off exception over a booking, then custom hours
D29="$(ldate Africa/Cairo 29)"
expect POST /api/doctors/me/exceptions doctor "$D604" exception-day-off-unconfirmed '409 ScheduleConflictsUnconfirmed' "JSON.stringify(b).includes('$BK3')" "{\"type\":\"day_off\",\"date\":\"$D29\"}"
expect POST /api/doctors/me/exceptions doctor "$D604" exception-day-off-confirmed 201 '' "{\"type\":\"day_off\",\"date\":\"$D29\",\"confirmConflicts\":true}"
check_value followup 'day_off flagged the day-29 row' 'schedule_blocked' "$(sql "SELECT followup_reason FROM consultations WHERE id=$BK3")"
D30="$(ldate Africa/Cairo 30)"
expect POST /api/doctors/me/exceptions doctor "$D604" exception-custom-hours-uncovering-unconfirmed '409 ScheduleConflictsUnconfirmed' "JSON.stringify(b).includes('$BK4')" "{\"type\":\"custom_hours\",\"date\":\"$D30\",\"startTime\":\"13:00\",\"endTime\":\"15:00\"}"
expect POST /api/doctors/me/exceptions doctor "$D604" exception-custom-hours-covering-booking-no-conflict 201 '' "{\"type\":\"custom_hours\",\"date\":\"$D30\",\"startTime\":\"09:30\",\"endTime\":\"12:00\"}"
check_value followup 'covering custom hours flags nothing' false "$(sql "SELECT needs_admin_followup::text FROM consultations WHERE id=$BK4")"
# reschedule clears the flag
expect PATCH "/api/consultations/$BK1/reschedule" patient "$(pt 588)" reschedule-flagged-row-clears-flag 200 'b.data.needsAdminFollowup===false&&b.data.followupReason===null' "{\"startsAt\":\"$(slot 31 10:00)\"}" "$(uuid)"

# ---- 11. Patients/{id} relationship rules ----
expect PATCH /api/patients/me patient "$(pt 590)" setup-profile-590 200 '' '{"timezone":"Africa/Cairo"}'
rel() { # rel <status> <expect>
  local row; row="$(mkrow 602 590 "$3" "$1")"
  expect GET /api/patients/590 doctor "$D602" "patient-profile-relationship-$1" "$2"
}
expect GET /api/patients/590 doctor "$D602" patient-profile-no-relationship '404 NotFound'
rel cancelled '404 NotFound' 2000
rel no_show '404 NotFound' 2100
rel booked 200 2200
check_value audit 'related-doctor read audited' 1 "$(audit_n patient_profile.read '' 602 | awk '{print ($1>=1)?1:0}')"
sql "UPDATE consultations SET status='cancelled', cancelled_at=now(), cancelled_by='patient' WHERE patient_user_id=590" >/dev/null
expect GET /api/patients/590 doctor "$D602" patient-profile-only-cancelled-after-booked-cancelled '404 NotFound'
rel waiting 200 2300
rel in_progress 200 2400
sql "DELETE FROM notification_outbox WHERE consultation_id IN (SELECT id FROM consultations WHERE patient_user_id=590); DELETE FROM consultations WHERE patient_user_id=590" >/dev/null
rel completed 200 -2000
expect GET /api/patients/590 patient-self "$(pt 590)" patient-profile-self-590 200 'b.data.userId===590'

# ---- 12. No-store, request id, headers ----
expect POST /api/consultations patient "$(pt 595)" malformed-json-body-no-store '400 ValidationFailed' '' '{"doctorId":' "$(uuid)"
check_value no-store 'malformed JSON on /api/consultations carries Cache-Control: no-store' 1 "$(hdr_has '^cache-control: .*no-store')"
expect PATCH /api/patients/me patient "$(pt 596)" malformed-json-patients-no-store '400 ValidationFailed' '' '{"timezone":'
check_value no-store 'malformed JSON on /api/patients carries Cache-Control: no-store' 1 "$(hdr_has '^cache-control: .*no-store')"
H="$(curl -s -D - -o /dev/null -H 'X-Request-Id: not-a-uuid' -H "Authorization: Bearer $(pt 501)" "$CARE_URL/api/consultations?limit=1" || true)"
check_value request-id 'non-UUID incoming X-Request-Id is replaced by a generated UUID' 1 "$(echo "$H" | grep -ciE '^x-request-id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || true)"
check_value headers 'helmet header present on consultations responses' 1 "$(echo "$H" | grep -ci '^x-content-type-options: nosniff' || true)"

# ---- 13. Database guarantees ----
check_value grants 'vcare_app on consultations: select,insert,update yes, delete no' 'true true true false' "$(sql "SELECT has_table_privilege('vcare_app','consultations','SELECT')::text||' '||has_table_privilege('vcare_app','consultations','INSERT')::text||' '||has_table_privilege('vcare_app','consultations','UPDATE')::text||' '||has_table_privilege('vcare_app','consultations','DELETE')::text")"
check_value grants 'vcare_app on notification_outbox: select,insert yes, update,delete no' 'true true false false' "$(sql "SELECT has_table_privilege('vcare_app','notification_outbox','SELECT')::text||' '||has_table_privilege('vcare_app','notification_outbox','INSERT')::text||' '||has_table_privilege('vcare_app','notification_outbox','UPDATE')::text||' '||has_table_privilege('vcare_app','notification_outbox','DELETE')::text")"
OVL="$(psql "$CARE_OWNER_DATABASE_URL" -XAt -c "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash) SELECT doctor_user_id,599,consultation_type_id,starts_at+interval '10 minutes',ends_at+interval '10 minutes','booked','x','UTC',1,'EGP',gen_random_uuid(),repeat('0',64) FROM consultations WHERE id=$C1" 2>&1 | tr -d '\r' || true)"
check_value db 'direct overlapping INSERT rejected by excl_consultations_doctor_no_overlap (23P01)' 1 "$(echo "$OVL" | grep -c 'excl_consultations_doctor_no_overlap' || true)"
check_value db 'no live overlapping pair exists in fixtures' 0 "$(sql "SELECT count(*) FROM consultations a JOIN consultations b ON a.doctor_user_id=b.doctor_user_id AND a.id<b.id AND tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)') WHERE a.status NOT IN ('cancelled','no_show') AND b.status NOT IN ('cancelled','no_show') AND a.deleted_at IS NULL AND b.deleted_at IS NULL AND a.doctor_user_id BETWEEN 600 AND 699")"
check_value db 'every booked consultation duration equals its type duration' 0 "$(sql "SELECT count(*) FROM consultations c JOIN consultation_types t ON t.id=c.consultation_type_id WHERE c.doctor_user_id BETWEEN 600 AND 699 AND c.created_at >= '$T0' AND extract(epoch from c.ends_at-c.starts_at)/60 <> t.duration_minutes")"
check_value privacy 'audit metadata holds no complaint or reason marker' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND (metadata::text LIKE '%$MARK%' OR metadata::text LIKE '%$RMARK%' OR metadata::text LIKE '%Synthetic%')")"
check_value privacy 'outbox payloads hold no complaint or reason marker' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE payload::text LIKE '%$MARK%' OR payload::text LIKE '%$RMARK%'")"
check_value privacy 'audit metadata keys on consultation rows are flat scalars from the allowed set' 0 "$(sql "SELECT count(*) FROM audit_logs a, jsonb_each(a.metadata) e WHERE a.created_at >= '$T0' AND a.entity_type='consultation' AND jsonb_typeof(e.value) IN ('object','array')")"

# ---- 14. Log hygiene ----
if [ -n "${SERVER_LOG:-}" ] && [ -f "$SERVER_LOG" ]; then
  NEWLOG="$(tail -n +"$((LOG_MARK+1))" "$SERVER_LOG")"
  check_value logs 'care-api log has no complaint/reason markers, tokens, hydrated names' 0 "$(echo "$NEWLOG" | grep -cE "$MARK|$RMARK|Bearer |Synthetic User|TEST-ALLERGEN|fake-service-token" || true)"
  check_value logs 'care-api log has no level=error line' 0 "$(echo "$NEWLOG" | grep -c '"level":"error"' || true)"
  check_value logs 'identity degradation is logged without user data' 1 "$([ "$(echo "$NEWLOG" | grep -ciE 'identity_hydration_degraded|hydration' || true)" -ge 1 ] && echo 1 || echo 0)"
fi

# ---- 15. Rate limits (last: they exhaust windows) ----
NO_THROTTLE=1
RL="$(pt 597)"
book "$RL" 615 40 10:00 ratelimit-fixture-book; RLC="$BID"
ok=1
for i in 1 2 3 4 5 6 7 8; do s="$(call POST /api/consultations "$RL" '{}' "$(uuid)")"; [ "$s" = 400 ] || ok=0; done
check_value rate-limit 'writes 1..9 in the window pass the limiter (8 validation 400s after one booking)' 1 "$ok"
s="$(call PATCH "/api/consultations/$RLC/reschedule" "$RL" '{}' "$(uuid)")"
check_value rate-limit 'the 10th write (reschedule, shared bucket) is still allowed (400 validation)' 400 "$s"
expect PATCH "/api/consultations/$RLC/cancel" patient "$RL" write-11th-limited-shared-bucket '429 RateLimited' '' '{}' "$(uuid)"
check_value rate-limit 'Retry-After present on 429' 1 "$(hdr_has '^retry-after: ')"
expect POST /api/consultations patient "$(pt 598)" write-limit-is-per-user '201' '' "$(cbody 615 "$(tid 615)" "$(slot 41 10:00)")" "$(uuid)"
expect GET /api/consultations patient "$RL" reads-not-blocked-by-write-limit 200
ok=1
for i in $(seq 1 60); do s="$(call PATCH "/api/consultations/$RLC/cancel" "$ADMIN77" '{}' "$(uuid)")"; [ "$s" = 400 ] || ok=0; done
check_value rate-limit 'admin: 60 writes pass the limiter (own bucket)' 1 "$ok"
expect PATCH "/api/consultations/$RLC/cancel" admin "$ADMIN77" admin-write-61st-limited '429 RateLimited' '' '{}' "$(uuid)"
RD="$(pt 599)"; ok=1
for i in $(seq 1 120); do s="$(call GET /api/consultations "$RD")"; [ "$s" = 200 ] || ok=0; done
check_value rate-limit 'first 120 reads in the window all 200' 1 "$ok"
expect GET /api/consultations patient "$RD" read-121st-limited '429 RateLimited'
check_value rate-limit 'Retry-After present on read 429' 1 "$(hdr_has '^retry-after: ')"
expect GET "/api/consultations/$RLC" patient "$RD" get-one-non-owner-404-precedes-read-limiter '404 NotFound'
check_value audit '429 reads wrote no consultation.read row' 0 "$(audit_n consultation.read '' 599)"

echo
echo "Result: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
