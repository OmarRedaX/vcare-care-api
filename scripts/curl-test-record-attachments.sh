#!/usr/bin/env bash
# Repeatable HTTP QA for the record-attachments module (docs/record-attachments/manual-qa.md):
#   POST   /api/records/{id}/attachments/uploads                              (intent)
#   POST   /api/records/{id}/attachments/uploads/{uploadId}/complete          (verify the stored object, add the attachment)
#   POST   /api/records/{id}/attachments/{attachmentId}/download-url          (60 s presigned GET)
#   DELETE /api/records/{id}/attachments/{attachmentId}                       (soft delete, before the 24 h lock only)
#   plus MedicalRecord.attachments on GET /api/records/{id} and the patient timeline.
# The browser-style presigned POST is done with `curl --form-string` / `-F` exactly as a browser would (policy fields from the intent,
# the file last); the download URL is followed with a plain GET.
# Use only a disposable *_test or *_qa* database: fixtures TRUNCATE consultations, medical_records, record_attachments and the outbox.
#
# Start first (see docs/record-attachments/manual-qa.md -> Environment):
#   node scripts/consultations-qa-fake-identity.mjs     # JWKS + user tokens + fake Identity internal API (FAKE_IDENTITY_PORT, default 3023)
#   node scripts/storage-qa-fake-s3.mjs                 # DEV-ONLY in-memory S3 stand-in (FAKE_S3_PORT, default 9013) - NOT real S3 / MinIO
#   npx tsx src/server.ts                                # the real Care API (PORT=3001, INTERNAL_PORT=3101, NODE_ENV=development),
#                                                        # DATABASE_URL = the care_app login, REDIS_URL on a spare db index,
#                                                        # STORAGE_ENDPOINT = the storage endpoint, STORAGE_FORCE_PATH_STYLE=true
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH), REDIS_URL (same spare db as the server; it is
#           flushed before EVERY call so rate limits start clean, except in the burst sections).
# Optional: CARE_URL (default http://127.0.0.1:3001), FAKE_IDENTITY_URL (default http://127.0.0.1:3023),
#           FAKE_S3_URL (the stand-in's control surface, e.g. http://127.0.0.1:9013: enables the storage-side assertions, the policy /
#             download-URL expiry probes and the storage fault injection; without it those cases are SKIPPED, so against real MinIO they are),
#           CARE_APP_DATABASE_URL (the care_app login: enables the direct grant / trigger checks),
#           CARE_WORKER_PURGE_CMD (one care-worker tick: `npx tsx src/worker.ts --once upload-intent-purge` with the Care env; enables the purge case),
#           QA_REPORT (file receiving the case table), SERVER_LOG (care-api log; scanned for leaks),
#           QA_KEEP=1 (skip the end-of-run fixture reset), QA_DEBUG_FILE (keeps the first 400 bytes of the body of a failed case).
# Synthetic fixtures: patients 501-502, doctors 601-604 and 606, admins 1, 2. Clinical text and descriptions are only the QA-ATT-* markers below.
# Time: the lock instant is reached by moving created_at / updated_at / locked_at together as the table owner while the row is still open
#       (the BEFORE UPDATE trigger of medical_records refuses any later update, the owner's included).
set -euo pipefail
export MSYS_NO_PATHCONV=1

CARE_URL="${CARE_URL:-http://127.0.0.1:3001}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3023}"
S3_CTL="${FAKE_S3_URL:-}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
: "${REDIS_URL:?Set REDIS_URL to the spare Redis db index the server uses}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
export REDIS_URL
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"
PASS=0; FAIL=0; CASE=0; SKIP=0
CH='QA-ATT-CHIEF-7700'; D1='QA-ATT-DESC-7701'; DM='QA-ATT-DESC-7702'; DF='QA-ATT-FILE-7703'; DR='QA-ATT-DESC-7704'
# error bodies must never carry a marker, a storage key or a signed-URL parameter
export QA_MARKERS="$CH,$D1,$DM,$DF,$DR,quarantine/,record-attachments/,X-Amz-"

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
asapp() { psql "$CARE_APP_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" 2>&1 | tr -d '\r' || true; }
asappv() { psql "$CARE_APP_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$1" 2>&1 | tr -d '\r' || true; }  # verbose: prints the SQLSTATE
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
pt() { mint "patient-$1"; }; dt() { mint "doctor-$1"; }; at() { mint "admin-$1"; }
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/body" "$1"; }
ijs() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/intent.json" "$1"; }
flush_redis() { node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null; }
# uesc <count> <hex unit>...: the JSON escape sequence (backslash-u plus 4 hex digits per unit) repeated <count> times, ASCII only
uesc() { node -e 'const n=Number(process.argv[1]);process.stdout.write(process.argv.slice(2).map((u)=>String.fromCharCode(92)+"u"+u).join("").repeat(n))' "$@"; }
rep() { node -e 'process.stdout.write(process.argv[1].repeat(Number(process.argv[2])))' -- "$1" "$2"; }
slot() { node -e 'const {DateTime}=require("luxon");const [d,t,z]=[Number(process.argv[1]),process.argv[2],process.argv[3]||"Africa/Cairo"];const [h,m]=t.split(":").map(Number);process.stdout.write(DateTime.now().setZone(z).plus({days:d}).set({hour:h,minute:m,second:0,millisecond:0}).toISO({suppressMilliseconds:true}))' -- "$1" "$2" "${3:-}"; }
s3() { curl -fsS "$S3_CTL/$1"; }

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
# check_body <ok|error|empty> <code> [assertion_js]: X-Request-Id echoed, no-store, envelope; an ERROR body never carries a marker / key / signed-URL
# parameter; an OK body (except the intent and download-url responses, CHECK_LEAK=0) never carries a key, a URL or a storage field; assertion over `b`
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: .*no-store/im.test(h)) process.exit(1);
const raw = fs.readFileSync(file, 'utf8');
if (kind === 'empty') process.exit(raw === '' ? 0 : 1);
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (kind === 'error') {
  if (process.env.QA_MARKERS.split(',').some((m) => raw.includes(m))) process.exit(1);
  if (b.success !== false || b.error?.code !== code || b.error?.requestId !== rid ||
      typeof b.error?.message !== 'string' || !Array.isArray(b.error?.details)) process.exit(1);
} else {
  if (b.success !== true) process.exit(1);
  if (process.env.CHECK_LEAK === '1' && /record-attachments\/|quarantine\/|X-Amz|objectKey|object_key|uploadedByUserId|downloadUrl|https?:\/\//i.test(raw)) process.exit(1);
}
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
  local status ok=1 kind=ok code='' want="${expected%% *}" leak=1
  status="$(call "$method" "$path" "$token" "$body" "$key" "$extra")"
  [ "$expected" != "$want" ] && { kind=error; code="${expected#* }"; }
  [ "$kind" = ok ] && [ "$want" = 204 ] && kind=empty
  [[ "$path" == */attachments/uploads || "$path" == */download-url ]] && leak=0
  [ "$status" = "$want" ] || ok=0
  CHECK_LEAK=$leak check_body "$kind" "$code" "$assertion" || ok=0
  local got="$status"
  if [ "$kind" = error ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
  fi
  record "$method" "$path" "$role" "$scenario" "$expected" "$got" "$ok"
  # QA_DEBUG_FILE (optional): on a failed case keep the first 400 bytes of the response body for diagnosis
  [ "$ok" = 1 ] || [ -z "${QA_DEBUG_FILE:-}" ] || { printf 'CASE %s %s\n' "$CASE" "$(head -c 400 "$TMP/body")" >> "$QA_DEBUG_FILE"; }
}
check_value() { record check "$1" owner "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"; }
skip_note() { SKIP=$((SKIP+1)); echo "SKIPPED|$1" | tee -a "${QA_REPORT:-$TMP/report}"; }
# s3_check <section> <scenario> <expected> <ctl path>: a storage-side assertion through the stand-in's control surface (skipped without it)
s3_check() { if [ -n "$S3_CTL" ]; then check_value "$1" "$2" "$3" "$(s3 "$4")"; else skip_note "storage assertion skipped (FAKE_S3_URL not set): $2"; fi; }
aud() { sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='$1' ${2:+AND entity_id=$2}"; }
att_live() { sql "SELECT count(*) FROM record_attachments WHERE medical_record_id=$1 AND deleted_at IS NULL"; }
att_all() { sql "SELECT count(*) FROM record_attachments"; }
att_audit_all() { sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action IN ('attachment.added','attachment.removed','attachment.url_issued')"; }
intent_state() { sql "SELECT (consumed_at IS NOT NULL)::text || ' ' || coalesce(result_id::text,'-') FROM upload_intents WHERE id=$1"; }
rowhash() { sql "SELECT md5(row_to_json(m)::text) FROM medical_records m WHERE id=$1"; }
rowhash_att() { sql "SELECT md5(row_to_json(a)::text) FROM record_attachments a WHERE id=$1"; }
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
pcall() { # pcall <name> <method> <path> <token> [body]: background call, status in $TMP/par_<name>
  local name="$1" method="$2" path="$3" token="$4" body="${5:-}"
  local args=(-sS -X "$method" -H "X-Request-Id: $(uuid)" -H "Authorization: Bearer $token" -o "$TMP/par_$name.body" -w '%{http_code}')
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  curl "${args[@]}" "$CARE_URL$path" > "$TMP/par_$name.status" || echo 000 > "$TMP/par_$name.status"
}
pstat() { cat "$TMP/par_$1.status"; }
pcode() { node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("-")}' "$TMP/par_$1.body"; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }
[ -z "$S3_CTL" ] || [ "$(curl -s -o /dev/null -w '%{http_code}' "$S3_CTL/__calls")" = 200 ] || { echo 'Storage stand-in control surface unavailable' >&2; exit 2; }

reset() {
  sql "TRUNCATE notification_outbox, record_attachments, medical_record_amendments, medical_records, consultations;
       DELETE FROM upload_intents WHERE kind='record_attachment' OR owner_user_id BETWEEN 600 AND 699;
       DELETE FROM identity_sync_jobs WHERE doctor_user_id BETWEEN 600 AND 699;
       DELETE FROM schedule_exceptions WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM working_hours WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699;
       DELETE FROM patient_profiles WHERE user_id BETWEEN 500 AND 599;" >/dev/null
}
cleanup() { [ -n "${QA_KEEP:-}" ] || reset 2>/dev/null || true; [ -z "$S3_CTL" ] || curl -fsS "$S3_CTL/__reset" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
reset; flush_redis; curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null; [ -z "$S3_CTL" ] || s3 __reset >/dev/null
T0="$(sql 'select now()')"
LOG_MARK=0; [ -z "${SERVER_LOG:-}" ] || LOG_MARK="$(wc -l < "$SERVER_LOG")"

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
EXPIRED="$(mint expired)"; SVC="$(curl -fsS "$FAKE_IDENTITY_URL/mint?case=patient-501&typ=service")"
# tokens live 15 minutes and the fake memoises them for 10: re-mint at the start of every section
tokens() {
  ADMIN="$(at 1)"; ADMIN2="$(at 2)"
  D601="$(dt 601)"; D602="$(dt 602)"; D603="$(dt 603)"; D604="$(dt 604)"; D606="$(dt 606)"
  P501="$(pt 501)"; P502="$(pt 502)"
  DPEND="$(mint doctor-pending)"; DREJ="$(mint doctor-rejected)"; PPEND="$(mint patient-pending)"; ASUSP="$(mint admin-suspended)"
}
tokens
echo 'case|method|path|role|scenario|expected|got|result'

HOURS='{"days":['"$(for d in 1 2 3 4 5 6 7; do printf '{"weekday":%s,"intervals":[{"startTime":"00:00","endTime":"23:59"}]},' $d; done | sed 's/,$//')"']}'
mkdoc() {
  local uid="$1" t
  t="$(dt "$uid")"
  [ "$(call POST /api/doctors/apply "$t" "{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"Africa/Cairo\",\"submit\":false}")" = 201 ] || { echo "fixture apply failed for doctor $uid" >&2; exit 2; }
  sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$uid" >/dev/null
  [ "$(call POST /api/doctors/me/consultation-types "$t" '{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}')" = 201 ] || { echo "fixture type failed for $uid" >&2; exit 2; }
  [ "$(call PUT /api/doctors/me/working-hours "$t" "$HOURS")" = 200 ] || { echo "fixture hours failed for $uid" >&2; exit 2; }
}
tid() { sql "SELECT id FROM consultation_types WHERE doctor_profile_id=(SELECT id FROM doctor_profiles WHERE user_id=$1) ORDER BY id LIMIT 1"; }
mkrow() {
  sql "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash,cancelled_at,cancelled_by,joined_at,started_at,completed_at,no_show_marked_at)
       VALUES ($1,$2,$(tid "$1"),now()+interval '$3 seconds',now()+interval '$3 seconds'+interval '30 minutes','$4','QA synthetic complaint','Africa/Cairo',500,'EGP',gen_random_uuid(),repeat('0',64),
       CASE WHEN '$4'='cancelled' THEN now() END, CASE WHEN '$4'='cancelled' THEN 'doctor' END,
       CASE WHEN '$4' IN ('waiting','in_progress','completed') THEN now() END, CASE WHEN '$4' IN ('in_progress','completed') THEN now() END,
       CASE WHEN '$4'='completed' THEN now() END, CASE WHEN '$4'='no_show' THEN now() END) RETURNING id" | head -1
}
echo 0 > "$TMP/kn"; echo 0 > "$TMP/fn"
bump() { local n; n=$(( $(cat "$TMP/$1") + 1 )); echo "$n" > "$TMP/$1"; echo "$n"; }
comp() { mkrow "$1" "$2" "$((-90000 - 3600 * $(bump kn)))" completed; }
fut() { mkrow "$1" "$2" "$((3600 + 7200 * $(bump fn)))" "$3"; }
# mkrec <doctor> <patient> <doctorToken>: a completed consultation and its record through the real route; prints the record id
mkrec() {
  local c; c="$(comp "$1" "$2")"
  [ "$(call POST "/api/consultations/$c/record" "$3" "{\"chiefComplaint\":\"$CH\"}")" = 201 ] || { echo "fixture record failed ($1/$2)" >&2; exit 2; }
  js 'b.data.id'
}

# ---- files (synthetic bytes; the marker inside the PDF proves file content never reaches a log or audit row) ----
printf '%%PDF-1.4\n%s\n%%%%EOF\n' "$DF" > "$TMP/doc.pdf"
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01QA-synthetic-jpeg' > "$TMP/pic.jpg"
printf '\x89PNG\r\n\x1a\nQA-synthetic-png' > "$TMP/pic.png"
printf 'this is plain text that merely claims to be a pdf: %s\n' "$DF" > "$TMP/fake.pdf"
: > "$TMP/empty.bin"
node -e 'const fs=require("fs");const mk=(n,f)=>{const b=Buffer.alloc(n);b.write("%PDF-1.4\n");fs.writeFileSync(f,b)};mk(10485760,process.argv[1]+"/max.pdf");mk(10485761,process.argv[1]+"/over.pdf")' "$TMP"
SIZE_PDF="$(wc -c < "$TMP/doc.pdf" | tr -d ' ')"
# post_object <file> [filename] [declared type]: the browser-style presigned POST with the fields of $TMP/intent.json; prints the HTTP status
post_object() {
  local file="$1" fname="${2:-doc.pdf}" ctype="${3:-application/pdf}" url name value
  local args=()
  url="$(ijs 'b.data.url')"
  while IFS=$'\t' read -r name value; do
    [ "$name" = key ] && [ -n "${POST_KEY_OVERRIDE:-}" ] && value="$POST_KEY_OVERRIDE"
    args+=(--form-string "$name=$value")
  done < <(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const [k,v] of Object.entries(b.data.fields))process.stdout.write(k+"\t"+v+"\n")' "$TMP/intent.json")
  curl -sS -o "$TMP/s3.body" -w '%{http_code}' "${args[@]}" -F "file=@$file;filename=$fname;type=$ctype" "$url"
}
# mkintent <record> <token> [body]: fixture intent through the real route (status must be 201); sets INTENT_ID and $TMP/intent.json
mkintent() {
  local s; s="$(call POST "/api/records/$1/attachments/uploads" "$2" "${3:-}")"
  [ "$s" = 201 ] || { echo "fixture intent failed: $s (record $1)" >&2; exit 2; }
  cp "$TMP/body" "$TMP/intent.json"; INTENT_ID="$(ijs 'b.data.uploadId')"
}
# addatt <record> <token> <file> [body]: intent -> POST -> complete (all must succeed); sets ATT and INTENT_ID
addatt() {
  mkintent "$1" "$2" "${4:-}"
  [ "$(post_object "$3")" = 204 ] || { echo "fixture upload failed (record $1)" >&2; exit 2; }
  [ "$(call POST "/api/records/$1/attachments/uploads/$INTENT_ID/complete" "$2")" = 201 ] || { echo "fixture complete failed (record $1)" >&2; exit 2; }
  ATT="$(js 'b.data.id')"
}
base() { echo "/api/records/$1/attachments"; }
NOBODY=99999999
INTENT_SHAPE='Object.keys(b.data).sort().join()==="expiresAt,fields,maxBytes,uploadId,url"&&Number.isInteger(b.data.uploadId)&&b.data.maxBytes===10485760&&typeof b.data.url==="string"&&b.data.url.startsWith("http")&&(()=>{const f=b.data.fields;const pk=Object.keys(f).find(k=>k.toLowerCase()==="policy");const p=JSON.parse(Buffer.from(f[pk],"base64").toString());return f.key.startsWith("quarantine/")&&p.conditions.some(c=>Array.isArray(c)&&c[0]==="content-length-range"&&c[1]===1&&c[2]===10485760)&&p.conditions.some(c=>Array.isArray(c)&&c[0]==="eq"&&c[1]==="$key"&&c[2]===f.key)&&Date.parse(p.expiration)-Date.now()<=301000&&Date.parse(p.expiration)>Date.now()})()&&Math.abs(Date.parse(b.data.expiresAt)-Date.now()-900000)<20000'
ATT_SHAPE='Object.keys(b.data).sort().join()==="createdAt,description,fileType,id,recordId,sizeBytes"&&Number.isInteger(b.data.id)&&b.data.createdAt.endsWith("Z")'
DL_SHAPE='Object.keys(b.data).sort().join()==="expiresAt,url"&&b.data.url.startsWith("http")&&Math.abs(Date.parse(b.data.expiresAt)-Date.now()-60000)<8000'

# ---- 0. Fixtures ----
for d in 601 602 603 604 606; do mkdoc "$d"; done
tokens
RMAIN="$(mkrec 601 501 "$D601")"; ROTH="$(mkrec 601 502 "$D601")"; RLOCK="$(mkrec 601 501 "$D601")"; RCAP="$(mkrec 601 501 "$D601")"
RRL="$(mkrec 601 501 "$D601")"; R603="$(mkrec 603 501 "$D603")"
fut 602 501 booked >/dev/null; fut 606 501 cancelled >/dev/null; fut 606 501 no_show >/dev/null   # 602 related; 606 cancelled / no_show only grants nothing; 604 none
check_value fixtures 'six records with no attachment and no audit row yet' "6 0 0" "$(sql 'select count(*) from medical_records') $(att_all) $(att_audit_all)"

# ---- 1. Authentication matrix (all four routes) ----
for who in "none|" "malformed|garbage.token.value" "expired|$EXPIRED" "service-token|$SVC"; do
  n="${who%%|*}"; t="${who#*|}"
  exp='401 Unauthorized'; [ "$n" = expired ] && exp='401 TokenExpired'
  expect POST "$(base "$RMAIN")/uploads" "$n" "$t" "intent $n" "$exp" '' '{}'
  expect POST "$(base "$RMAIN")/uploads/1/complete" "$n" "$t" "complete $n" "$exp"
  expect POST "$(base "$RMAIN")/1/download-url" "$n" "$t" "download-url $n" "$exp"
  expect DELETE "$(base "$RMAIN")/1" "$n" "$t" "delete $n" "$exp"
done
check_value auth 'unauthenticated calls created no intent, no attachment, no audit row' "0 0 0" "$(sql "select count(*) from upload_intents where kind='record_attachment'") $(att_all) $(att_audit_all)"

# ---- 2. Role / account-state denials that never reach a lookup ----
for who in "admin|$ADMIN" "admin2|$ADMIN2"; do
  n="${who%%|*}"; t="${who#*|}"
  expect POST "$(base "$RMAIN")/uploads" "$n" "$t" "intent denied for $n (existing record)" '403 Forbidden' '' '{}'
  expect POST "$(base "$NOBODY")/uploads" "$n" "$t" "intent denied for $n (unknown record: role beats lookup)" '403 Forbidden' '' '{}'
  expect POST "$(base abc)/uploads" "$n" "$t" "intent denied for $n (non-numeric record id)" '403 Forbidden' '' '{}'
  expect POST "$(base "$RMAIN")/uploads/1/complete" "$n" "$t" "complete denied for $n" '403 Forbidden'
  expect POST "$(base "$NOBODY")/uploads/abc/complete" "$n" "$t" "complete denied for $n (unknown record, non-numeric upload id)" '403 Forbidden'
  expect POST "$(base "$RMAIN")/1/download-url" "$n" "$t" "download-url denied for $n (existing record)" '403 Forbidden'
  expect POST "$(base "$NOBODY")/$NOBODY/download-url" "$n" "$t" "download-url denied for $n (unknown ids: role beats lookup)" '403 Forbidden'
  expect POST "$(base abc)/abc/download-url" "$n" "$t" "download-url denied for $n (non-numeric ids)" '403 Forbidden'
  expect DELETE "$(base "$RMAIN")/1" "$n" "$t" "delete denied for $n" '403 Forbidden'
  expect DELETE "$(base "$NOBODY")/$NOBODY" "$n" "$t" "delete denied for $n (unknown ids)" '403 Forbidden'
done
for who in "patient|$P501" "patient-other|$P502"; do
  n="${who%%|*}"; t="${who#*|}"
  expect POST "$(base "$RMAIN")/uploads" "$n" "$t" "intent denied for a patient ($n)" '403 Forbidden' '' '{}'
  expect POST "$(base "$RMAIN")/uploads/1/complete" "$n" "$t" "complete denied for a patient ($n)" '403 Forbidden'
  expect DELETE "$(base "$RMAIN")/1" "$n" "$t" "delete denied for a patient ($n)" '403 Forbidden'
done
expect POST "$(base "$RMAIN")/uploads" doctor-pending "$DPEND" 'intent, doctor token status pending' '403 Forbidden' '' '{}'
expect POST "$(base "$RMAIN")/uploads/1/complete" doctor-pending "$DPEND" 'complete, doctor token status pending' '403 Forbidden'
expect POST "$(base "$RMAIN")/1/download-url" doctor-pending "$DPEND" 'download-url, doctor token status pending' '403 Forbidden'
expect DELETE "$(base "$RMAIN")/1" doctor-pending "$DPEND" 'delete, doctor token status pending' '403 Forbidden'
expect POST "$(base "$RMAIN")/uploads" doctor-rejected "$DREJ" 'intent, doctor token status rejected' '403 Forbidden' '' '{}'
expect DELETE "$(base "$RMAIN")/1" doctor-rejected "$DREJ" 'delete, doctor token status rejected' '403 Forbidden'
expect POST "$(base "$RMAIN")/1/download-url" patient-pending "$PPEND" 'download-url, patient token status pending' '403 Forbidden'
expect POST "$(base "$RMAIN")/1/download-url" admin-suspended "$ASUSP" 'download-url, admin token status suspended' '403 Forbidden'
check_value rbac 'denied calls created no intent, no attachment, no audit row' "0 0 0" "$(sql "select count(*) from upload_intents where kind='record_attachment'") $(att_all) $(att_audit_all)"

# ---- 3. Intent validation (400 before any storage or database write) ----
tokens
v400() { expect POST "$(base "$RMAIN")/uploads" doctor "$D601" "intent validation: $1" '400 ValidationFailed' "b.error.details.length>0${3:+&&$3}" "$2"; }
v400 description-blank '{"description":"   "}' 'b.error.details.some(d=>d.field==="description")'
v400 description-empty '{"description":""}' 'b.error.details.some(d=>d.field==="description")'
v400 description-501-code-points "{\"description\":\"$(rep x 501)\"}" 'b.error.details.some(d=>d.field==="description")'
v400 description-501-non-ascii "{\"description\":\"$(uesc 501 00e9)\"}"
v400 description-NUL '{"description":"abc\u0000def"}' 'b.error.details.some(d=>d.field==="description")'
v400 description-null '{"description":null}' 'b.error.details.some(d=>d.field==="description")'
v400 description-number '{"description":12345}'
v400 description-boolean '{"description":true}'
v400 description-array '{"description":["a"]}'
v400 description-object '{"description":{"a":1}}'
v400 unknown-member-alone '{"patientUserId":502}' 'b.error.details.some(d=>d.field==="patientUserId")'
v400 unknown-member-with-valid-description '{"description":"ok","objectKey":"x"}' 'b.error.details.some(d=>d.field==="objectKey")'
v400 unknown-member-fileType '{"fileType":"application/pdf"}'
v400 array-body '[]'
v400 non-object-json-string '"just a string"'
v400 malformed-json '{"description":'
check_value validation 'validation failures created no intent row and no audit row' "0 0" "$(sql "select count(*) from upload_intents where kind='record_attachment'") $(att_audit_all)"
# boundaries that are valid
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent without a body at all' 201 "$INTENT_SHAPE"
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with an empty object' 201 "$INTENT_SHAPE" '{}'
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with a 1-character description' 201 "$INTENT_SHAPE" '{"description":"x"}'
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with a 500-code-point description' 201 "$INTENT_SHAPE" "{\"description\":\"$(rep x 500)\"}"
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with 500 astral code points (1000 UTF-16 units): counted in code points' 201 "$INTENT_SHAPE" "{\"description\":\"$(uesc 500 d83d de00)\"}"
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with a multi-line description (newline allowed)' 201 "$INTENT_SHAPE" '{"description":"line one\nline two"}'
check_value validation 'six valid intents inserted six open record_attachment intents owned by the author for this record, no attachment, no audit row' "6 0 0" "$(sql "select count(*) from upload_intents where kind='record_attachment' and owner_user_id=601 and target_id=$RMAIN and consumed_at is null") $(att_all) $(att_audit_all)"
check_value validation 'the stored description of the 500-astral intent is 500 characters' 500 "$(sql "select max(char_length(description)) from upload_intents where kind='record_attachment' and target_id=$RMAIN")"
expect POST "$(base "$RMAIN")/uploads" doctor-spoof "$D602" 'spoofed X-User-Id / X-Role are ignored (related doctor stays 404)' '404 NotFound' '' '{}' '' 'X-User-Id: 601'

# ---- 4. Happy path: intent -> browser-style POST -> complete -> list -> download -> delete ----
tokens
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with a description' 201 "$INTENT_SHAPE" "{\"description\":\"$D1\"}"
cp "$TMP/body" "$TMP/intent.json"; I1="$(ijs 'b.data.uploadId')"
check_value db 'the intent row: kind record_attachment, target = the record, owner = the author, no document type, description kept, open, quarantine key, 10 MB cap, 15 minute expiry' "record_attachment $RMAIN 601 true true false 10485760 true" "$(sql "SELECT kind||' '||target_id||' '||owner_user_id||' '||(document_type IS NULL)||' '||(description IS NOT NULL)||' '||(consumed_at IS NOT NULL)||' '||max_bytes||' '||(quarantine_key LIKE 'quarantine/%' AND expires_at BETWEEN now()+interval '14 minutes' AND now()+interval '16 minutes') FROM upload_intents WHERE id=$I1")"
s3_check storage 'creating an intent touched no stored object (signing is local)' '0' '__count?prefix='
check_value upload 'the browser-style presigned POST of a PDF (declared application/pdf, file named .pdf) is accepted: 204' 204 "$(post_object "$TMP/doc.pdf")"
if [ -n "$S3_CTL" ]; then check_value storage 'quarantine / final object counts' '1 0' "$(s3 '__count?prefix=quarantine/') $(s3 '__count?prefix=record-attachments/')"; fi
expect POST "$(base "$RMAIN")/uploads/$I1/complete" doctor "$D601" 'complete: the stored object is verified, promoted, and the attachment is created' 201 "$ATT_SHAPE&&b.data.recordId===$RMAIN&&b.data.fileType==='application/pdf'&&b.data.sizeBytes===$SIZE_PDF&&b.data.description==='$D1'"
A1="$(js 'b.data.id')"; RID_C="$(cat "$TMP/rid")"
check_value db 'one live row: author, detected type, HEAD size, record-attachments/ key, description from the intent' "1 601 application/pdf $SIZE_PDF true true" "$(sql "SELECT count(*) FROM record_attachments WHERE id=$A1 AND medical_record_id=$RMAIN AND deleted_at IS NULL") $(sql "SELECT uploaded_by_user_id||' '||file_type||' '||size_bytes||' '||(object_key LIKE 'record-attachments/%')||' '||(description IS NOT NULL) FROM record_attachments WHERE id=$A1")"
check_value db 'the intent is consumed with result_id = the attachment' "true $A1" "$(intent_state "$I1")"
if [ -n "$S3_CTL" ]; then check_value storage 'quarantine / final object counts after complete' '0 1' "$(s3 '__count?prefix=quarantine/') $(s3 '__count?prefix=record-attachments/')"; fi
check_value audit 'one attachment.added row (actor doctor, request id, entity record_attachment, flat metadata, afterLock false)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.added' AND entity_type='record_attachment' AND entity_id=$A1 AND actor_user_id=601 AND actor_role='doctor' AND request_id='$RID_C' AND metadata->>'afterLock'='false' AND (metadata->>'sizeBytes')::int=$SIZE_PDF AND metadata->>'fileType'='application/pdf' AND (metadata->>'recordId')::int=$RMAIN AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['afterLock','fileType','recordId','sizeBytes']")"
check_value audit 'attachment.added metadata holds no description, key or marker' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.added' AND (metadata::text LIKE '%QA-ATT-%' OR metadata::text LIKE '%record-attachments/%' OR metadata::text LIKE '%quarantine%')")"
expect POST "$(base "$RMAIN")/uploads/$I1/complete" doctor "$D601" 'replayed complete returns the same attachment with 200' 200 "$ATT_SHAPE&&b.data.id===$A1&&b.data.description==='$D1'"
check_value db 'the replay created no second row and no second audit row, left the quarantine area empty' "1 1" "$(att_live "$RMAIN") $(aud attachment.added "$A1")"
if [ -n "$S3_CTL" ]; then S3_BEFORE_READ="$(s3 __calls)"; fi
RIDM="$(cat "$TMP/rid")"
expect GET "/api/records/$RMAIN" patient "$P501" 'GET record by the owning patient lists the attachment (metadata only)' 200 "b.data.attachments.length===1&&Object.keys(b.data.attachments[0]).sort().join()==='createdAt,description,fileType,id,recordId,sizeBytes'&&b.data.attachments[0].id===$A1&&b.data.attachments[0].description==='$D1'&&b.data.attachments[0].fileType==='application/pdf'&&b.data.attachments[0].sizeBytes===$SIZE_PDF"
expect GET "/api/records/$RMAIN" doctor "$D601" 'GET record by the author lists it' 200 "b.data.attachments.length===1&&b.data.attachments[0].id===$A1"
expect GET "/api/records/$RMAIN" doctor-related "$D602" 'GET record by a related doctor lists it' 200 "b.data.attachments.length===1&&b.data.attachments[0].id===$A1"
expect GET "/api/patients/501/records" patient "$P501" 'patient timeline carries the attachment on its record and [] on the others' 200 "b.data.records.find(r=>r.id===$RMAIN).attachments.length===1&&b.data.records.filter(r=>r.id!==$RMAIN).every(r=>r.attachments.length===0)&&!b.data.records.some(r=>r.id===$ROTH)"
if [ -n "$S3_CTL" ]; then check_value storage 'reading a record and a timeline made zero storage calls' 0 "$(( $(s3 __calls) - S3_BEFORE_READ ))"; else skip_note 'zero-storage-call check skipped (FAKE_S3_URL not set)'; fi
D0="$(aud attachment.url_issued)"
expect POST "$(base "$RMAIN")/$A1/download-url" patient "$P501" 'download-url by the owning patient: 60 s URL' 200 "$DL_SHAPE"
RIDD="$(cat "$TMP/rid")"
status="$(curl -sS -D "$TMP/dl.headers" -o "$TMP/dl.bin" -w '%{http_code}' "$(js 'b.data.url')")"
check_value download 'following the presigned URL returns the file bytes, byte for byte' "200 same" "$status $(cmp -s "$TMP/doc.pdf" "$TMP/dl.bin" && echo same || echo different)"
check_value download 'the response is an attachment of the stored verified type' "1 1" "$(grep -ci '^content-disposition: attachment' "$TMP/dl.headers" || true) $(grep -ci '^content-type: application/pdf' "$TMP/dl.headers" || true)"
check_value download 'the same object URL without its signature is refused (private bucket, no anonymous read): 403' 403 "$(curl -sS -o /dev/null -w '%{http_code}' "$(js 'b.data.url' | sed 's/?.*//')")"
check_value audit 'attachment.url_issued row written for the issued URL (patient, request id, flat metadata, viewerIsAuthor false)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.url_issued' AND entity_type='record_attachment' AND entity_id=$A1 AND actor_user_id=501 AND actor_role='patient' AND request_id='$RIDD' AND metadata->>'viewerRole'='patient' AND metadata->>'viewerIsAuthor'='false' AND (metadata->>'recordId')::int=$RMAIN AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['recordId','viewerIsAuthor','viewerRole']")"
expect POST "$(base "$RMAIN")/$A1/download-url" doctor "$D601" 'download-url by the author' 200 "$DL_SHAPE"
expect POST "$(base "$RMAIN")/$A1/download-url" doctor "$D601" 'a second URL for the same attachment is a second issuance' 200 "$DL_SHAPE"
expect POST "$(base "$RMAIN")/$A1/download-url" doctor-related "$D602" 'download-url by a related doctor' 200 "$DL_SHAPE"
check_value audit 'one audit row per issued URL: 4 URLs issued, 4 rows (patient, author twice with viewerIsAuthor true, related doctor)' "4 2" "$(( $(aud attachment.url_issued) - D0 )) $(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.url_issued' AND entity_id=$A1 AND actor_user_id=601 AND metadata->>'viewerIsAuthor'='true'")"
if [ -n "$S3_CTL" ]; then
  expect POST "$(base "$RMAIN")/$A1/download-url" patient "$P501" 'download-url, for the expiry probe' 200 "$DL_SHAPE"
  s3 '__clock?offsetSeconds=75' >/dev/null
  check_value download 'the URL stops working after its 60 s (stand-in clock moved 75 s forward): 403' 403 "$(curl -sS -o /dev/null -w '%{http_code}' "$(js 'b.data.url')")"
  s3 '__clock?offsetSeconds=0' >/dev/null
else skip_note 'presigned-URL expiry probe skipped (FAKE_S3_URL not set)'; fi
expect DELETE "$(base "$RMAIN")/$A1" doctor "$D601" 'delete before the lock: soft delete, 204 and an empty body' 204
RID_R="$(cat "$TMP/rid")"
check_value db 'the row is soft-deleted (deleted_at set), the object is kept (RA-D4)' "1 true" "$(sql "SELECT count(*) FROM record_attachments WHERE id=$A1 AND deleted_at IS NOT NULL") $(if [ -n "$S3_CTL" ]; then [ "$(s3 '__count?prefix=record-attachments/')" = 1 ] && echo true || echo false; else echo true; fi)"
check_value audit 'one attachment.removed row (author, request id, metadata recordId only)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.removed' AND entity_id=$A1 AND actor_user_id=601 AND request_id='$RID_R' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k)=ARRAY['recordId']")"
expect GET "/api/records/$RMAIN" patient "$P501" 'the deleted attachment is no longer listed' 200 'b.data.attachments.length===0'
expect POST "$(base "$RMAIN")/$A1/download-url" patient "$P501" 'download-url of a deleted attachment' '404 NotFound'
expect POST "$(base "$RMAIN")/$A1/download-url" doctor "$D601" 'download-url of a deleted attachment (author)' '404 NotFound'
expect DELETE "$(base "$RMAIN")/$A1" doctor "$D601" 'second delete of the same attachment' '404 NotFound'
# detected type wins over the declared one and the file name
mkintent "$RMAIN" "$D601"; J1="$INTENT_ID"
check_value upload 'a JPEG named scan.pdf, declared application/pdf, is accepted by the storage policy' 204 "$(post_object "$TMP/pic.jpg" scan.pdf application/pdf)"
expect POST "$(base "$RMAIN")/uploads/$J1/complete" doctor "$D601" 'complete: detected image/jpeg, not the declared type or the name' 201 "$ATT_SHAPE&&b.data.fileType==='image/jpeg'&&b.data.description===null&&b.data.sizeBytes===$(wc -c < "$TMP/pic.jpg" | tr -d ' ')"
mkintent "$RMAIN" "$D601"; J2="$INTENT_ID"
check_value upload 'a PNG named notes.txt, declared text/plain, is accepted by the storage policy' 204 "$(post_object "$TMP/pic.png" notes.txt text/plain)"
expect POST "$(base "$RMAIN")/uploads/$J2/complete" doctor "$D601" 'complete: detected image/png' 201 "$ATT_SHAPE&&b.data.fileType==='image/png'"
mkintent "$RMAIN" "$D601"; J3="$INTENT_ID"
check_value upload 'a file of exactly 10 485 760 bytes is accepted by the storage policy' 204 "$(post_object "$TMP/max.pdf")"
expect POST "$(base "$RMAIN")/uploads/$J3/complete" doctor "$D601" 'complete at the 10 MB boundary: accepted, size is the HEAD size' 201 "$ATT_SHAPE&&b.data.sizeBytes===10485760&&b.data.fileType==='application/pdf'"
check_value db 'three more live attachments (jpeg, png, 10 MB pdf), types are the detected ones' "3 image/jpeg,image/png,application/pdf" "$(att_live "$RMAIN") $(sql "SELECT string_agg(file_type, ',' ORDER BY id) FROM record_attachments WHERE medical_record_id=$RMAIN AND deleted_at IS NULL")"
# leave one clean attachment for the matrix below; drop the three boundary ones (still before the lock)
for a in $(sql "SELECT id FROM record_attachments WHERE medical_record_id=$RMAIN AND deleted_at IS NULL"); do expect DELETE "$(base "$RMAIN")/$a" doctor "$D601" "cleanup delete of attachment $a" 204; done
addatt "$RMAIN" "$D601" "$TMP/doc.pdf" "{\"description\":\"$DM\"}"; ATTM="$ATT"
addatt "$ROTH" "$D601" "$TMP/doc.pdf"; ATTO="$ATT"
addatt "$R603" "$D603" "$TMP/doc.pdf" "{\"description\":\"$DM\"}"; A603="$ATT"
# an open uploaded intent of doctor 603 for the suspended-author case, and an open uploaded intent of 601 for the foreign-intent matrix
mkintent "$R603" "$D603"; I603="$INTENT_ID"; check_value upload 'fixture upload for the suspended-author intent' 204 "$(post_object "$TMP/doc.pdf")"
mkintent "$RMAIN" "$D601"; IOPEN="$INTENT_ID"; check_value upload 'fixture upload for the foreign-intent matrix' 204 "$(post_object "$TMP/doc.pdf")"

# ---- 5. Body / id rules and the RBAC matrix ----
tokens
expect POST "$(base "$RMAIN")/uploads/$IOPEN/complete" doctor "$D601" 'complete with a JSON body (the route takes none)' '400 ValidationFailed' 'b.error.details.length>0' '{"a":1}'
expect POST "$(base "$RMAIN")/$ATTM/download-url" doctor "$D601" 'download-url with a JSON body' '400 ValidationFailed' '' '{"a":1}'
expect DELETE "$(base "$RMAIN")/$ATTM" doctor "$D601" 'delete with a JSON body' '400 ValidationFailed' '' '{"a":1}'
check_value body 'the body rejections changed nothing: the intent is open, the attachment live' "false - 1" "$(intent_state "$IOPEN") $(sql "SELECT count(*) FROM record_attachments WHERE id=$ATTM AND deleted_at IS NULL")"
for bad in abc 0 -1 1.5 99999999999999999999; do
  expect POST "$(base "$bad")/uploads" doctor "$D601" "intent with bad record id [$bad]" '404 NotFound' '' '{}'
  expect POST "$(base "$RMAIN")/uploads/$bad/complete" doctor "$D601" "complete with bad upload id [$bad]" '404 NotFound'
  expect POST "$(base "$RMAIN")/$bad/download-url" patient "$P501" "download-url with bad attachment id [$bad]" '404 NotFound'
  expect DELETE "$(base "$RMAIN")/$bad" doctor "$D601" "delete with bad attachment id [$bad]" '404 NotFound'
  expect POST "$(base "$bad")/$ATTM/download-url" patient "$P501" "download-url with bad record id [$bad]" '404 NotFound'
done
expect DELETE "$(base "$RMAIN")/uploads" doctor "$D601" 'DELETE .../attachments/uploads reaches the delete route with attachmentId "uploads": 404' '404 NotFound'
# download-url
expect POST "$(base "$RMAIN")/$ATTM/download-url" patient "$P501" 'download-url: owning patient' 200 "$DL_SHAPE"
expect POST "$(base "$RMAIN")/$ATTM/download-url" doctor "$D601" 'download-url: author' 200 "$DL_SHAPE"
expect POST "$(base "$RMAIN")/$ATTM/download-url" doctor-related "$D602" 'download-url: doctor with a booked relationship to the patient' 200 "$DL_SHAPE"
expect POST "$(base "$RMAIN")/$ATTM/download-url" patient-other "$P502" 'download-url: another patient' '404 NotFound'
expect POST "$(base "$RMAIN")/$ATTM/download-url" doctor-unrelated "$D604" 'download-url: unrelated doctor' '404 NotFound'
expect POST "$(base "$RMAIN")/$ATTM/download-url" doctor-cancelled-only "$D606" 'download-url: doctor whose rows with the patient are cancelled / no_show only' '404 NotFound'
expect POST "$(base "$RMAIN")/$ATTM/download-url" admin "$ADMIN" 'download-url: admin (existing attachment)' '403 Forbidden'
expect POST "$(base "$RMAIN")/$NOBODY/download-url" patient "$P501" 'download-url: unknown attachment id' '404 NotFound'
expect POST "$(base "$NOBODY")/$ATTM/download-url" patient "$P501" 'download-url: unknown record id' '404 NotFound'
expect POST "$(base "$ROTH")/$ATTM/download-url" doctor "$D601" 'download-url: attachment of ANOTHER record under this record path (author of both)' '404 NotFound'
expect POST "$(base "$ROTH")/$ATTM/download-url" patient-other "$P502" 'download-url: attachment of another record under the patient-owned record path' '404 NotFound'
expect POST "$(base "$RMAIN")/$ATTO/download-url" doctor "$D601" 'download-url: the other record attachment under this record path' '404 NotFound'
expect POST "$(base "$RMAIN")/$ATTM/download-url" patient-spoof "$P502" 'download-url: spoofed X-User-Id does not widen access' '404 NotFound' '' '' '' 'X-User-Id: 501'
# intent
expect POST "$(base "$RMAIN")/uploads" doctor-related "$D602" 'intent: related (not author) doctor' '404 NotFound' '' '{}'
expect POST "$(base "$RMAIN")/uploads" doctor-unrelated "$D604" 'intent: unrelated doctor' '404 NotFound' '' '{}'
expect POST "$(base "$RMAIN")/uploads" doctor-cancelled-only "$D606" 'intent: cancelled / no_show-only doctor' '404 NotFound' '' '{}'
expect POST "$(base "$NOBODY")/uploads" doctor "$D601" 'intent: unknown record' '404 NotFound' '' '{}'
expect POST "$(base "$R603")/uploads" doctor "$D601" 'intent: the author of ANOTHER record is not the author of this one' '404 NotFound' '' '{}'
# complete
expect POST "$(base "$RMAIN")/uploads/$IOPEN/complete" doctor-related "$D602" 'complete: related doctor with the author intent id' '404 NotFound'
expect POST "$(base "$RMAIN")/uploads/$IOPEN/complete" doctor-unrelated "$D604" 'complete: unrelated doctor' '404 NotFound'
expect POST "$(base "$RMAIN")/uploads/$IOPEN/complete" doctor-cancelled-only "$D606" 'complete: cancelled / no_show-only doctor' '404 NotFound'
expect POST "$(base "$RMAIN")/uploads/$IOPEN/complete" doctor-603 "$D603" "complete: another author doctor on this record path (resolver)" '404 NotFound'
expect POST "$(base "$R603")/uploads/$IOPEN/complete" doctor "$D601" 'complete: the intent id of record 1 on a record 601 does not author (resolver)' '404 NotFound'
expect POST "$(base "$RMAIN")/uploads/$I603/complete" doctor "$D601" "complete: ANOTHER doctor's intent (owner mismatch)" '404 NotFound'
expect POST "$(base "$ROTH")/uploads/$IOPEN/complete" doctor "$D601" "complete: the intent of ANOTHER record (author of both): target mismatch" '404 NotFound'
IKIND="$(sql "INSERT INTO upload_intents (kind,target_id,owner_user_id,document_type,description,quarantine_key,max_bytes,expires_at) VALUES ('verification_document',(SELECT id FROM doctor_profiles WHERE user_id=601),601,'license',NULL,'quarantine/'||gen_random_uuid(),10485760,now()+interval '10 minutes') RETURNING id" | head -1)"
expect POST "$(base "$RMAIN")/uploads/$IKIND/complete" doctor "$D601" 'complete: an intent of ANOTHER kind (verification_document) owned by the caller' '404 NotFound'
expect POST "$(base "$RMAIN")/uploads/$NOBODY/complete" doctor "$D601" 'complete: unknown upload id' '404 NotFound'
check_value complete 'every foreign / other-record / other-kind attempt left the intents open and created no attachment' "false - false - 1" "$(intent_state "$IOPEN") $(intent_state "$I603") $(att_live "$RMAIN")"
# delete
expect DELETE "$(base "$RMAIN")/$ATTM" doctor-related "$D602" 'delete: related doctor' '404 NotFound'
expect DELETE "$(base "$RMAIN")/$ATTM" doctor-unrelated "$D604" 'delete: unrelated doctor' '404 NotFound'
expect DELETE "$(base "$RMAIN")/$ATTM" doctor-cancelled-only "$D606" 'delete: cancelled / no_show-only doctor' '404 NotFound'
expect DELETE "$(base "$NOBODY")/$ATTM" doctor "$D601" 'delete: unknown record' '404 NotFound'
expect DELETE "$(base "$RMAIN")/$NOBODY" doctor "$D601" 'delete: unknown attachment' '404 NotFound'
expect DELETE "$(base "$RMAIN")/$ATTO" doctor "$D601" 'delete: an attachment of ANOTHER record under this path' '404 NotFound'
expect DELETE "$(base "$ROTH")/$ATTM" doctor "$D601" 'delete: this record attachment under another record path' '404 NotFound'
expect DELETE "$(base "$RMAIN")/$ATTM" doctor-spoof "$D602" 'delete: spoofed X-User-Id / X-Role are ignored' '404 NotFound' '' '' '' 'X-Role: doctor'
check_value rbac 'no denied write changed an attachment; the main attachment is still live and its row unchanged' "1" "$(sql "SELECT count(*) FROM record_attachments WHERE id=$ATTM AND deleted_at IS NULL")"
NAD=0
for spec in "POST|$(base "$RMAIN")/uploads|{}" "POST|$(base "$RMAIN")/uploads/$IOPEN/complete|" "DELETE|$(base "$RMAIN")/$ATTM|"; do
  IFS='|' read -r m p b <<< "$spec"; call "$m" "$p" "$D602" "$b" >/dev/null; NAD=$((NAD + $(grep -c NotAssignedDoctor "$TMP/body" || true)))
done
check_value rbac 'NotAssignedDoctor never appears: spot check of the related doctor on every write route' 0 "$NAD"

# ---- 6. Complete: stored-object verification, intent lifecycle, storage faults ----
tokens
RB_BEFORE="$(att_live "$RMAIN")"
# false bytes behind a .pdf name
qn() { if [ -n "$S3_CTL" ]; then s3 '__count?prefix=quarantine/'; else echo n/a; fi; }
mkintent "$RMAIN" "$D601"; IF="$INTENT_ID"; QN0="$(qn)"
check_value upload 'plain text named evil.pdf, declared application/pdf: the storage policy accepts it (it does not read bytes)' 204 "$(post_object "$TMP/fake.pdf" evil.pdf application/pdf)"
expect POST "$(base "$RMAIN")/uploads/$IF/complete" doctor "$D601" 'complete: false bytes behind a .pdf name are rejected' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="file")'
check_value db 'no row, intent closed without a result' "$RB_BEFORE true -" "$(att_live "$RMAIN") $(intent_state "$IF")"
[ -z "$S3_CTL" ] || check_value storage 'the rejected object was deleted from quarantine (count back to its value before the upload)' "$QN0" "$(qn)"
expect POST "$(base "$RMAIN")/uploads/$IF/complete" doctor "$D601" 'complete: replaying the closed (rejected) intent' '409 Conflict'
# nothing was uploaded
mkintent "$RMAIN" "$D601"; IM="$INTENT_ID"
expect POST "$(base "$RMAIN")/uploads/$IM/complete" doctor "$D601" 'complete: no object was uploaded' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="file")'
check_value db 'the missing-object intent is closed without a result, no row' "$RB_BEFORE true -" "$(att_live "$RMAIN") $(intent_state "$IM")"
# oversize and empty are refused by the storage policy itself
mkintent "$RMAIN" "$D601"; IBIG="$INTENT_ID"; QN0="$(qn)"
check_value upload 'a file of 10 485 761 bytes is refused by the presigned POST policy (content-length-range): 400' 400 "$(post_object "$TMP/over.pdf")"
check_value upload 'a 0-byte file is refused by the presigned POST policy (content-length-range): 400' 400 "$(post_object "$TMP/empty.bin")"
[ -z "$S3_CTL" ] || check_value storage 'neither refused upload left an object (quarantine count unchanged)' "$QN0" "$(qn)"
expect POST "$(base "$RMAIN")/uploads/$IBIG/complete" doctor "$D601" 'complete: after a refused (oversize / empty) upload there is no object' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="file")'
# a tampered key is refused by the policy (exact key condition)
mkintent "$RMAIN" "$D601"; IKEY="$INTENT_ID"
check_value upload 'a POST with a different key than the policy allows is refused (403)' 403 "$(POST_KEY_OVERRIDE="quarantine/$(uuid)" post_object "$TMP/doc.pdf")"
expect POST "$(base "$RMAIN")/uploads/$IKEY/complete" doctor "$D601" 'complete: the tampered upload stored nothing under the intent key' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="file")'
if [ -n "$S3_CTL" ]; then
  # the POST policy expires after UPLOAD_POLICY_TTL_SECONDS (300 s), earlier than the 15 minute intent
  mkintent "$RMAIN" "$D601"; IPOL="$INTENT_ID"
  s3 '__clock?offsetSeconds=400' >/dev/null
  check_value upload 'a POST after the policy expiry (stand-in clock +400 s, intent still open) is refused: 403' 403 "$(post_object "$TMP/doc.pdf")"
  s3 '__clock?offsetSeconds=0' >/dev/null
  expect POST "$(base "$RMAIN")/uploads/$IPOL/complete" doctor "$D601" 'complete: nothing stored after the expired policy' '400 ValidationFailed' 'b.error.details.some(d=>d.field==="file")'
