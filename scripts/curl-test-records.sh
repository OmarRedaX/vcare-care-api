#!/usr/bin/env bash
# Repeatable HTTP QA for the records module: POST /api/consultations/{id}/record, GET|PATCH /api/records/{id},
# GET /api/patients/{patientUserId}/records, plus Consultation.hasRecord and POST /api/consultations with followUpOfRecordId.
# Use only a disposable *_test or *_qa* database: fixtures TRUNCATE consultations, medical_records and the outbox.
#
# Start first (see docs/records/manual-qa.md -> Environment):
#   node scripts/consultations-qa-fake-identity.mjs     # JWKS + user tokens + fake Identity internal API (FAKE_IDENTITY_PORT, default 3023)
#   npx tsx src/server.ts                                # the real Care API (PORT=3001, INTERNAL_PORT=3101, NODE_ENV=development),
#                                                        # DATABASE_URL = the care_app login, REDIS_URL on a spare db index
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH), REDIS_URL (same spare db as the server; it is
#           flushed before EVERY call so rate limits and the Identity cache start clean).
# Optional: CARE_URL (default http://127.0.0.1:3001), FAKE_IDENTITY_URL (default http://127.0.0.1:3023),
#           CARE_APP_DATABASE_URL (the care_app login: enables the direct grant / trigger checks),
#           QA_REPORT (file receiving the case table), SERVER_LOG (care-api log; scanned for clinical-text / token leaks),
#           QA_KEEP=1 (skip the end-of-run fixture reset), QA_DEBUG_FILE (keeps the first 400 bytes of the body of a failed case).
# Synthetic fixtures: patients 501-503, doctors 601-606, admins 1, 2 (patient 507 for the empty timeline). Clinical text is only the QA-REC-* markers below.
# Time: the lock instant is reached by moving created_at / updated_at / locked_at together as the table owner while the row is still
#       open (the BEFORE UPDATE trigger refuses any later update, the owner's included).
set -euo pipefail
export MSYS_NO_PATHCONV=1

CARE_URL="${CARE_URL:-http://127.0.0.1:3001}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3023}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
: "${REDIS_URL:?Set REDIS_URL to the spare Redis db index the server uses}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
export REDIS_URL
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"
PASS=0; FAIL=0; CASE=0; SKIP=0
CH='QA-REC-CHIEF-6601'; NO='QA-REC-NOTES-6602'; DX='QA-REC-DXTEXT-6603'; PL='QA-REC-PLAN-6604'; RS='QA-REC-REASON-6605'; AL='QA-REC-ALLERGEN-5521'
export QA_MARKERS="$CH,$NO,$DX,$PL,$RS,$AL"

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
asapp() { psql "$CARE_APP_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" 2>&1 | tr -d '\r' || true; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
pt() { mint "patient-$1"; }; dt() { mint "doctor-$1"; }; at() { mint "admin-$1"; }
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/body" "$1"; }
fake() { curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(eval(process.argv[1])))' "$1"; }
flush_redis() { node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null; }
isoz() { node -e 'process.stdout.write(new Date(Date.now()+Number(process.argv[1])*1000).toISOString().replace(/\.\d{3}Z$/,"Z"))' -- "$1"; }
slot() { node -e 'const {DateTime}=require("luxon");const [d,t,z]=[Number(process.argv[1]),process.argv[2],process.argv[3]||"Africa/Cairo"];const [h,m]=t.split(":").map(Number);process.stdout.write(DateTime.now().setZone(z).plus({days:d}).set({hour:h,minute:m,second:0,millisecond:0}).toISO({suppressMilliseconds:true}))' -- "$1" "$2" "${3:-}"; }
rep() { node -e 'process.stdout.write(process.argv[1].repeat(Number(process.argv[2])))' -- "$1" "$2"; }

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
# check_body <ok|error> <code> [assertion_js]: X-Request-Id echoed, no-store, envelope; an ERROR body never carries a clinical marker; assertion over `b`
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: .*no-store/im.test(h)) process.exit(1);
const raw = fs.readFileSync(file, 'utf8');
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (kind === 'error') {
  if (process.env.QA_MARKERS.split(',').some((m) => raw.includes(m))) process.exit(1);
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
  # QA_DEBUG_FILE (optional, off by default): on a failed case keep the first 400 bytes of the response body for diagnosis
  [ "$ok" = 1 ] || [ -z "${QA_DEBUG_FILE:-}" ] || { printf 'CASE %s %s
' "$CASE" "$(head -c 400 "$TMP/body")" >> "$QA_DEBUG_FILE"; }
}
check_value() { record check "$1" owner "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"; }
skip_note() { SKIP=$((SKIP+1)); echo "SKIPPED|$1" | tee -a "${QA_REPORT:-$TMP/report}"; }
audit_n() { sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='$1' ${2:+AND entity_id=$2} ${3:+AND actor_user_id=$3}"; }
audit_all() { sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action IN ('record.created','record.read','record.updated','record.amended','patient_records.listed')"; }
rec_n() { sql "SELECT count(*) FROM medical_records"; }
amd_n() { sql "SELECT count(*) FROM medical_record_amendments WHERE medical_record_id=$1"; }
rowhash() { sql "SELECT md5(row_to_json(m)::text) FROM medical_records m WHERE id=$1"; }
# burst <n> <method> <path> <token> [body]: n quick calls, prints the status histogram
burst() {
  local n="$1" method="$2" path="$3" token="$4" body="${5:-}" args i
  args=(-sS -o "$TMP/burst.body" -w '%{http_code}\n' -X "$method" -H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  for i in $(seq 1 "$n"); do curl "${args[@]}" "$CARE_URL$path"; done | sort | uniq -c | awk '{printf "%s x%s;", $2, $1}'
}
# lock_in <recordId> <seconds>: positive = locks that many seconds from now (still open); negative = locked that long ago (row must still be open now)
lock_in() {
  sql "UPDATE medical_records SET created_at = now() - interval '24 hours' + ($2 * interval '1 second'), updated_at = now() - interval '24 hours' + ($2 * interval '1 second'),
       locked_at = now() + ($2 * interval '1 second') WHERE id = $1" >/dev/null
}

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }

reset() {
  sql "TRUNCATE notification_outbox, medical_record_amendments, medical_records, consultations;
       DELETE FROM identity_sync_jobs WHERE doctor_user_id BETWEEN 600 AND 699;
       DELETE FROM schedule_exceptions WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM working_hours WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699;
       DELETE FROM patient_profiles WHERE user_id BETWEEN 500 AND 599;" >/dev/null
}
cleanup() { [ -n "${QA_KEEP:-}" ] || reset 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
reset; flush_redis; curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
T0="$(sql 'select now()')"
LOG_MARK=0; [ -z "${SERVER_LOG:-}" ] || LOG_MARK="$(wc -l < "$SERVER_LOG")"

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
ADMIN="$(at 1)"; ADMIN2="$(at 2)"
EXPIRED="$(mint expired)"; SVC="$(curl -fsS "$FAKE_IDENTITY_URL/mint?case=patient-501&typ=service")"
echo 'case|method|path|role|scenario|expected|got|result'

HOURS='{"days":['"$(for d in 1 2 3 4 5 6 7; do printf '{"weekday":%s,"intervals":[{"startTime":"00:00","endTime":"23:59"}]},' $d; done | sed 's/,$//')"']}'
# mkdoc <userId>: an approved, synced, bookable doctor through the real onboarding routes + owner SQL for the decision
mkdoc() {
  local uid="$1" t
  t="$(dt "$uid")"
  [ "$(call POST /api/doctors/apply "$t" "{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"Africa/Cairo\",\"submit\":false}")" = 201 ] || { echo "fixture apply failed for doctor $uid" >&2; exit 2; }
  sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$uid" >/dev/null
  [ "$(call POST /api/doctors/me/consultation-types "$t" '{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}')" = 201 ] || { echo "fixture type failed for $uid" >&2; exit 2; }
  [ "$(call PUT /api/doctors/me/working-hours "$t" "$HOURS")" = 200 ] || { echo "fixture hours failed for $uid" >&2; exit 2; }
}
tid() { sql "SELECT id FROM consultation_types WHERE doctor_profile_id=(SELECT id FROM doctor_profiles WHERE user_id=$1) ORDER BY id LIMIT 1"; }
# mkrow <doctor> <patient> <startOffsetSeconds> <status>: owner-SQL consultation fixture relative to the database clock (30 minutes)
mkrow() {
  sql "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash,cancelled_at,cancelled_by,joined_at,started_at,completed_at,no_show_marked_at)
       VALUES ($1,$2,$(tid "$1"),now()+interval '$3 seconds',now()+interval '$3 seconds'+interval '30 minutes','$4','QA synthetic complaint','Africa/Cairo',500,'EGP',gen_random_uuid(),repeat('0',64),
       CASE WHEN '$4'='cancelled' THEN now() END, CASE WHEN '$4'='cancelled' THEN 'doctor' END,
       CASE WHEN '$4' IN ('waiting','in_progress','completed') THEN now() END, CASE WHEN '$4' IN ('in_progress','completed') THEN now() END,
       CASE WHEN '$4'='completed' THEN now() END, CASE WHEN '$4'='no_show' THEN now() END) RETURNING id" | head -1
}
# comp <doctor> <patient>: a fresh COMPLETED consultation 1.1-2 days in the past, its own hour (no overlap for one doctor)
# counters live in files: the helpers run inside command substitutions, so shell variables would not survive
echo 0 > "$TMP/kn"; echo 0 > "$TMP/fn"
bump() { local n; n=$(( $(cat "$TMP/$1") + 1 )); echo "$n" > "$TMP/$1"; echo "$n"; }
comp() { mkrow "$1" "$2" "$((-90000 - 3600 * $(bump kn)))" completed; }
fut() { mkrow "$1" "$2" "$((3600 + 7200 * $(bump fn)))" "$3"; }

# ---- 0. Fixtures ----
for d in 601 602 603 604 606; do mkdoc "$d"; done
D601="$(dt 601)"; D602="$(dt 602)"; D603="$(dt 603)"; D604="$(dt 604)"; D606="$(dt 606)"
P501="$(pt 501)"; P502="$(pt 502)"; P503="$(pt 503)"
DPEND="$(mint doctor-pending)"; PPEND="$(mint patient-pending)"; ASUSP="$(mint admin-suspended)"
[ "$(call PATCH /api/patients/me "$P501" "{\"timezone\":\"Africa/Cairo\",\"allergies\":[\"$AL\"]}")" = 200 ] || { echo 'fixture patient profile failed' >&2; exit 2; }
NOBODY=99999999
# relationship fixtures: 602 holds a booked consultation with 501 (related, not assigned); 606 only cancelled / no_show rows (grants nothing); 604 none
R602="$(fut 602 501 booked)"; R606a="$(fut 606 501 cancelled)"; R606b="$(fut 606 501 no_show)"
REC_SHAPE='["id","consultationId","patientUserId","doctorUserId","chiefComplaint","examinationNotes","diagnosisText","diagnosisCode","treatmentPlan","followUpInDays","lockedAt","isLocked","amendments","attachments","createdAt","updatedAt"].every(k=>k in b.data)&&Object.keys(b.data).length===16&&Array.isArray(b.data.attachments)&&b.data.attachments.length===0&&Array.isArray(b.data.amendments)&&!/downloadUrl|objectKey|deletedAt|deleted_at/.test(JSON.stringify(b))&&Date.parse(b.data.lockedAt)-Date.parse(b.data.createdAt)===86400000&&b.data.lockedAt.endsWith("Z")'
FULL="{\"chiefComplaint\":\"$CH\",\"examinationNotes\":\"$NO\",\"diagnosisText\":\"$DX\",\"diagnosisCode\":\"Z99.9\",\"treatmentPlan\":\"$PL\",\"followUpInDays\":14}"

# ---- 1. Authentication matrix (all four routes) ----
CMAIN="$(comp 601 501)"
for who in "none|" "malformed|garbage.token.value" "expired|$EXPIRED" "service-token|$SVC"; do
  n="${who%%|*}"; t="${who#*|}"
  exp='401 Unauthorized'; [ "$n" = expired ] && exp='401 TokenExpired'
  expect POST "/api/consultations/$CMAIN/record" "$n" "$t" "create $n" "$exp" '' "$FULL"
  expect GET "/api/records/1" "$n" "$t" "get $n" "$exp"
  expect PATCH "/api/records/1" "$n" "$t" "patch $n" "$exp" '' '{"followUpInDays":3}'
  expect GET "/api/patients/501/records" "$n" "$t" "timeline $n" "$exp"
done
check_value auth 'unauthenticated calls created nothing' "0 0" "$(rec_n) $(audit_all)"

# ---- 2. Role / account-state denials that never reach a lookup ----
for who in "admin|$ADMIN" "admin2|$ADMIN2"; do
  n="${who%%|*}"; t="${who#*|}"
  expect POST "/api/consultations/$CMAIN/record" "$n" "$t" "create denied for $n (existing consultation)" '403 Forbidden' '' "$FULL"
  expect POST "/api/consultations/$NOBODY/record" "$n" "$t" "create denied for $n (unknown consultation: role beats lookup)" '403 Forbidden' '' "$FULL"
  expect POST "/api/consultations/abc/record" "$n" "$t" "create denied for $n (non-numeric id)" '403 Forbidden' '' "$FULL"
  expect GET "/api/records/$NOBODY" "$n" "$t" "get denied for $n (unknown id)" '403 Forbidden'
  expect PATCH "/api/records/$NOBODY" "$n" "$t" "patch denied for $n (unknown id)" '403 Forbidden' '' '{"followUpInDays":3}'
  expect GET "/api/patients/501/records" "$n" "$t" "timeline denied for $n" '403 Forbidden'
  expect GET "/api/patients/abc/records" "$n" "$t" "timeline denied for $n (non-numeric id)" '403 Forbidden'
done
expect POST "/api/consultations/$CMAIN/record" patient "$P501" 'create denied for the consultation patient' '403 Forbidden' '' "$FULL"
expect PATCH "/api/records/$NOBODY" patient "$P501" 'patch denied for a patient' '403 Forbidden' '' '{"followUpInDays":3}'
expect POST "/api/consultations/$CMAIN/record" patient-pending "$PPEND" 'create, patient token status pending' '403 Forbidden' '' "$FULL"
expect POST "/api/consultations/$CMAIN/record" doctor-pending "$DPEND" 'create, doctor token status pending' '403 Forbidden' '' "$FULL"
expect PATCH "/api/records/$NOBODY" doctor-pending "$DPEND" 'patch, doctor token status pending' '403 Forbidden' '' '{"followUpInDays":3}'
expect GET "/api/records/$NOBODY" doctor-pending "$DPEND" 'get, doctor token status pending' '403 Forbidden'
expect GET "/api/records/$NOBODY" patient-pending "$PPEND" 'get, patient token status pending' '403 Forbidden'
expect GET "/api/patients/501/records" patient-pending "$PPEND" 'timeline, patient token status pending' '403 Forbidden'
expect GET "/api/patients/501/records" doctor-pending "$DPEND" 'timeline, doctor token status pending' '403 Forbidden'
expect GET "/api/records/$NOBODY" admin-suspended "$ASUSP" 'get, admin token status suspended' '403 Forbidden'
expect POST "/api/consultations/$CMAIN/record" doctor-spoof "$D602" 'spoofed X-User-Id / X-Role are ignored (related doctor stays NotAssignedDoctor)' '403 NotAssignedDoctor' '' "$FULL" '' 'X-User-Id: 601'
check_value rbac 'denied calls created nothing and audited nothing' "0 0" "$(rec_n) $(audit_all)"

# ---- 3. Create: validation (400) before any database gate, on a completed consultation without a record ----
CV="$(comp 601 501)"
v400() { # v400 <name> <body> [assert]
  expect POST "/api/consultations/$CV/record" doctor "$D601" "create validation: $1" '400 ValidationFailed' "b.error.details.length>0${3:+&&$3}" "$2"
}
v400 empty-object '{}' 'b.error.details.some(d=>d.field==="chiefComplaint")'
v400 chiefComplaint-missing "{\"examinationNotes\":\"$NO\"}" 'b.error.details.some(d=>d.field==="chiefComplaint")'
v400 chiefComplaint-blank '{"chiefComplaint":"   "}'
v400 chiefComplaint-2-code-points '{"chiefComplaint":"ab"}'
v400 chiefComplaint-2001 "{\"chiefComplaint\":\"$(rep x 2001)\"}"
v400 chiefComplaint-NUL '{"chiefComplaint":"abc\u0000def"}'
v400 chiefComplaint-number '{"chiefComplaint":12345}'
v400 chiefComplaint-null '{"chiefComplaint":null}'
v400 examinationNotes-blank "{\"chiefComplaint\":\"$CH\",\"examinationNotes\":\"   \"}" 'b.error.details.some(d=>d.field==="examinationNotes")'
v400 examinationNotes-empty "{\"chiefComplaint\":\"$CH\",\"examinationNotes\":\"\"}"
v400 examinationNotes-10001 "{\"chiefComplaint\":\"$CH\",\"examinationNotes\":\"$(rep x 10001)\"}"
v400 examinationNotes-NUL "{\"chiefComplaint\":\"$CH\",\"examinationNotes\":\"a\\u0000b\"}"
v400 examinationNotes-null "{\"chiefComplaint\":\"$CH\",\"examinationNotes\":null}"
v400 diagnosisText-blank "{\"chiefComplaint\":\"$CH\",\"diagnosisText\":\" \"}"
v400 diagnosisText-2001 "{\"chiefComplaint\":\"$CH\",\"diagnosisText\":\"$(rep x 2001)\"}"
v400 treatmentPlan-blank "{\"chiefComplaint\":\"$CH\",\"treatmentPlan\":\"  \"}"
v400 treatmentPlan-10001 "{\"chiefComplaint\":\"$CH\",\"treatmentPlan\":\"$(rep x 10001)\"}"
for code in a00 A0 A00.12345 'A00.' 'A00 ' 'AA0' 'A000' '' 'Z99.9X9ZZ'; do
  v400 "diagnosisCode-[$code]" "{\"chiefComplaint\":\"$CH\",\"diagnosisCode\":\"$code\"}" 'b.error.details.some(d=>d.field==="diagnosisCode")'
done
v400 diagnosisCode-number "{\"chiefComplaint\":\"$CH\",\"diagnosisCode\":99}"
v400 diagnosisCode-null "{\"chiefComplaint\":\"$CH\",\"diagnosisCode\":null}"
for n in 0 -1 366 1.5 '"7"' null; do
  v400 "followUpInDays-$n" "{\"chiefComplaint\":\"$CH\",\"followUpInDays\":$n}" 'b.error.details.some(d=>d.field==="followUpInDays")'
done
v400 unknown-member-patientUserId "{\"chiefComplaint\":\"$CH\",\"patientUserId\":502}" 'b.error.details.some(d=>d.field==="patientUserId")'
v400 unknown-member-doctorUserId "{\"chiefComplaint\":\"$CH\",\"doctorUserId\":602}" 'b.error.details.some(d=>d.field==="doctorUserId")'
v400 unknown-member-consultationId "{\"chiefComplaint\":\"$CH\",\"consultationId\":1}"
v400 unknown-member-locked_at "{\"chiefComplaint\":\"$CH\",\"lockedAt\":\"2020-01-01T00:00:00Z\"}"
v400 unknown-member-attachments "{\"chiefComplaint\":\"$CH\",\"attachments\":[]}"
v400 array-body '[]'
v400 malformed-json '{"chiefComplaint":'
v400 non-object-json-string '"just a string"'
expect POST "/api/consultations/$CV/record" doctor "$D601" 'create validation: no body at all' '400 ValidationFailed' 'b.error.details.length>0'
expect POST "/api/consultations/$CV/record" doctor "$D601" 'create validation: body sent with Idempotency-Key still validated' '400 ValidationFailed' '' '{}' "$(uuid)"
check_value validation 'validation failures created no record and no audit row' "0 0" "$(rec_n) $(audit_all)"
expect POST "/api/consultations/abc/record" doctor "$D601" 'non-numeric consultation id with an invalid body: 404 beats 400' '404 NotFound' '' '{}'

# ---- 4. Create: gate failures ----
# every non-completed status for the assigned doctor (own hours, no overlap): 409 RecordRequiresCompleted
for s in booked waiting in_progress cancelled no_show; do
  X="$(fut 601 501 $s)"
  expect POST "/api/consultations/$X/record" doctor "$D601" "create on a $s consultation" '409 RecordRequiresCompleted' '' "$FULL"
done
check_value gate 'RecordRequiresCompleted created nothing' "0 0" "$(rec_n) $(audit_all)"
XB="$(fut 601 501 booked)"
expect POST "/api/consultations/$XB/record" doctor "$D602" 'related non-assigned doctor on a booked consultation: NotAssignedDoctor beats the status' '403 NotAssignedDoctor' '' "$FULL"
expect POST "/api/consultations/$CV/record" doctor-related "$D602" 'related non-assigned doctor on a completed consultation' '403 NotAssignedDoctor' '' "$FULL"
expect POST "/api/consultations/$CV/record" doctor-unrelated "$D604" 'unrelated doctor (no consultation with the patient)' '404 NotFound' '' "$FULL"
expect POST "/api/consultations/$CV/record" doctor-cancelled-only "$D606" 'doctor whose only rows with the patient are cancelled / no_show' '404 NotFound' '' "$FULL"
expect POST "/api/consultations/$NOBODY/record" doctor "$D601" 'unknown consultation' '404 NotFound' '' "$FULL"
for bad in abc 0 -1 1.5 99999999999999999999 '%20'; do
  expect POST "/api/consultations/$bad/record" doctor "$D601" "create with bad consultation id [$bad]" '404 NotFound' '' "$FULL"
done
expect POST "/api/consultations/$CV/record" patient-other "$P502" 'other patient' '403 Forbidden' '' "$FULL"
check_value gate 'failed gates created nothing' "0 0" "$(rec_n) $(audit_all)"

# ---- 5. Create: happy paths ----
CMIN="$(comp 601 501)"
expect POST "/api/consultations/$CMIN/record" doctor "$D601" 'create with the required member only: optional members are null' 201 "$REC_SHAPE&&b.data.consultationId===$CMIN&&b.data.patientUserId===501&&b.data.doctorUserId===601&&b.data.chiefComplaint==='$CH'&&b.data.examinationNotes===null&&b.data.diagnosisText===null&&b.data.diagnosisCode===null&&b.data.treatmentPlan===null&&b.data.followUpInDays===null&&b.data.isLocked===false&&b.data.amendments.length===0" "{\"chiefComplaint\":\"$CH\"}"
RMIN="$(js 'b.data.id')"
expect POST "/api/consultations/$CMAIN/record" doctor "$D601" 'create with every member (author = assigned doctor)' 201 "$REC_SHAPE&&b.data.consultationId===$CMAIN&&b.data.patientUserId===501&&b.data.doctorUserId===601&&b.data.examinationNotes==='$NO'&&b.data.diagnosisText==='$DX'&&b.data.diagnosisCode==='Z99.9'&&b.data.treatmentPlan==='$PL'&&b.data.followUpInDays===14&&b.data.isLocked===false" "$FULL"
RID1="$(js 'b.data.id')"; RIDC="$(cat "$TMP/rid")"
check_value db 'one live row per create; locked_at = created_at + 24 h exactly; ids copied from the consultation' "2 true 501 601" "$(sql "SELECT count(*) FROM medical_records") $(sql "SELECT (locked_at = created_at + interval '24 hours')::text FROM medical_records WHERE id=$RID1") $(sql "SELECT patient_user_id FROM medical_records WHERE id=$RID1") $(sql "SELECT doctor_user_id FROM medical_records WHERE id=$RID1")"
check_value audit 'one record.created row (actor doctor, entity medical_record, request id, flat metadata)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='record.created' AND entity_type='medical_record' AND entity_id=$RID1 AND actor_user_id=601 AND actor_role='doctor' AND request_id='$RIDC' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['consultationId','doctorUserId','patientUserId','providedFields']")"
check_value audit 'record.created metadata carries field names only, never a value' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='record.created' AND (metadata::text LIKE '%QA-REC-%' OR metadata::text LIKE '%Z99%')")"
expect POST "/api/consultations/$CMAIN/record" doctor "$D601" 'second create on the same consultation' '409 Conflict' '' "$FULL"
expect POST "/api/consultations/$CMAIN/record" doctor "$D601" 'second create replayed with an Idempotency-Key is still 409 (no replay)' '409 Conflict' '' "$FULL" "$(uuid)"
check_value db 'repeat creates left one row per consultation and one audit row' "2 1" "$(rec_n) $(audit_n record.created "$RID1")"
CBND="$(comp 601 502)"
expect POST "/api/consultations/$CBND/record" doctor "$D601" 'create at the upper bounds (2000 / 10000 / 2000 chars, code Z99.9AB2, 365 days)' 201 "$REC_SHAPE&&b.data.chiefComplaint.length===2000&&b.data.examinationNotes.length===10000&&b.data.treatmentPlan.length===10000&&b.data.diagnosisText.length===2000&&b.data.diagnosisCode==='Z99.9AB2'&&b.data.followUpInDays===365&&b.data.patientUserId===502" "{\"chiefComplaint\":\"$(rep c 2000)\",\"examinationNotes\":\"$(rep n 10000)\",\"diagnosisText\":\"$(rep d 2000)\",\"diagnosisCode\":\"Z99.9AB2\",\"treatmentPlan\":\"$(rep t 10000)\",\"followUpInDays\":365}"
CLOW="$(comp 601 502)"
expect POST "/api/consultations/$CLOW/record" doctor "$D601" 'create at the lower bounds (3 code points, 1 char, code Z99, 1 day, newline + unicode kept)' 201 "$REC_SHAPE&&b.data.chiefComplaint==='abc'&&b.data.examinationNotes==='a\nb \u00e9'&&b.data.diagnosisCode==='Z99'&&b.data.followUpInDays===1&&b.data.patientUserId===502" '{"chiefComplaint":"abc","examinationNotes":"a\nb \u00e9","diagnosisCode":"Z99","treatmentPlan":"t","diagnosisText":"d","followUpInDays":1}'
RLOW="$(js 'b.data.id')"
# a real lifecycle row: complete through the real route, then record
LC="$(mkrow 601 501 -7200 in_progress)"
expect PATCH "/api/consultations/$LC/complete" doctor "$D601" 'setup: complete an in_progress consultation through the real route' 200 "b.data.status==='completed'&&b.data.hasRecord===false"
expect POST "/api/consultations/$LC/record" doctor "$D601" 'create right after the real complete' 201 "$REC_SHAPE" "$FULL"

# ---- 6. Create: concurrency and the suspended author ----
pcall() { # pcall <name> <method> <path> <token> [body]: background call, status in $TMP/par_<name>
  local name="$1" method="$2" path="$3" token="$4" body="${5:-}"
  local args=(-sS -X "$method" -H "X-Request-Id: $(uuid)" -H "Authorization: Bearer $token" -o "$TMP/par_$name.body" -w '%{http_code}')
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  curl "${args[@]}" "$CARE_URL$path" > "$TMP/par_$name.status" || echo 000 > "$TMP/par_$name.status"
}
pstat() { cat "$TMP/par_$1.status"; }
pcode() { node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("-")}' "$TMP/par_$1.body"; }
flush_redis
CRACE="$(comp 601 502)"
pcall a POST "/api/consultations/$CRACE/record" "$D601" "$FULL" & pcall b POST "/api/consultations/$CRACE/record" "$D601" "$FULL" & pcall c POST "/api/consultations/$CRACE/record" "$D601" "$FULL" & wait
check_value concurrency 'three simultaneous creates for one consultation: exactly one 201 and two 409' '201 409 409 ' "$(printf '%s\n' "$(pstat a)" "$(pstat b)" "$(pstat c)" | sort | tr '\n' ' ')"
LOSER=$( [ "$(pstat a)" = 409 ] && pcode a || { [ "$(pstat b)" = 409 ] && pcode b || pcode c; } )
check_value concurrency 'the losers answer Conflict; one record row and one record.created row for the consultation' "Conflict 1 1" "$LOSER $(sql "SELECT count(*) FROM medical_records WHERE consultation_id=$CRACE") $(sql "SELECT count(*) FROM audit_logs a JOIN medical_records m ON m.id=a.entity_id WHERE a.created_at >= '$T0' AND a.action='record.created' AND m.consultation_id=$CRACE")"

# doctor 603 authors a record for patient 501 now; suspended later (section 11)
C603="$(comp 603 501)"; C603b="$(comp 603 501)"
expect POST "/api/consultations/$C603/record" doctor-603 "$D603" 'create by a not-yet-suspended doctor' 201 "$REC_SHAPE&&b.data.doctorUserId===603" "$FULL"
R603="$(js 'b.data.id')"

# ---- 7. GET /api/records/{id} ----
expect GET "/api/records/$RID1" patient "$P501" 'get by the owning patient' 200 "$REC_SHAPE&&b.data.id===$RID1&&b.data.chiefComplaint==='$CH'&&b.data.amendments.length===0&&b.data.isLocked===false"
RIDG="$(cat "$TMP/rid")"
check_value audit 'record.read audited before the response (actor patient, request id, flat metadata, viewerIsAuthor false)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='record.read' AND entity_type='medical_record' AND entity_id=$RID1 AND actor_user_id=501 AND actor_role='patient' AND request_id='$RIDG' AND metadata->>'viewerRole'='patient' AND metadata->>'viewerIsAuthor'='false' AND (metadata->>'amendmentCount')::int=0 AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['amendmentCount','consultationId','patientUserId','viewerIsAuthor','viewerRole']")"
expect GET "/api/records/$RID1" doctor "$D601" 'get by the author doctor' 200 "$REC_SHAPE&&b.data.doctorUserId===601"
check_value audit 'author read audited with viewerIsAuthor true' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='record.read' AND entity_id=$RID1 AND actor_user_id=601 AND metadata->>'viewerIsAuthor'='true'")"
expect GET "/api/records/$RID1" doctor-related "$D602" 'get by a doctor with a booked relationship to the patient' 200 "$REC_SHAPE&&b.data.id===$RID1"
expect GET "/api/records/$RID1" patient-other "$P502" 'get by another patient' '404 NotFound'
expect GET "/api/records/$RID1" doctor-unrelated "$D604" 'get by an unrelated doctor' '404 NotFound'
expect GET "/api/records/$RID1" doctor-cancelled-only "$D606" 'get by a doctor whose rows with the patient are cancelled / no_show only' '404 NotFound'
expect GET "/api/records/$RID1" admin "$ADMIN" 'get by an admin (existing id)' '403 Forbidden'
expect GET "/api/records/$NOBODY" patient "$P501" 'get unknown id' '404 NotFound'
expect GET "/api/records/$NOBODY" doctor "$D601" 'get unknown id (doctor)' '404 NotFound'
for bad in abc 0 -1 1.5 99999999999999999999; do
  expect GET "/api/records/$bad" patient "$P501" "get with bad id [$bad]" '404 NotFound'
  expect PATCH "/api/records/$bad" doctor "$D601" "patch with bad id [$bad]" '404 NotFound' '' '{"followUpInDays":3}'
done
expect GET "/api/records/$RID1?foo=bar" patient "$P501" 'get with an unknown query member' '400 ValidationFailed' 'b.error.details.length>0'
expect GET "/api/records/$RID1?limit=5" doctor "$D601" 'get with a pagination query member' '400 ValidationFailed'
expect GET "/api/records/$RID1" patient "$P501" 'get ignores an Idempotency-Key' 200 "b.data.id===$RID1" '' "$(uuid)"
expect GET "/api/records/$RID1" patient-other "$P502" 'spoofed X-User-Id / X-Role do not widen access' '404 NotFound' '' '' '' 'X-User-Id: 501'
check_value audit 'rejected reads (404 / 403 / 400) wrote no record.read row: only the 4 successful reads are audited' 4 "$(audit_n record.read)"
check_value audit 'records created so far: no patient_profile.read or listed row from get-one' 0 "$(audit_n patient_records.listed)"

# ---- 8. PATCH before the lock ----
BASE_HASH="$(rowhash "$RID1")"
pv() { expect PATCH "/api/records/$RID1" doctor "$D601" "patch validation: $1" '400 ValidationFailed' "b.error.details.length>0${3:+&&$3}" "$2"; }
pv reason-only '{"reason":"correcting the entry"}' 'b.error.details.some(d=>d.field==="body")'
pv empty-object '{}' 'b.error.details.some(d=>d.field==="body")'
pv diagnosisText-null '{"diagnosisText":null}'
pv chiefComplaint-null '{"chiefComplaint":null}'
pv unknown-member-patientUserId '{"patientUserId":502}' 'b.error.details.some(d=>d.field==="patientUserId")'
pv unknown-member-doctorUserId '{"doctorUserId":602}'
pv unknown-member-lockedAt '{"lockedAt":"2020-01-01T00:00:00Z","followUpInDays":3}'
pv unknown-member-isLocked '{"isLocked":false,"followUpInDays":3}'
pv chiefComplaint-2-code-points '{"chiefComplaint":"ab"}'
pv chiefComplaint-blank '{"chiefComplaint":"   "}'
pv chiefComplaint-NUL '{"chiefComplaint":"abc\u0000def"}'
pv treatmentPlan-blank '{"treatmentPlan":" "}'
pv examinationNotes-10001 "{\"examinationNotes\":\"$(rep x 10001)\"}"
pv diagnosisCode-lowercase '{"diagnosisCode":"a00"}'
pv diagnosisCode-A00.12345 '{"diagnosisCode":"A00.12345"}'
pv followUpInDays-0 '{"followUpInDays":0}'
pv followUpInDays-366 '{"followUpInDays":366}'
pv followUpInDays-float '{"followUpInDays":2.5}'
pv followUpInDays-string '{"followUpInDays":"3"}'
pv reason-2-chars '{"followUpInDays":3,"reason":"ab"}' 'b.error.details.some(d=>d.field==="reason")'
pv reason-blank '{"followUpInDays":3,"reason":"   "}'
pv reason-1001 "{\"followUpInDays\":3,\"reason\":\"$(rep r 1001)\"}"
pv reason-NUL '{"followUpInDays":3,"reason":"abc\u0000def"}'
pv reason-null '{"followUpInDays":3,"reason":null}'
pv malformed-json '{"followUpInDays":'
expect PATCH "/api/records/$RID1" doctor "$D601" 'patch validation: no body' '400 ValidationFailed' 'b.error.details.length>0'
check_value patch 'validation failures changed nothing and audited nothing' "$BASE_HASH 0" "$(rowhash "$RID1") $(audit_n record.updated)"

UPD0="$(sql "SELECT updated_at FROM medical_records WHERE id=$RID1")"
expect PATCH "/api/records/$RID1" doctor "$D601" 'pre-lock no-op: values equal to the stored ones' 200 "$REC_SHAPE&&b.data.chiefComplaint==='$CH'&&b.data.followUpInDays===14&&b.data.isLocked===false&&b.data.amendments.length===0" "{\"chiefComplaint\":\"$CH\",\"followUpInDays\":14,\"diagnosisCode\":\"Z99.9\"}"
expect PATCH "/api/records/$RID1" doctor "$D601" 'pre-lock no-op with a reason (ignored)' 200 "b.data.id===$RID1&&b.data.amendments.length===0" "{\"chiefComplaint\":\"$CH\",\"reason\":\"$RS\"}"
check_value patch 'no-op wrote nothing: row byte-identical, updated_at unchanged, zero record.updated rows' "$BASE_HASH $UPD0 0" "$(rowhash "$RID1") $(sql "SELECT updated_at FROM medical_records WHERE id=$RID1") $(audit_n record.updated)"
PL2='QA-REC-PLAN-6604-B'
expect PATCH "/api/records/$RID1" doctor "$D601" 'pre-lock change of one field updates in place' 200 "$REC_SHAPE&&b.data.treatmentPlan==='$PL2'&&b.data.chiefComplaint==='$CH'&&b.data.id===$RID1&&b.data.amendments.length===0&&Date.parse(b.data.updatedAt)>Date.parse(b.data.createdAt)" "{\"treatmentPlan\":\"$PL2\"}"
RIDU="$(cat "$TMP/rid")"
check_value audit 'one record.updated row (actor doctor, request id, changedFields names only)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='record.updated' AND entity_type='medical_record' AND entity_id=$RID1 AND actor_user_id=601 AND request_id='$RIDU' AND metadata->>'changedFields'='treatmentPlan' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['changedFields','consultationId','patientUserId']")"
check_value db 'in-place update kept created_at / locked_at and wrote no amendment' "true 0" "$(sql "SELECT (locked_at = created_at + interval '24 hours')::text FROM medical_records WHERE id=$RID1") $(amd_n "$RID1")"
expect PATCH "/api/records/$RID1" doctor "$D601" 'pre-lock mixed body: one equal field, one changed field, reason ignored' 200 "b.data.diagnosisCode==='A01.1'&&b.data.followUpInDays===14&&b.data.amendments.length===0" "{\"followUpInDays\":14,\"diagnosisCode\":\"A01.1\",\"reason\":\"$RS\"}"
check_value audit 'mixed patch audited only the changed field name; the reason is nowhere in audit metadata' "diagnosisCode 0" "$(sql "SELECT metadata->>'changedFields' FROM audit_logs WHERE created_at >= '$T0' AND action='record.updated' AND entity_id=$RID1 ORDER BY id DESC LIMIT 1") $(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND metadata::text LIKE '%QA-REC-%'")"
expect PATCH "/api/records/$RID1" doctor "$D601" 'pre-lock multi-field change' 200 "b.data.chiefComplaint==='$CH-2'&&b.data.examinationNotes==='$NO-2'&&b.data.followUpInDays===30" "{\"chiefComplaint\":\"$CH-2\",\"examinationNotes\":\"$NO-2\",\"followUpInDays\":30}"
check_value audit 'multi-field change audited as comma-joined names' "chiefComplaint,examinationNotes,followUpInDays" "$(sql "SELECT metadata->>'changedFields' FROM audit_logs WHERE created_at >= '$T0' AND action='record.updated' AND entity_id=$RID1 ORDER BY id DESC LIMIT 1" | tr -d ' ' | node -e 'process.stdout.write(require("fs").readFileSync(0,"utf8").split(",").sort().join(","))')"
expect PATCH "/api/records/$RID1" doctor "$D601" 'patch ignores an Idempotency-Key (same key, different body: no 422)' 200 "b.data.followUpInDays===31" '{"followUpInDays":31}' "11111111-1111-4111-8111-111111111111"
expect PATCH "/api/records/$RID1" doctor "$D601" 'patch with the same Idempotency-Key and another body is processed again' 200 "b.data.followUpInDays===32" '{"followUpInDays":32}' "11111111-1111-4111-8111-111111111111"
# RBAC on PATCH (pre-lock)
expect PATCH "/api/records/$RID1" doctor-related "$D602" 'patch by a related non-author doctor' '403 NotAssignedDoctor' '' '{"followUpInDays":5}'
expect PATCH "/api/records/$RID1" doctor-unrelated "$D604" 'patch by an unrelated doctor' '404 NotFound' '' '{"followUpInDays":5}'
expect PATCH "/api/records/$RID1" doctor-cancelled-only "$D606" 'patch by a doctor with cancelled / no_show rows only' '404 NotFound' '' '{"followUpInDays":5}'
expect PATCH "/api/records/$RID1" patient "$P501" 'patch by the owning patient' '403 Forbidden' '' '{"followUpInDays":5}'
expect PATCH "/api/records/$RID1" admin "$ADMIN" 'patch by an admin' '403 Forbidden' '' '{"followUpInDays":5}'
expect PATCH "/api/records/$NOBODY" doctor "$D601" 'patch on an unknown record' '404 NotFound' '' '{"followUpInDays":5}'
expect PATCH "/api/records/$RID1" doctor "$D601" 'patch of the author after the checks: row still the last accepted value' 200 "b.data.followUpInDays===32" '{"followUpInDays":32}'

# ---- 9. PATCH at the lock boundary (database time) and amendments ----
lock_in "$RMIN" 8
expect PATCH "/api/records/$RMIN" doctor "$D601" 'about 8 s before the lock: still an in-place update' 200 "b.data.isLocked===false&&b.data.treatmentPlan==='$PL'&&b.data.amendments.length===0" "{\"treatmentPlan\":\"$PL\"}"
check_value db 'before the lock: no amendment row, audit says updated' "0 1" "$(amd_n "$RMIN") $(audit_n record.updated "$RMIN")"
lock_in "$RMIN" -2
BEFORE_HASH="$(rowhash "$RMIN")"
expect PATCH "/api/records/$RMIN" doctor "$D601" 'about 2 s after the lock without a reason' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="reason")' "{\"treatmentPlan\":\"$PL-X\"}"
expect PATCH "/api/records/$RMIN" doctor "$D601" 'after the lock: reason-only body' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="body")' "{\"reason\":\"$RS\"}"
expect PATCH "/api/records/$RMIN" doctor "$D601" 'after the lock: JSON null member (cannot clear a field)' '400 ValidationFailed' '' "{\"treatmentPlan\":null,\"reason\":\"$RS\"}"
expect PATCH "/api/records/$RMIN" doctor "$D601" 'after the lock: reason shorter than 3' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="reason")' '{"treatmentPlan":"abc","reason":"ab"}'
check_value amend 'rejected amendments changed nothing' "$BEFORE_HASH 0 0" "$(rowhash "$RMIN") $(amd_n "$RMIN") $(audit_n record.amended "$RMIN")"
AKEYS='Object.keys(b.data).sort().join()==="authorUserId,chiefComplaint,createdAt,diagnosisCode,diagnosisText,examinationNotes,followUpInDays,id,reason,recordId,treatmentPlan"&&b.data.authorUserId===601'
expect PATCH "/api/records/$RMIN" doctor "$D601" 'after the lock with a reason: an amendment is appended' 201 "$AKEYS&&b.data.recordId===$RMIN&&b.data.treatmentPlan==='$PL-X'&&b.data.chiefComplaint===null&&b.data.examinationNotes===null&&b.data.diagnosisText===null&&b.data.diagnosisCode===null&&b.data.followUpInDays===null&&b.data.reason==='$RS'" "{\"treatmentPlan\":\"$PL-X\",\"reason\":\"$RS\"}"
AM1="$(js 'b.data.id')"; RIDA="$(cat "$TMP/rid")"
check_value amend 'the original row is byte-identical after the amendment; one amendment row' "$BEFORE_HASH 1" "$(rowhash "$RMIN") $(amd_n "$RMIN")"
check_value audit 'one record.amended row (amendmentId, reasonLength, changedFields; never the reason text)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='record.amended' AND entity_type='medical_record' AND entity_id=$RMIN AND actor_user_id=601 AND request_id='$RIDA' AND (metadata->>'amendmentId')::int=$AM1 AND (metadata->>'reasonLength')::int=${#RS} AND metadata->>'changedFields'='treatmentPlan' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['amendmentId','changedFields','consultationId','patientUserId','reasonLength']")"
expect PATCH "/api/records/$RMIN" doctor "$D601" 'after the lock a value equal to the original still appends (no diff)' 201 "$AKEYS&&b.data.id>$AM1&&b.data.treatmentPlan==='$PL'" "{\"treatmentPlan\":\"$PL\",\"reason\":\"re-stating the plan\"}"
expect PATCH "/api/records/$RMIN" doctor "$D601" 'after the lock a multi-field amendment' 201 "$AKEYS&&b.data.diagnosisCode==='B01.1'&&b.data.followUpInDays===7&&b.data.treatmentPlan===null" '{"diagnosisCode":"B01.1","followUpInDays":7,"reason":"coding fix"}'
expect GET "/api/records/$RMIN" patient "$P501" 'get after amendments: original untouched, amendments oldest first, patient sees the reason' 200 "$REC_SHAPE&&b.data.isLocked===true&&b.data.treatmentPlan==='$PL'&&b.data.diagnosisCode===null&&b.data.amendments.length===3&&b.data.amendments.map(a=>a.id).join()===[...b.data.amendments.map(a=>a.id)].sort((x,y)=>x-y).join()&&b.data.amendments[0].id===$AM1&&b.data.amendments[0].reason==='$RS'&&b.data.amendments[2].diagnosisCode==='B01.1'&&b.data.amendments.every(a=>a.recordId===$RMIN&&a.authorUserId===601)"
check_value audit 'record.read for the amended record reports amendmentCount 3' 3 "$(sql "SELECT (metadata->>'amendmentCount')::int FROM audit_logs WHERE created_at >= '$T0' AND action='record.read' AND entity_id=$RMIN ORDER BY id DESC LIMIT 1")"
expect GET "/api/records/$RMIN" doctor-related "$D602" 'a related doctor also sees the amendments' 200 'b.data.amendments.length===3'
expect PATCH "/api/records/$RMIN" doctor-related "$D602" 'locked record: related non-author doctor' '403 NotAssignedDoctor' '' "{\"treatmentPlan\":\"x\",\"reason\":\"$RS\"}"
expect PATCH "/api/records/$RMIN" patient "$P501" 'locked record: patient' '403 Forbidden' '' "{\"treatmentPlan\":\"x\",\"reason\":\"$RS\"}"
expect PATCH "/api/records/$RMIN" admin "$ADMIN" 'locked record: admin' '403 Forbidden' '' "{\"treatmentPlan\":\"x\",\"reason\":\"$RS\"}"
expect PATCH "/api/records/$RMIN" doctor-unrelated "$D604" 'locked record: unrelated doctor' '404 NotFound' '' "{\"treatmentPlan\":\"x\",\"reason\":\"$RS\"}"
check_value amend 'those denials appended nothing' "3 3" "$(amd_n "$RMIN") $(audit_n record.amended "$RMIN")"
# the lock instant from the other side: a record whose lock passed seconds ago, first touched after it
lock_in "$RID1" 5
expect PATCH "/api/records/$RID1" doctor "$D601" 'full record, about 5 s before the lock: in place' 200 'b.data.isLocked===false&&b.data.followUpInDays===33' '{"followUpInDays":33}'
lock_in "$RID1" -3
expect PATCH "/api/records/$RID1" doctor "$D601" 'full record, about 3 s after the lock: amendment' 201 "$AKEYS&&b.data.followUpInDays===34" '{"followUpInDays":34,"reason":"after the lock"}'
# direct database guarantees (care_app login)
if [ -n "${CARE_APP_DATABASE_URL:-}" ]; then
  check_value db 'care_app UPDATE of a locked record is refused by the trigger' 1 "$(asapp "UPDATE medical_records SET follow_up_in_days=9 WHERE id=$RID1" | grep -c 'is locked')"
  check_value db 'care_app soft delete of a locked record is refused by the trigger' 1 "$(asapp "UPDATE medical_records SET deleted_at=now() WHERE id=$RID1" | grep -c 'is locked')"
  check_value db 'the owner is refused too (the trigger fires for every role)' 1 "$(psql "$CARE_OWNER_DATABASE_URL" -XAt -c "UPDATE medical_records SET follow_up_in_days=9 WHERE id=$RID1" 2>&1 | grep -c 'is locked')"
  check_value db 'care_app has no DELETE on medical_records' 1 "$(asapp "DELETE FROM medical_records WHERE id=$RID1" | grep -c 'permission denied')"
  check_value db 'care_app has no UPDATE on amendments' 1 "$(asapp "UPDATE medical_record_amendments SET reason='xxx' WHERE medical_record_id=$RID1" | grep -c 'permission denied')"
  check_value db 'care_app has no DELETE on amendments' 1 "$(asapp "DELETE FROM medical_record_amendments WHERE medical_record_id=$RID1" | grep -c 'permission denied')"
  check_value db 'care_app cannot set an amendment id / created_at' 1 "$(asapp "INSERT INTO medical_record_amendments (id, medical_record_id, author_user_id, treatment_plan, reason) VALUES (999999, $RID1, 601, 'x', 'abc')" | grep -c 'permission denied')"
  check_value db 'an empty amendment is refused by chk_medical_record_amendments_nonempty' 1 "$(asapp "INSERT INTO medical_record_amendments (medical_record_id, author_user_id, reason) VALUES ($RID1, 601, 'abc')" | grep -c 'chk_medical_record_amendments_nonempty')"
  check_value db 'a record whose locked_at is not created_at + 24 h is refused by chk_medical_records_lock' 1 "$(psql "$CARE_OWNER_DATABASE_URL" -XAt -c "INSERT INTO medical_records (consultation_id,patient_user_id,doctor_user_id,chief_complaint,locked_at) VALUES ($CV,501,601,'abc',now())" 2>&1 | grep -c 'chk_medical_records_lock')"
else
  skip_note 'direct care_app grant / trigger checks skipped: CARE_APP_DATABASE_URL not set'
fi
check_value db 'the RecordLocked (trigger-only) 409 path is not reachable over HTTP: no PATCH answered 409' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE action='record.locked'")"

# ---- 10. Patient timeline ----
# extra records for paging: patient 501 gets records from three doctors and several creation times; 503 (no profile) two rows with the SAME created_at
CT1="$(comp 601 501)"; CT2="$(comp 601 501)"
curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
expect POST "/api/consultations/$CT1/record" doctor "$D601" 'timeline fixture record 1' 201 '' "{\"chiefComplaint\":\"$CH-t1\"}"
expect POST "/api/consultations/$CT2/record" doctor "$D601" 'timeline fixture record 2' 201 '' "{\"chiefComplaint\":\"$CH-t2\"}"
N501="$(sql "SELECT count(*) FROM medical_records WHERE patient_user_id=501")"
EXPECT_ORDER="$(sql "SELECT string_agg(id::text, ',' ORDER BY created_at DESC, id DESC) FROM medical_records WHERE patient_user_id=501")"
A0="$(audit_n patient_records.listed)"
expect GET /api/patients/501/records patient "$P501" 'timeline by the patient themself: newest first, patient profile, meta' 200 "Object.keys(b.data).sort().join()==='patient,records'&&b.data.patient.userId===501&&b.data.patient.allergies.includes('$AL')&&b.data.records.map(r=>r.id).join()==='$EXPECT_ORDER'&&b.data.records.length===$N501&&b.meta.count===$N501&&b.meta.hasMore===false&&b.meta.nextCursor===null&&b.data.records.every(r=>r.attachments.length===0&&r.patientUserId===501)&&b.data.records.find(r=>r.id===$RMIN).amendments.length===3&&b.data.records.find(r=>r.id===$RID1).amendments.length===1&&b.data.records.find(r=>r.id===$RMIN).isLocked===true"
RIDT="$(cat "$TMP/rid")"
check_value audit 'exactly one patient_records.listed row (entity patient_records / patient id, request id, flat metadata, no record ids)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_records.listed' AND entity_type='patient_records' AND entity_id=501 AND actor_user_id=501 AND actor_role='patient' AND request_id='$RIDT' AND (metadata->>'recordCount')::int=$N501 AND metadata->>'firstPage'='true' AND metadata->>'hasMore'='false' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['firstPage','hasMore','patientUserId','recordCount','viewerRole']")"
check_value audit 'no patient_profile.read row from the timeline' 0 "$(audit_n patient_profile.read)"
check_value case2 'the timeline made no Identity call (ids only, no hydration)' "0 0" "$(fake 'c.batchCount+" "+c.patchCount')"
# paging, limit 2
PAGED=''; CUR=''; PAGES=0
while :; do
  q='?limit=2'; [ -z "$CUR" ] || q="$q&cursor=$CUR"
  s="$(call GET "/api/patients/501/records$q" "$P501")"; PAGES=$((PAGES+1))
  [ "$s" = 200 ] || { echo "paging failed: $s" >&2; break; }
  PAGED="$PAGED$( [ -n "$PAGED" ] && echo , )$(js 'b.data.records.map(r=>r.id).join()')"
  CUR="$(js 'b.meta.nextCursor||""')"
  [ -n "$CUR" ] || break
  [ "$PAGES" -lt 30 ] || break
done
check_value timeline 'keyset paging (limit 2) walks every record once in (created_at, id) descending order' "$EXPECT_ORDER" "$PAGED"
check_value timeline 'page count for limit 2' "$(( (N501 + 1) / 2 ))" "$PAGES"
expect GET '/api/patients/501/records?limit=2' patient "$P501" 'page 1: hasMore true, nextCursor set, count 2, patient present' 200 'b.meta.hasMore===true&&typeof b.meta.nextCursor==="string"&&b.meta.count===2&&b.data.records.length===2&&b.data.patient.userId===501'
C1TOK="$(js 'b.meta.nextCursor')"; export QA_P1PAT="$(js 'JSON.stringify(b.data.patient)')"
expect GET "/api/patients/501/records?limit=2&cursor=$C1TOK" patient "$P501" 'page 2: patient repeated identically, continuation records only' 200 "b.meta.count>=1&&JSON.stringify(b.data.patient)===process.env.QA_P1PAT&&b.data.records.every(r=>!'$EXPECT_ORDER'.split(',').slice(0,2).includes(String(r.id)))"
expect GET '/api/patients/501/records?limit=1' patient "$P501" 'limit 1' 200 'b.data.records.length===1&&b.meta.hasMore===true'
expect GET '/api/patients/501/records?limit=100' patient "$P501" 'limit 100' 200 "b.meta.hasMore===false&&b.meta.count===$N501"
expect GET '/api/patients/501/records?limit=0' patient "$P501" 'limit 0' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="limit")'
expect GET '/api/patients/501/records?limit=101' patient "$P501" 'limit 101' '400 ValidationFailed'
expect GET '/api/patients/501/records?limit=abc' patient "$P501" 'limit not a number' '400 ValidationFailed'
expect GET '/api/patients/501/records?limit=1.5' patient "$P501" 'limit fractional' '400 ValidationFailed'
expect GET '/api/patients/501/records?limit=-1' patient "$P501" 'limit negative' '400 ValidationFailed'
expect GET '/api/patients/501/records?cursor=not-a-cursor' patient "$P501" 'malformed cursor' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="cursor")'
expect GET '/api/patients/501/records?cursor=' patient "$P501" 'empty cursor' '400 ValidationFailed'
expect GET "/api/patients/501/records?cursor=$(rep A 1100)" patient "$P501" 'cursor longer than 1024' '400 ValidationFailed'
expect GET '/api/patients/501/records?foo=bar' patient "$P501" 'unknown query member' '400 ValidationFailed'
expect GET '/api/patients/501/records' doctor "$D601" 'timeline by the author doctor' 200 "b.data.records.length===$N501&&b.data.patient.userId===501&&b.data.patient.allergies.includes('$AL')"
expect GET '/api/patients/501/records' doctor-related "$D602" 'timeline by a doctor with a booked-only relationship sees all doctors records' 200 "b.data.records.length===$N501&&b.data.records.some(r=>r.doctorUserId===603)"
expect GET '/api/patients/501/records' doctor-unrelated "$D604" 'timeline by an unrelated doctor' '404 NotFound'
expect GET '/api/patients/501/records' doctor-cancelled-only "$D606" 'timeline by a doctor with cancelled / no_show rows only' '404 NotFound'
expect GET '/api/patients/501/records' patient-other "$P502" 'timeline of another patient' '404 NotFound'
expect GET '/api/patients/me/records' patient "$P501" 'timeline path /patients/me/records' '404 NotFound'
expect GET '/api/patients/abc/records' patient "$P501" 'timeline with a non-numeric patient id' '404 NotFound'
expect GET '/api/patients/0/records' doctor "$D601" 'timeline of patient id 0' '404 NotFound'
expect GET '/api/patients/-5/records' doctor "$D601" 'timeline of a negative id' '404 NotFound'
expect GET '/api/patients/501/records' admin "$ADMIN" 'timeline by an admin' '403 Forbidden'
# patient without a profile row: records exist, patient is null; two rows sharing one created_at order by id descending
C503a="$(comp 601 503)"; C503b="$(comp 601 503)"
sql "INSERT INTO medical_records (consultation_id,patient_user_id,doctor_user_id,chief_complaint,created_at,updated_at,locked_at)
     SELECT c, 503, 601, 'QA-REC-CHIEF-6601 tie', ts, ts, ts + interval '24 hours' FROM (VALUES ($C503a, now() - interval '2 hours'), ($C503b, now() - interval '2 hours')) v(c, ts)" >/dev/null
TIE="$(sql "SELECT string_agg(id::text, ',' ORDER BY id DESC) FROM medical_records WHERE patient_user_id=503")"
expect GET '/api/patients/503/records' patient "$P503" 'patient without a profile row: patient is null, records present, tie broken by id descending' 200 "b.data.patient===null&&b.data.records.map(r=>r.id).join()==='$TIE'&&b.meta.count===2"
expect GET '/api/patients/503/records?limit=1' doctor "$D601" 'tie across a page boundary: page 1 holds the higher id' 200 "b.data.patient===null&&b.data.records.length===1&&b.data.records[0].id===${TIE%%,*}&&b.meta.hasMore===true"
T1TOK="$(js 'b.meta.nextCursor')"
expect GET "/api/patients/503/records?limit=1&cursor=$T1TOK" doctor "$D601" 'tie across a page boundary: page 2 holds the lower id, last page' 200 "b.data.records.length===1&&b.data.records[0].id===${TIE##*,}&&b.meta.hasMore===false&&b.meta.nextCursor===null"
# an empty timeline is still audited
expect GET '/api/patients/502/records' patient-other "$P502" 'timeline of a patient without a profile row, records from the fixtures' 200 'Array.isArray(b.data.records)&&b.data.records.every(r=>r.patientUserId===502)'
ZP="$(pt 507)"
expect GET '/api/patients/507/records' patient-507 "$ZP" 'an empty timeline: 200, patient null, records [], still audited' 200 'b.data.patient===null&&b.data.records.length===0&&b.meta.count===0&&b.meta.hasMore===false&&b.meta.nextCursor===null'
check_value audit 'the empty page wrote one patient_records.listed row with recordCount 0' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_records.listed' AND entity_id=507 AND (metadata->>'recordCount')::int=0")"

# ---- 11. Locally suspended doctor (token says active; Care's suspended_at wins) ----
sql "UPDATE doctor_profiles SET suspended_at=now(), suspension_reason='synthetic' WHERE user_id=603" >/dev/null
expect POST "/api/consultations/$C603b/record" doctor-suspended "$D603" 'create by a locally suspended doctor' '403 Forbidden' '' "$FULL"
expect PATCH "/api/records/$R603" doctor-suspended "$D603" 'patch of own record by a locally suspended doctor' '403 Forbidden' '' '{"followUpInDays":3}'
expect GET "/api/records/$R603" doctor-suspended "$D603" 'get of an authored record by a locally suspended doctor' '404 NotFound'
expect GET "/api/records/$RID1" doctor-suspended "$D603" 'get of another doctors record by a locally suspended doctor' '404 NotFound'
expect GET '/api/patients/501/records' doctor-suspended "$D603" 'timeline by a locally suspended doctor' '404 NotFound'
expect GET "/api/records/$R603" patient "$P501" 'the patient still reads the suspended doctors record' 200 "b.data.doctorUserId===603&&b.data.id===$R603"
expect GET "/api/records/$R603" doctor-related "$D602" 'a consulted doctor still reads the suspended doctors record' 200 "b.data.id===$R603"
expect GET "/api/records/$R603" doctor "$D601" 'the assigned doctor of the patient reads it too' 200 "b.data.id===$R603"
check_value suspended 'suspended-doctor calls created nothing' "0" "$(sql "SELECT count(*) FROM medical_records WHERE consultation_id=$C603b")"
sql "UPDATE doctor_profiles SET suspended_at=NULL, suspension_reason=NULL WHERE user_id=603" >/dev/null

# ---- 12. hasRecord on the consultation routes ----
expect GET "/api/consultations/$CMAIN" patient "$P501" 'get-one: hasRecord true after create' 200 'b.data.hasRecord===true&&!("chiefComplaint" in b.data)&&!JSON.stringify(b).includes("QA-REC-")'
expect GET "/api/consultations/$XB" patient "$P501" 'get-one: hasRecord false for a booked consultation' 200 'b.data.hasRecord===false'
expect GET "/api/consultations/$CV" doctor "$D601" 'get-one: hasRecord false for a completed consultation without a record' 200 'b.data.hasRecord===false'
expect GET "/api/consultations/$CMAIN" admin "$ADMIN" 'get-one by an admin: hasRecord true, no clinical field' 200 'b.data.hasRecord===true&&!JSON.stringify(b).includes("QA-REC-")'
expect GET '/api/consultations?limit=100&scope=all' patient "$P501" 'list (scope=all): hasRecord true exactly for the consultations with a record' 200 "b.data.every(x=>x.hasRecord===($(sql "SELECT '[' || string_agg(consultation_id::text, ',') || ']' FROM medical_records WHERE patient_user_id=501")).includes(x.id))&&b.data.some(x=>x.hasRecord===true)&&b.data.some(x=>x.hasRecord===false)"
expect GET '/api/consultations?limit=100&scope=past&status=completed' doctor "$D601" 'doctor list (scope=past, completed): hasRecord matches the record table' 200 "b.data.length>0&&b.data.every(x=>x.status==='completed'&&x.hasRecord===($(sql "SELECT '[' || string_agg(consultation_id::text, ',') || ']' FROM medical_records WHERE doctor_user_id=601")).includes(x.id))&&b.data.some(x=>x.hasRecord===true)&&b.data.some(x=>x.hasRecord===false)"
expect GET "/api/consultations/calendar?from=$(isoz -259200)&to=$(isoz 0)" doctor "$D601" 'doctor calendar: hasRecord true on a recorded completed row, false on an unrecorded one' 200 "b.data.consultations.find(x=>x.id===$CMAIN).hasRecord===true&&b.data.consultations.find(x=>x.id===$CV).hasRecord===false"

# ---- 13. Follow-up booking with followUpOfRecordId ----
TYPE601="$(tid 601)"; TYPE602="$(tid 602)"
fbody() { printf '{"doctorId":%s,"typeId":%s,"startsAt":"%s","complaintText":"synthetic follow-up","patientTimezone":"Africa/Cairo"%s}' "$1" "$2" "$3" "${4:-}"; }
S1="$(slot 10 10:00)"; S2="$(slot 10 11:00)"; S3="$(slot 10 12:00)"; S4="$(slot 10 13:00)"; S5="$(slot 10 14:00)"
FK1="$(uuid)"
expect POST /api/consultations patient "$P501" 'book with followUpOfRecordId = own record with the same doctor' 201 "b.data.followUpOfRecordId===$RID1&&b.data.status==='booked'&&b.data.hasRecord===false&&b.data.doctor.userId===601" "$(fbody 601 "$TYPE601" "$S1" ",\"followUpOfRecordId\":$RID1")" "$FK1"
FUC="$(js 'b.data.id')"
check_value db 'the link is stored on the consultation row' "$RID1" "$(sql "SELECT follow_up_of_record_id FROM consultations WHERE id=$FUC")"
expect POST /api/consultations patient "$P501" 'replay with the same key and body returns the stored consultation' 201 "b.data.id===$FUC&&b.data.followUpOfRecordId===$RID1" "$(fbody 601 "$TYPE601" "$S1" ",\"followUpOfRecordId\":$RID1")" "$FK1"
expect POST /api/consultations patient "$P501" 'same key with a different followUpOfRecordId' '422 IdempotencyConflict' '' "$(fbody 601 "$TYPE601" "$S1" ",\"followUpOfRecordId\":$RMIN")" "$FK1"
expect POST /api/consultations patient "$P501" 'book without followUpOfRecordId stays null' 201 'b.data.followUpOfRecordId===null' "$(fbody 601 "$TYPE601" "$S2")" "$(uuid)"
N0="$(sql 'select count(*) from consultations')"
expect POST /api/consultations patient "$P502" 'book with another patients record' '404 NotFound' '' "$(fbody 601 "$TYPE601" "$S3" ",\"followUpOfRecordId\":$RID1")" "$(uuid)"
expect POST /api/consultations patient "$P501" 'book with a record of another doctor (record is doctor 601, booking doctor 602)' '404 NotFound' '' "$(fbody 602 "$TYPE602" "$S3" ",\"followUpOfRecordId\":$RID1")" "$(uuid)"
expect POST /api/consultations patient "$P501" 'book with an unknown record id' '404 NotFound' '' "$(fbody 601 "$TYPE601" "$S3" ",\"followUpOfRecordId\":$NOBODY")" "$(uuid)"
expect POST /api/consultations patient "$P501" 'book with followUpOfRecordId 0' '400 ValidationFailed' 'b.error.details.length>0' "$(fbody 601 "$TYPE601" "$S3" ',"followUpOfRecordId":0')" "$(uuid)"
expect POST /api/consultations patient "$P501" 'book with followUpOfRecordId as a string' '400 ValidationFailed' '' "$(fbody 601 "$TYPE601" "$S3" ',"followUpOfRecordId":"1"')" "$(uuid)"
expect POST /api/consultations patient "$P501" 'book with followUpOfRecordId null' '400 ValidationFailed' '' "$(fbody 601 "$TYPE601" "$S3" ',"followUpOfRecordId":null')" "$(uuid)"
check_value db 'rejected follow-up bookings created no consultation row' "$N0" "$(sql 'select count(*) from consultations')"
expect POST /api/consultations patient "$P503" 'book with a record of another patient of the same doctor (503 vs 501 record)' '404 NotFound' '' "$(fbody 601 "$TYPE601" "$S4" ",\"followUpOfRecordId\":$RMIN")" "$(uuid)"
check_value db 'the foreign key rejects a dangling follow-up id at the database level' 1 "$(psql "$CARE_OWNER_DATABASE_URL" -XAt -c "UPDATE consultations SET follow_up_of_record_id=$NOBODY WHERE id=$FUC" 2>&1 | grep -c 'fk_consultations_follow_up_of_record_id')"
sql "UPDATE medical_records SET deleted_at=now() WHERE id=$RLOW" >/dev/null
expect POST /api/consultations patient-502 "$P502" 'book with a soft-deleted record (owner SQL, pre-lock) of this patient and doctor' '404 NotFound' '' "$(fbody 601 "$TYPE601" "$S5" ",\"followUpOfRecordId\":$RLOW")" "$(uuid)"
expect GET "/api/records/$RLOW" patient-502 "$P502" 'get of the soft-deleted record' '404 NotFound'
sql "UPDATE medical_records SET deleted_at=NULL WHERE id=$RLOW" >/dev/null