else skip_note 'policy-expiry probe skipped (FAKE_S3_URL not set)'; fi
check_value db 'none of the failed completes created an attachment' "$RB_BEFORE" "$(att_live "$RMAIN")"
# expired intent: 410, object deleted, intent closed
mkintent "$RMAIN" "$D601"; IEXP="$INTENT_ID"; QN0="$(qn)"
check_value upload 'upload for the expired-intent case' 204 "$(post_object "$TMP/doc.pdf")"
sql "UPDATE upload_intents SET expires_at = now() - interval '1 minute' WHERE id=$IEXP" >/dev/null
expect POST "$(base "$RMAIN")/uploads/$IEXP/complete" doctor "$D601" 'complete after expires_at: 410' '410 UploadIntentExpired'
check_value db 'the expired intent is closed without a result, no row' "$RB_BEFORE true -" "$(att_live "$RMAIN") $(intent_state "$IEXP")"
[ -z "$S3_CTL" ] || check_value storage 'the expired intent quarantine object was deleted (count back to its value before the upload)' "$QN0" "$(qn)"
expect POST "$(base "$RMAIN")/uploads/$IEXP/complete" doctor "$D601" 'complete: replaying the closed expired intent' '409 Conflict'
# storage faults: a storage error is a 500, the intent stays open and the same complete succeeds afterwards
if [ -n "$S3_CTL" ]; then
  for op in head copy; do
    mkintent "$RMAIN" "$D601"; IFX="$INTENT_ID"
    check_value upload "upload for the $op-fault case" 204 "$(post_object "$TMP/doc.pdf")"
    s3 "__fail?op=$op&n=2" >/dev/null   # n=2: the SDK client retries a 500 once (maxAttempts 2), so both attempts must fail
    expect POST "$(base "$RMAIN")/uploads/$IFX/complete" doctor "$D601" "complete while the storage $op call fails" '500 InternalError'
    check_value db "storage $op fault: no row, intent still open, no audit row" "$RB_BEFORE false -" "$(att_live "$RMAIN") $(intent_state "$IFX")"
    expect POST "$(base "$RMAIN")/uploads/$IFX/complete" doctor "$D601" "the same complete succeeds once storage recovers ($op)" 201 "$ATT_SHAPE"
    expect DELETE "$(base "$RMAIN")/$(js 'b.data.id')" doctor "$D601" "cleanup delete after the $op fault case" 204
  done
else skip_note 'storage fault injection skipped (FAKE_S3_URL not set)'; fi

# ---- 7. Purge: an expired open record_attachment intent is closed and its quarantine object deleted ----
tokens
if [ -n "${CARE_WORKER_PURGE_CMD:-}" ]; then
  mkintent "$RMAIN" "$D601"; IPG="$INTENT_ID"
  check_value upload 'upload for the purge case' 204 "$(post_object "$TMP/doc.pdf")"
  mkintent "$RMAIN" "$D601"; IKEEP="$INTENT_ID"
  Q0=''; [ -z "$S3_CTL" ] || Q0="$(s3 '__count?prefix=quarantine/')"
  sql "UPDATE upload_intents SET expires_at = now() - interval '1 minute' WHERE id=$IPG" >/dev/null
  PURGE_OUT="$(eval "$CARE_WORKER_PURGE_CMD" 2>&1 || true)"
  check_value purge 'care-worker --once upload-intent-purge ran and logged upload_intent_purge_done' 1 "$(printf '%s' "$PURGE_OUT" | grep -c 'upload_intent_purge_done' || true)"
  check_value purge 'the expired record_attachment intent was closed without a result' "true -" "$(intent_state "$IPG")"
  check_value purge 'an unexpired open intent was left open' "false -" "$(intent_state "$IKEEP")"
  if [ -n "$S3_CTL" ]; then check_value purge 'the purge deleted the expired intent quarantine object' "$((Q0 - 1))" "$(s3 '__count?prefix=quarantine/')"; fi
  expect POST "$(base "$RMAIN")/uploads/$IPG/complete" doctor "$D601" 'complete of the purged intent' '409 Conflict'