# ---- 14. Idempotency-Key is not used; no clinical text in Redis ----
IK="$(uuid)"; CIK="$(comp 601 502)"
flush_redis
export NO_FLUSH=1
expect POST "/api/consultations/$CIK/record" doctor "$D601" 'create carrying an Idempotency-Key behaves as without one' 201 "$REC_SHAPE" "$FULL" "$IK"
RIK="$(js 'b.data.id')"
expect PATCH "/api/records/$RIK" doctor "$D601" 'patch carrying an Idempotency-Key' 200 'b.data.followUpInDays===21' '{"followUpInDays":21}' "$IK"
expect GET "/api/records/$RIK" patient-other "$(pt 502)" 'get after the writes' 200 "b.data.id===$RIK"
expect GET "/api/patients/502/records" patient-other "$(pt 502)" 'timeline after the writes' 200 'b.data.records.length>=1'
unset NO_FLUSH
REDIS_HITS="$(node -e '
const R=require("ioredis");const r=new R(process.env.REDIS_URL);
(async()=>{const keys=await r.keys("*");let hits=0,idem=0;const marks=process.env.QA_MARKERS.split(",");
for(const k of keys){let v="";const t=await r.type(k);
 if(t==="string")v=await r.get(k);else if(t==="hash")v=JSON.stringify(await r.hgetall(k));else if(t==="list")v=JSON.stringify(await r.lrange(k,0,-1));
 else if(t==="set")v=JSON.stringify(await r.smembers(k));else if(t==="zset")v=JSON.stringify(await r.zrange(k,0,-1));
 if(marks.some(m=>(k+v).includes(m))||/Z99|A01\.1/.test(k+v))hits++; if(/idem/i.test(k))idem++;}
process.stdout.write(hits+" "+idem+" "+(keys.length>0?"keys":"nokeys"));await r.quit();})();')"
check_value redis 'no clinical marker in any Redis key or value, no idempotency key stored, Redis had keys to scan' "0 0 keys" "$REDIS_HITS"