else skip_note 'purge case skipped: CARE_WORKER_PURGE_CMD not set'; fi

# ---- 8. The cap of 20 live attachments (RCAP) ----
tokens
for n in $(seq 1 19); do addatt "$RCAP" "$D601" "$TMP/doc.pdf"; done
check_value cap '19 live attachments after 19 completes' 19 "$(att_live "$RCAP")"
mkintent "$RCAP" "$D601"; I21="$INTENT_ID"
check_value upload 'the next intent is created at 19 and its file uploaded before the cap is reached' 204 "$(post_object "$TMP/doc.pdf")"
addatt "$RCAP" "$D601" "$TMP/doc.pdf"
expect GET "/api/records/$RCAP" patient "$P501" 'the 20th attachment succeeded: the record lists 20' 200 'b.data.attachments.length===20&&b.data.attachments.every((a,i,l)=>i===0||l[i-1].id<a.id)'
Q_BEFORE=''; [ -z "$S3_CTL" ] || Q_BEFORE="$(s3 '__count?prefix=quarantine/')"
expect POST "$(base "$RCAP")/uploads/$I21/complete" doctor "$D601" 'complete with 20 live: 409 AttachmentLimitReached' '409 AttachmentLimitReached'
check_value cap 'the refused complete left 20 rows, the intent open and (courtesy pre-check) the quarantine object intact' "20 false -" "$(att_live "$RCAP") $(intent_state "$I21")"
if [ -n "$S3_CTL" ]; then check_value storage 'the quarantine object is still there' "$Q_BEFORE" "$(s3 '__count?prefix=quarantine/')"; fi
expect POST "$(base "$RCAP")/uploads" doctor "$D601" 'a 21st intent: 409 AttachmentLimitReached' '409 AttachmentLimitReached' '' '{}'
FIRST="$(sql "SELECT min(id) FROM record_attachments WHERE medical_record_id=$RCAP AND deleted_at IS NULL")"
expect DELETE "$(base "$RCAP")/$FIRST" doctor "$D601" 'delete one attachment frees a slot' 204
expect POST "$(base "$RCAP")/uploads/$I21/complete" doctor "$D601" 'the SAME intent now completes (the doctor deleted one and retried)' 201 "$ATT_SHAPE"
check_value cap 'back at 20 live, intent consumed' "20 true" "$(att_live "$RCAP") $(intent_state "$I21" | cut -d' ' -f1)"
# two concurrent completes at 19: exactly one 201, one 409
expect DELETE "$(base "$RCAP")/$(sql "SELECT min(id) FROM record_attachments WHERE medical_record_id=$RCAP AND deleted_at IS NULL")" doctor "$D601" 'delete one more (19 live) for the concurrency case' 204
mkintent "$RCAP" "$D601"; CA="$INTENT_ID"; check_value upload 'upload A' 204 "$(post_object "$TMP/doc.pdf")"
mkintent "$RCAP" "$D601"; CB="$INTENT_ID"; check_value upload 'upload B' 204 "$(post_object "$TMP/doc.pdf")"
flush_redis
pcall a POST "$(base "$RCAP")/uploads/$CA/complete" "$D601" & pcall b POST "$(base "$RCAP")/uploads/$CB/complete" "$D601" & wait
check_value concurrency 'two simultaneous completes at 19 live: exactly one 201 and one 409' '201 409 ' "$(printf '%s\n' "$(pstat a)" "$(pstat b)" | sort | tr '\n' ' ')"
LOSER=$( [ "$(pstat a)" = 409 ] && pcode a || pcode b )
check_value concurrency 'the loser answers AttachmentLimitReached; the record holds exactly 20 live attachments' "AttachmentLimitReached 20" "$LOSER $(att_live "$RCAP")"
check_value cap 'the 20-attachment record never exceeded 20: attachment.added rows minus the soft-deleted rows equal 20 live' "20" "$(( $(sql "SELECT count(*) FROM audit_logs a JOIN record_attachments r ON r.id=a.entity_id WHERE a.created_at >= '$T0' AND a.action='attachment.added' AND r.medical_record_id=$RCAP") - $(sql "SELECT count(*) FROM record_attachments WHERE medical_record_id=$RCAP AND deleted_at IS NOT NULL") ))"

# ---- 9. The 24 h lock boundary (RLOCK): add allowed before and after, delete only before ----
tokens
lock_in "$RLOCK" 150
H0="$(rowhash "$RLOCK")"
addatt "$RLOCK" "$D601" "$TMP/doc.pdf" "{\"description\":\"$DR\"}"; AL1="$ATT"
check_value lock 'add before the lock: afterLock false, and the medical_records row is byte-for-byte unchanged' "false $H0" "$(sql "SELECT metadata->>'afterLock' FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.added' AND entity_id=$AL1") $(rowhash "$RLOCK")"
expect DELETE "$(base "$RLOCK")/$AL1" doctor "$D601" 'delete before the lock (about 2 minutes ahead): 204' 204
addatt "$RLOCK" "$D601" "$TMP/doc.pdf"; AL2="$ATT"
lock_in "$RLOCK" -3
H1="$(rowhash "$RLOCK")"
addatt "$RLOCK" "$D601" "$TMP/doc.pdf" "{\"description\":\"$DR\"}"; AL3="$ATT"
check_value lock 'add AFTER the lock is allowed: afterLock true (database time), medical_records row byte-for-byte unchanged' "true $H1" "$(sql "SELECT metadata->>'afterLock' FROM audit_logs WHERE created_at >= '$T0' AND action='attachment.added' AND entity_id=$AL3") $(rowhash "$RLOCK")"
expect GET "/api/records/$RLOCK" patient "$P501" 'the locked record lists the attachment added after the lock' 200 "b.data.isLocked===true&&b.data.attachments.map(a=>a.id).join()==='$AL2,$AL3'"
HA2="$(rowhash_att "$AL2")"
expect DELETE "$(base "$RLOCK")/$AL2" doctor "$D601" 'delete AFTER the lock: 409 RecordLocked' '409 RecordLocked'
check_value lock 'the refused delete left the attachment live and unchanged, wrote no audit row' "$HA2 0" "$(rowhash_att "$AL2") $(aud attachment.removed "$AL2")"
expect DELETE "$(base "$RLOCK")/$AL1" doctor "$D601" 'locked record, attachment already deleted before the lock: 404 beats 409' '404 NotFound'
expect DELETE "$(base "$RLOCK")/$NOBODY" doctor "$D601" 'locked record, absent attachment: 404 beats 409' '404 NotFound'
expect DELETE "$(base "$RLOCK")/$ATTM" doctor "$D601" 'locked record, attachment of another record: 404 beats 409' '404 NotFound'
expect POST "$(base "$RLOCK")/$AL2/download-url" patient "$P501" 'download-url still works on a locked record' 200 "$DL_SHAPE"
expect POST "$(base "$RLOCK")/$AL2/download-url" doctor-related "$D602" 'download-url on a locked record by a related doctor' 200 "$DL_SHAPE"
expect DELETE "$(base "$RLOCK")/$AL2" admin "$ADMIN" 'admin delete on a locked record: still 403' '403 Forbidden'
if [ -n "${CARE_APP_DATABASE_URL:-}" ]; then
  check_value db 'care_app soft delete of an attachment of a LOCKED record raises check_violation (23514) from the trigger' "1 1" "$(asappv "UPDATE record_attachments SET deleted_at=now() WHERE id=$AL2" | grep -c '23514') $(asappv "UPDATE record_attachments SET deleted_at=now() WHERE id=$AL2" | grep -c 'is locked')"
  check_value db 'the trigger names itself as the violated constraint' 1 "$(asappv "UPDATE record_attachments SET deleted_at=now() WHERE id=$AL2" | grep -c 'trg_record_attachments_forbid_delete_after_lock')"
  check_value db 'the owner is refused too (the trigger fires for every role)' 1 "$(psql "$CARE_OWNER_DATABASE_URL" -XAt -c "UPDATE record_attachments SET deleted_at=now() WHERE id=$AL2" 2>&1 | grep -c 'is locked')"
  check_value db 'the refused direct updates left the row unchanged' "$HA2" "$(rowhash_att "$AL2")"
  for col in description object_key file_type size_bytes uploaded_by_user_id medical_record_id created_at id; do
    check_value db "care_app UPDATE of record_attachments.$col is permission denied (SQLSTATE 42501)" 1 "$(asappv "UPDATE record_attachments SET $col = $col WHERE id=$AL2" | grep -c '42501')"
  done
  check_value db 'care_app has no DELETE and no TRUNCATE on record_attachments' "1 1" "$(asapp "DELETE FROM record_attachments WHERE id=$AL2" | grep -c 'permission denied') $(asapp "TRUNCATE record_attachments" | grep -c 'permission denied')"
  check_value db 'care_app cannot set id / created_at / deleted_at on INSERT (column-level grant)' "3" "$(for c in id created_at deleted_at; do asappv "INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, $c) VALUES ($RLOCK, 601, 'x', 'application/pdf', 1, $( [ $c = id ] && echo 999999 || echo 'now()' ))" | grep -c '42501'; done | awk '{s+=$1} END{print s+0}')"
  check_value db 'the file-type CHECK refuses a type outside PDF / JPEG / PNG' 1 "$(asapp "INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes) VALUES ($RLOCK, 601, 'qa/x1', 'text/plain', 1)" | grep -c 'chk_record_attachments_file_type')"
  check_value db 'the size CHECK refuses 0 and 10 485 761 bytes' "2" "$(for s in 0 10485761; do asapp "INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes) VALUES ($RLOCK, 601, 'qa/x2$s', 'application/pdf', $s)" | grep -c 'chk_record_attachments_size'; done | awk '{s+=$1} END{print s+0}')"
  check_value db 'the description CHECK refuses a blank description' 1 "$(asapp "INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description) VALUES ($RLOCK, 601, 'qa/x3', 'application/pdf', 1, '   ')" | grep -c 'chk_record_attachments_description')"
  check_value db 'a dangling record id is refused by the foreign key' 1 "$(asapp "INSERT INTO record_attachments (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes) VALUES ($NOBODY, 601, 'qa/x4', 'application/pdf', 1)" | grep -c 'fk_record_attachments_medical_record_id')"
  check_value db 'the owner cannot DELETE the parent medical record while attachments exist (ON DELETE RESTRICT)' 1 "$(psql "$CARE_OWNER_DATABASE_URL" -XAt -c "DELETE FROM medical_records WHERE id=$RLOCK" 2>&1 | grep -c 'fk_record_attachments_medical_record_id')"
  check_value db 'care_app privileges: UPDATE on deleted_at only; INSERT on exactly the six columns; SELECT yes; no table-level UPDATE / DELETE' "deleted_at|description,file_type,medical_record_id,object_key,size_bytes,uploaded_by_user_id|true|false|false" "$(sql "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.column_privileges WHERE grantee='vcare_app' AND table_schema='public' AND table_name='record_attachments' AND privilege_type='UPDATE'")|$(sql "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.column_privileges WHERE grantee='vcare_app' AND table_schema='public' AND table_name='record_attachments' AND privilege_type='INSERT'")|$(sql "SELECT has_table_privilege('vcare_app','record_attachments','SELECT')::text")|$(sql "SELECT has_table_privilege('vcare_app','record_attachments','UPDATE')::text")|$(sql "SELECT has_table_privilege('vcare_app','record_attachments','DELETE')::text")"
  # positive control: the trigger allows a pre-lock soft delete (an attachment of the OPEN record ROTH, created for this probe)
  addatt "$ROTH" "$D601" "$TMP/doc.pdf"; ADIR="$ATT"
  check_value db 'control: care_app soft delete of an attachment of an OPEN record is allowed by the trigger' 1 "$(asappv "UPDATE record_attachments SET deleted_at=now() WHERE id=$ADIR" | grep -c '^UPDATE 1')"
  DIRECT_DELETES=1