# ---- 15. Rate limits (R-D9): write 20/min (POST + PATCH share), read 120/min, timeline 60/min, per user ----
CRL="$(comp 601 502)"
flush_redis
WB="$(burst 20 PATCH "/api/records/$RIK" "$D601" '{"followUpInDays":21}')"
check_value ratelimit 'write bucket: 20 no-op PATCH calls in a minute all succeed' '200 x20;' "$WB"
NO_FLUSH=1 expect POST "/api/consultations/$CRL/record" doctor "$D601" 'write bucket shared: the 21st write (a create) is limited' '429 RateLimited' '' "$FULL"
check_value ratelimit 'the 429 carries Retry-After and no-store' "1 1" "$(grep -qi '^retry-after:' "$TMP/headers" && echo 1 || echo 0) $(grep -qi '^cache-control:.*no-store' "$TMP/headers" && echo 1 || echo 0)"
check_value ratelimit 'the limited create wrote nothing' 0 "$(sql "SELECT count(*) FROM medical_records WHERE consultation_id=$CRL")"
NO_FLUSH=1 expect PATCH "/api/records/$RIK" doctor "$D601" 'the 22nd write is limited too' '429 RateLimited' '' '{"followUpInDays":21}'
NO_FLUSH=1 expect GET "/api/records/$RIK" doctor "$D601" 'read bucket is independent: the same doctor can still read' 200 "b.data.id===$RIK"
NO_FLUSH=1 expect PATCH "/api/records/$RMIN" doctor-other "$D602" 'write bucket is per user: another doctor is not limited (gets its own error)' '403 NotAssignedDoctor' '' '{"followUpInDays":21}'
flush_redis
RB1="$(burst 120 GET "/api/records/$RIK" "$P502")"
check_value ratelimit 'read bucket: 120 GET /records/{id} calls in a minute all succeed' '200 x120;' "$RB1"
NO_FLUSH=1 expect GET "/api/records/$RIK" patient-other "$P502" 'the 121st read is limited' '429 RateLimited'
NO_FLUSH=1 expect GET '/api/patients/502/records' patient-other "$P502" 'timeline bucket is separate from the read bucket' 200 'Array.isArray(b.data.records)'
flush_redis
TB1="$(burst 60 GET '/api/patients/502/records' "$P502")"
check_value ratelimit 'timeline bucket: 60 calls in a minute all succeed' '200 x60;' "$TB1"
NO_FLUSH=1 expect GET '/api/patients/502/records' patient-other "$P502" 'the 61st timeline call is limited' '429 RateLimited'
flush_redis