else
  skip_note 'direct care_app grant / trigger / constraint checks skipped: CARE_APP_DATABASE_URL not set'; DIRECT_DELETES=0
fi

# ---- 10. Suspended author (token says active; Care suspended_at wins) ----
tokens
sql "UPDATE doctor_profiles SET suspended_at=now(), suspension_reason='synthetic' WHERE user_id=603" >/dev/null
expect POST "$(base "$R603")/uploads" doctor-suspended "$D603" 'intent by a locally suspended author' '403 Forbidden' '' '{}'
expect POST "$(base "$R603")/uploads/$I603/complete" doctor-suspended "$D603" 'complete by a locally suspended author' '403 Forbidden'
expect DELETE "$(base "$R603")/$A603" doctor-suspended "$D603" 'delete by a locally suspended author' '403 Forbidden'
expect POST "$(base "$R603")/$A603/download-url" doctor-suspended "$D603" 'download-url of own attachment by a locally suspended author: 404' '404 NotFound'
expect POST "$(base "$R603")/$A603/download-url" patient "$P501" 'the patient still opens the suspended author file' 200 "$DL_SHAPE"
expect POST "$(base "$R603")/$A603/download-url" doctor-related "$D602" 'another consulted doctor still opens the suspended author file' 200 "$DL_SHAPE"
expect POST "$(base "$R603")/$A603/download-url" doctor "$D601" 'the assigned doctor of the patient opens it too' 200 "$DL_SHAPE"
check_value suspended 'the suspended-author calls changed nothing: attachment live, intent open' "1 false -" "$(att_live "$R603") $(intent_state "$I603")"
sql "UPDATE doctor_profiles SET suspended_at=NULL, suspension_reason=NULL WHERE user_id=603" >/dev/null
expect POST "$(base "$R603")/uploads/$I603/complete" doctor-603 "$D603" 'after reinstatement the same intent completes (control)' 201 "$ATT_SHAPE"

# ---- 11. Idempotency-Key is not honoured; nothing sensitive in Redis ----
tokens
IK="$(uuid)"
flush_redis
export NO_FLUSH=1
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'intent with an Idempotency-Key' 201 "$INTENT_SHAPE" "{\"description\":\"$DR\"}" "$IK"
K1="$(js 'b.data.uploadId')"
expect POST "$(base "$RMAIN")/uploads" doctor "$D601" 'same Idempotency-Key, different body: processed again, no 422, a different intent' 201 "$INTENT_SHAPE&&b.data.uploadId!==$K1" '{"description":"another"}' "$IK"
expect POST "$(base "$RMAIN")/$ATTM/download-url" patient "$P501" 'download-url with an Idempotency-Key' 200 "$DL_SHAPE" '' "$IK"
expect POST "$(base "$RMAIN")/$ATTM/download-url" patient "$P501" 'same key again: a second issuance, not a replay' 200 "$DL_SHAPE" '' "$IK"
unset NO_FLUSH
REDIS_HITS="$(node -e '
const R=require("ioredis");const r=new R(process.env.REDIS_URL);
(async()=>{const keys=await r.keys("*");let hits=0,idem=0;const marks=[...process.env.QA_MARKERS.split(","),"9013"];
for(const k of keys){let v="";const t=await r.type(k);
 if(t==="string")v=await r.get(k);else if(t==="hash")v=JSON.stringify(await r.hgetall(k));else if(t==="list")v=JSON.stringify(await r.lrange(k,0,-1));
 else if(t==="set")v=JSON.stringify(await r.smembers(k));else if(t==="zset")v=JSON.stringify(await r.zrange(k,0,-1));
 if(marks.some(m=>(k+v).includes(m)))hits++; if(/idem/i.test(k))idem++;}
process.stdout.write(hits+" "+idem+" "+(keys.length>0?"keys":"nokeys"));await r.quit();})();')"
check_value redis 'no marker, storage key, signed-URL parameter or storage host in any Redis key or value; no idempotency key stored; Redis had keys to scan' "0 0 keys" "$REDIS_HITS"