# ---- 16. Hygiene: audit rows, clinical-free metadata, server log ----
check_value audit 'every record audit row has only flat scalar metadata keys from the allowlist' 0 "$(sql "SELECT count(*) FROM audit_logs a, jsonb_object_keys(a.metadata) k WHERE a.created_at >= '$T0' AND a.action IN ('record.created','record.read','record.updated','record.amended','patient_records.listed') AND k NOT IN ('consultationId','patientUserId','doctorUserId','providedFields','viewerRole','viewerIsAuthor','amendmentCount','changedFields','amendmentId','reasonLength','recordCount','hasMore','firstPage')")"
check_value audit 'no audit row holds a clinical marker, a diagnosis code or the amendment reason' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND (metadata::text LIKE '%QA-REC-%' OR metadata::text LIKE '%Z99%' OR metadata::text LIKE '%coding fix%' OR metadata::text LIKE '%after the lock%')")"
check_value audit 'record audit rows are all attributed to a doctor or a patient, never to an admin' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action IN ('record.created','record.read','record.updated','record.amended','patient_records.listed') AND actor_role NOT IN ('doctor','patient')")"
check_value audit 'record.created count equals the number of records created through the API' "$(sql "SELECT count(*) FROM medical_records WHERE chief_complaint NOT LIKE '%tie'")" "$(audit_n record.created)"
if [ -n "${SERVER_LOG:-}" ]; then
  LOG_TAIL="$TMP/server.tail"; tail -n +$((LOG_MARK+1)) "$SERVER_LOG" > "$LOG_TAIL"
  check_value log 'captured log is non-trivial' 1 "$([ "$(wc -l < "$LOG_TAIL")" -gt 20 ] && echo 1 || echo 0)"
  for needle in "$CH" "$NO" "$DX" "$PL" "$RS" "$AL" 'Bearer ' 'Z99.9' 'eyJhbGciOiJFZERTQS'; do
    check_value log "no '$needle' in the server log" 0 "$(grep -cF -- "$needle" "$LOG_TAIL" || true)"
  done
else
  skip_note 'log hygiene skipped: SERVER_LOG not set'
fi

echo "RESULT: $PASS pass / $FAIL fail ($SKIP skipped sections)"
[ "$FAIL" = 0 ]