# ---- 12. Rate limits (RA-D9): intents 20/h, complete + delete 20/min (one bucket), download-url 120/min, per user ----
tokens
flush_redis
IB="$(burst 20 POST "$(base "$RRL")/uploads" "$D601" '{}')"
check_value ratelimit 'intent bucket: 20 intents in the hour all succeed' '201 x20;' "$IB"
NO_FLUSH=1 expect POST "$(base "$RRL")/uploads" doctor "$D601" 'the 21st intent is limited' '429 RateLimited' '' '{}'
check_value ratelimit 'the 429 carries Retry-After and no-store' "1 1" "$(grep -qi '^retry-after:' "$TMP/headers" && echo 1 || echo 0) $(grep -qi '^cache-control:.*no-store' "$TMP/headers" && echo 1 || echo 0)"
check_value ratelimit 'the limited intent created no row (20 open intents for the rate-limit record)' 20 "$(sql "select count(*) from upload_intents where kind='record_attachment' and target_id=$RRL")"
NO_FLUSH=1 expect POST "$(base "$R603")/uploads" doctor-603 "$D603" 'the intent bucket is per user: another author is not limited' 201 "$INTENT_SHAPE" '{}'
NO_FLUSH=1 expect POST "$(base "$RRL")/$ATTM/download-url" patient "$P501" 'the read bucket is independent of the intent bucket' '404 NotFound'
NO_FLUSH=1 expect POST "$(base "$RMAIN")/uploads" doctor-related "$D602" 'a denied (404) call by another user consumed none of the author budget and is not limited' '404 NotFound' '' '{}'
flush_redis
WB="$(burst 20 DELETE "$(base "$RRL")/$NOBODY" "$D601")"
check_value ratelimit 'write bucket: 20 deletes of an absent attachment in a minute all answer 404 (budget consumed after authorize)' '404 x20;' "$WB"
NO_FLUSH=1 expect DELETE "$(base "$RRL")/$NOBODY" doctor "$D601" 'the 21st write (a delete) is limited' '429 RateLimited'
NO_FLUSH=1 expect POST "$(base "$RRL")/uploads/$NOBODY/complete" doctor "$D601" 'complete shares the write bucket: limited too' '429 RateLimited'
NO_FLUSH=1 expect POST "$(base "$RMAIN")/$ATTM/download-url" doctor "$D601" 'the read bucket is independent: the same doctor can still request a URL' 200 "$DL_SHAPE"
NO_FLUSH=1 expect DELETE "$(base "$RRL")/$NOBODY" admin "$ADMIN" 'admin is denied at the role step and consumes no budget (403, not 429)' '403 Forbidden'
flush_redis
U0="$(aud attachment.url_issued)"
RB1="$(burst 120 POST "$(base "$RMAIN")/$ATTM/download-url" "$P501")"
check_value ratelimit 'read bucket: 120 download-url calls in a minute all succeed' '200 x120;' "$RB1"
NO_FLUSH=1 expect POST "$(base "$RMAIN")/$ATTM/download-url" patient "$P501" 'the 121st download-url is limited' '429 RateLimited'
check_value ratelimit 'one audit row per issued URL: 120 rows for 120 URLs, none for the limited call' 120 "$(( $(aud attachment.url_issued) - U0 ))"
flush_redis

# ---- 13. Hygiene: audit rows, clinical-free metadata, server log ----
tokens
check_value audit 'every attachment audit row has only flat scalar metadata keys from the allowlist' 0 "$(sql "SELECT count(*) FROM audit_logs a, jsonb_object_keys(a.metadata) k WHERE a.created_at >= '$T0' AND a.action IN ('attachment.added','attachment.removed','attachment.url_issued') AND k NOT IN ('recordId','fileType','sizeBytes','afterLock','viewerRole','viewerIsAuthor')")"
check_value audit 'no audit row holds a marker, an object key, a quarantine key or a URL' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND (metadata::text LIKE '%QA-ATT-%' OR metadata::text LIKE '%record-attachments/%' OR metadata::text LIKE '%quarantine/%' OR metadata::text LIKE '%http%' OR metadata::text LIKE '%X-Amz%')")"
check_value audit 'attachment audit rows are attributed to doctors and patients only, never to an admin' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action IN ('attachment.added','attachment.removed','attachment.url_issued') AND actor_role NOT IN ('doctor','patient')")"
check_value audit 'attachment.added rows equal the attachments ever created through the API (one per row, none for replays, refusals or rollbacks)' "$(att_all)" "$(aud attachment.added)"
check_value audit 'attachment.removed rows equal the soft-deleted rows (minus the one direct-SQL control)' "$(( $(sql "SELECT count(*) FROM record_attachments WHERE deleted_at IS NOT NULL") - DIRECT_DELETES ))" "$(aud attachment.removed)"
check_value audit 'every audit entity of an attachment action exists as a row (entity ids are real attachment ids)' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action LIKE 'attachment.%' AND entity_id NOT IN (SELECT id FROM record_attachments)")"
expect GET "/api/audit-logs?action=attachment.url_issued&limit=100" admin "$ADMIN" 'admin reads the attachment audit rows (metadata only)' 200 'b.data.length>0&&!JSON.stringify(b).includes("QA-ATT-")&&!/record-attachments\/|quarantine\/|X-Amz|https?:\/\//.test(JSON.stringify(b))'
if [ -n "${SERVER_LOG:-}" ]; then
  LOG_TAIL="$TMP/server.tail"; tail -n +$((LOG_MARK+1)) "$SERVER_LOG" > "$LOG_TAIL"
  check_value log 'captured log is non-trivial' 1 "$([ "$(wc -l < "$LOG_TAIL")" -gt 20 ] && echo 1 || echo 0)"
  for needle in "$CH" "$D1" "$DM" "$DF" "$DR" 'QA-ATT-' 'quarantine/' 'record-attachments/' 'X-Amz' '127.0.0.1:9013' 'Bearer ' 'eyJhbGciOiJFZERTQS'; do
    check_value log "no '$needle' in the server log" 0 "$(grep -cF -- "$needle" "$LOG_TAIL" || true)"
  done
  check_value log 'no 5xx request_completed line in the captured log other than the two injected storage faults' "$([ -n "$S3_CTL" ] && echo 2 || echo 0)" "$(grep -cE '"message":"request_completed".*"status":5[0-9][0-9]' "$LOG_TAIL" || true)"
else
  skip_note 'log hygiene skipped: SERVER_LOG not set'
fi

echo "RESULT: $PASS pass / $FAIL fail ($SKIP skipped checks)"
[ "$FAIL" = 0 ]
