#!/usr/bin/env bash
# Repeatable HTTP QA for the `verification` module of care-service (docs/verification/manual-qa.md).
#
# Drives every verification route with CURL against a RUNNING stack and compares status, error.code, response shape,
# X-Request-Id echo and Cache-Control: no-store with contracts/openapi.yaml and docs/verification/spec.md.
#
# Stack the script assumes (nothing is started here):
#   * Identity public listener (IDENTITY_URL, default http://localhost:3000) migrated, with its own Postgres
#     (IDENTITY_DATABASE_URL) - users are created by SQL inserts (synthetic @example.test emails, per-run password) and
#     tokens come from POST /api/auth/login. Needs node + the argon2 package from the identity repo (IDENTITY_REPO).
#   * Care API (CARE_URL, default http://localhost:3001) AND a care-worker process running against MinIO
#     (docker compose up -d minio minio-setup) and a Care database whose OWNER url is CARE_OWNER_DATABASE_URL
#     (read-only SELECTs plus one UPDATE that expires an upload intent).
#   * Care's IDENTITY_INTERNAL_URL must reach an Identity internal listener that implements the contract routes
#     GET /internal/users and PATCH /internal/users/{id}/status. The real identity-service on feature/internal does
#     not implement them yet (see manual-qa.md), so QA used a thin shim (not part of this repo).
#
# Optional:
#   PHASE=gap                run only the "Identity internal users API is missing" probe (one doctor, one approval).
#   IDENTITY_STOP_CMD / IDENTITY_START_CMD   shell commands that take Identity's internal API down/up; enables the
#                            outage, 202-pending and worker-convergence section (otherwise it is SKIPPED).
#   CARE_WORKER_PURGE_CMD    command that runs one care-worker tick: npx tsx src/worker.ts --once upload-intent-purge (Care env set).
#   CARE_LOG_FILES           space-separated care-api/care-worker log files to grep for secrets/clinical strings.
#   QA_REPORT                file that receives the case table (no tokens, URLs or bodies).
#   SYNC_WAIT_SECONDS        how long to wait for the worker to converge a pending sync (default 150).
#
# Exit status is non-zero when any case fails. Tokens, URLs and bodies are never printed.
set -euo pipefail

CARE_URL="${CARE_URL:-http://localhost:3001}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:3000}"
: "${IDENTITY_DATABASE_URL:?Set IDENTITY_DATABASE_URL (local identity dev/test database)}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL (local care database, owner login)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY_REPO="${IDENTITY_REPO:-$(cd "$ROOT/../vcare-identity-api" && (pwd -W 2>/dev/null || pwd))}"
PHASE="${PHASE:-all}"
SYNC_WAIT_SECONDS="${SYNC_WAIT_SECONDS:-150}"
TMP="$(mktemp -d)"
TMPW="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"   # native path for curl -F @file on Windows
trap 'rm -rf "$TMP"' EXIT
RUN="$(date +%s)${RANDOM}"
PW="QaPass-${RUN}-zz9!"
REASON="SYNTHETIC-REASON-${RUN}"
PASS=0; FAIL=0; CASE=0; SKIP=0
REPORT="${QA_REPORT:-$TMP/report}"; : > "$REPORT"

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
csql() { psql "$CARE_OWNER_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
isql() { psql "$IDENTITY_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
jget() { node -e 'let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))' "${2:-$TMP/body}" "$1" 2>/dev/null || true; }
hdr() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d' ' -f2- | tr -d '\r'; }

STATUS=""; RID=""
# call METHOD PATH TOKEN [BODY] [KEY] [extra curl args...]   (TOKEN "-" = no Authorization header)
call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}"; shift 5 2>/dev/null || shift $#
  RID="$(uuid)"
  local args=(-s -m 40 -X "$method" -H "X-Request-Id: $RID" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ "$token" = "-" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  STATUS="$(curl "${args[@]}" "$@" "$CARE_URL$path")"
  [ -z "${QA_DEBUG:-}" ] || { echo "DEBUG $method $path -> $STATUS"; head -c 600 "$TMP/body"; echo; }
}

# Response shape checks against contracts/openapi.yaml; also scans for storage keys / URLs leaking into read DTOs.
shape() { # shape KIND
  node - "$TMP/body" "$1" <<'NODE'
const fs = require('fs');
const [file, kind] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8');
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (b.success !== true) process.exit(1);
const has = (o, ks) => ks.every((k) => k in o);
const isoOrNull = (v) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
const leaks = /quarantine\/|verification-documents\/|X-Amz|objectKey|object_key|downloadUrl|"url"/i;
const doc = (d) => has(d, ['id', 'type', 'status', 'fileType', 'sizeBytes', 'uploadedAt']) && Number.isInteger(d.id) &&
  ['license', 'id', 'degree'].includes(d.type) && ['uploaded', 'accepted', 'rejected'].includes(d.status) &&
  ['application/pdf', 'image/jpeg', 'image/png'].includes(d.fileType) && d.sizeBytes >= 1 && d.sizeBytes <= 10485760 &&
  Number.isFinite(Date.parse(d.uploadedAt)) && !('objectKey' in d) && !('url' in d);
const app = (a, own) => has(a, ['id', 'doctorUserId', 'doctor', 'status', 'identitySyncStatus', 'submittedAt', 'decidedAt', 'reviewedBy', 'reviewNote', 'documents']) &&
  Number.isInteger(a.id) && Number.isInteger(a.doctorUserId) && typeof a.doctor === 'object' && 'profileHydrated' in a.doctor &&
  ['draft', 'submitted', 'approved', 'rejected'].includes(a.status) && ['pending', 'synced', 'failed', 'not_required'].includes(a.identitySyncStatus) &&
  isoOrNull(a.submittedAt) && isoOrNull(a.decidedAt) && Array.isArray(a.documents) && a.documents.every(doc) &&
  (own ? Array.isArray(a.missingRequirements) : !('missingRequirements' in a));
let ok = true;
if (kind === 'application') ok = app(b.data, true);
else if (kind === 'adminapp') ok = app(b.data, false);
else if (kind === 'pending202') ok = app(b.data, false) && ['pending', 'failed'].includes(b.data.identitySync);
else if (kind === 'list') ok = Array.isArray(b.data) && b.data.every((a) => app(a, false)) && b.meta && 'nextCursor' in b.meta && typeof b.meta.hasMore === 'boolean' && b.meta.count === b.data.length;
else if (kind === 'document') ok = doc(b.data);
else if (kind === 'intent') ok = has(b.data, ['uploadId', 'url', 'fields', 'expiresAt', 'maxBytes']) && Number.isInteger(b.data.uploadId) &&
  typeof b.data.url === 'string' && typeof b.data.fields === 'object' && Number.isFinite(Date.parse(b.data.expiresAt)) && b.data.maxBytes >= 1 && b.data.maxBytes <= 10485760;
else if (kind === 'dlurl') ok = has(b.data, ['url', 'expiresAt']) && typeof b.data.url === 'string' && Number.isFinite(Date.parse(b.data.expiresAt)) &&
  Math.abs(Date.parse(b.data.expiresAt) - Date.now()) < 90000;
if (!['intent', 'dlurl'].includes(kind) && leaks.test(raw)) ok = false;
process.exit(ok ? 0 : 1);
NODE
}

rec() { # rec ROLE METHOD PATH SCENARIO EXPECTED GOT OK
  CASE=$((CASE + 1))
  local result
  if [ "$7" = 1 ]; then PASS=$((PASS + 1)); result=PASS; else FAIL=$((FAIL + 1)); result=FAIL; fi
  local exp="${5//|/ + }" got="${6//|/ + }"; [ -n "$exp" ] || exp='(none)'; [ -n "$got" ] || got='(none)'
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$2" "$3" "$1" "$4" "$exp" "$got" "$result" | tee -a "$REPORT"
}

# T ROLE METHOD PATH TOKEN SCENARIO EXPECTED SHAPE [BODY] [KEY] [curl extra]
#   EXPECTED: "200", "202/200" (alternatives), "409 ApplicationNotEditable"; SHAPE: none|application|adminapp|pending202|list|document|intent|dlurl
T() {
  local role="$1" method="$2" path="$3" token="$4" scenario="$5" expected="$6" kind="$7" body="${8:-}" key="${9:-}"
  call "$method" "$path" "$token" "$body" "$key"
  local want_status="${expected%% *}" want_code="" ok=0 got="$STATUS" actual_code=""
  [ "$expected" = "$want_status" ] || want_code="${expected#* }"
  case "/$want_status/" in *"/$STATUS/"*) ok=1 ;; esac
  actual_code="$(jget error.code)"
  if [ -n "$want_code" ]; then
    [ "$(jget success)" = "false" ] && [ "$actual_code" = "$want_code" ] && [ "$(jget error.requestId)" = "$RID" ] || ok=0
    got="$STATUS $actual_code"
  elif [ "$STATUS" -ge 400 ]; then
    got="$STATUS $actual_code"
  elif [ "$ok" = 1 ] && [ "$STATUS" != 204 ] && [ "$kind" != none ]; then
    shape "$kind" || { ok=0; got="$STATUS shape-mismatch"; }
  fi
  [ "$(hdr x-request-id)" = "$RID" ] || { ok=0; got="$got bad-request-id-echo"; }
  case "$(hdr cache-control)" in *no-store*) ;; *) ok=0; got="$got missing-no-store" ;; esac
  rec "$role" "$method" "$path" "$scenario" "$expected" "$got" "$ok"
}

# check LABEL ROLE-OR-ACTOR EXPECTED-TEXT ACTUAL-TEXT   (non-HTTP assertion, e.g. DB audit rows or storage status)
check() { # check METHOD-LABEL PATH ROLE SCENARIO EXPECTED GOT
  local ok=0; [ "$5" = "$6" ] && ok=1
  rec "$3" "$1" "$2" "$4" "$5" "$6" "$ok"
}
skip() { SKIP=$((SKIP + 1)); printf 'SKIP|%s|%s\n' "$1" "$2" | tee -a "$REPORT"; }

# ---------- fixtures: Identity users and tokens -------------------------------------------------------------------------
echo "== fixtures"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$IDENTITY_URL/api/health/live")" = 200 ] || { echo 'Identity unavailable' >&2; exit 2; }
HASH="$(PW="$PW" REPO="$IDENTITY_REPO" node -e 'const r=require("node:module").createRequire(process.env.REPO+"/package.json")("argon2");r.hash(process.env.PW,{type:r.argon2id,memoryCost:19456,timeCost:2,parallelism:1}).then(h=>process.stdout.write(h))')"
mkuser() { # mkuser TAG ROLE STATUS -> id
  isql "INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, timezone, locale)
        VALUES ('qa-ver-${RUN}-$1@example.test', '$HASH', 'QA $1', '$2', '$3', now(), 'UTC', 'en') RETURNING id" | head -1
}
login() { # login TAG -> token on stdout (waits out Identity's login rate limiter)
  local t i
  for i in 1 2 3 4 5 6 7 8; do
    curl -s -m 20 -o "$TMP/login.json" -D "$TMP/login.h" -X POST "$IDENTITY_URL/api/auth/login" -H 'Content-Type: application/json'       --data "{\"email\":\"qa-ver-${RUN}-$1@example.test\",\"password\":\"$PW\"}" || true
    t="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data.accessToken||"")}catch{}' "$TMP/login.json")"
    [ -n "$t" ] && { printf '%s' "$t"; return; }
    sleep "$(grep -i '^retry-after:' "$TMP/login.h" 2>/dev/null | head -1 | tr -dc '0-9' || true)"; sleep 5
  done
  echo "login failed for $1" >&2; exit 2
}
declare -A UID_ TOK
for spec in patient:patient:active admin:admin:active docA:doctor:pending docB:doctor:pending docC:doctor:pending docD:doctor:pending \
            docE:doctor:active docF:doctor:pending docG:doctor:pending docH:doctor:pending; do
  IFS=: read -r tag role st <<<"$spec"
  UID_[$tag]="$(mkuser "$tag" "$role" "$st")"; TOK[$tag]="$(login "$tag")"
done
echo "fixture users and tokens ready (values never printed)"
# tampered token: payload segment altered, so the signature can no longer verify
BAD_TOKEN="$(node -e 'const p=process.argv[1].split(".");const c=p[1][10]==="A"?"B":"A";p[1]=p[1].slice(0,10)+c+p[1].slice(11);process.stdout.write(p.join("."))' "${TOK[patient]}")"

# ---------- files ------------------------------------------------------------------------------------------------------
printf '%%PDF-1.4\n%% synthetic QA document\n%%%%EOF\n' > "$TMP/ok.pdf"
node -e 'require("fs").writeFileSync(process.argv[1],Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from("synthetic png body")]))' "$TMP/ok.png"
node -e 'require("fs").writeFileSync(process.argv[1],Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from("synthetic jpeg body")]))' "$TMP/ok.jpg"
printf 'synthetic plain text pretending to be a pdf\n' > "$TMP/fake.pdf"
node -e 'const fs=require("fs");const b=Buffer.alloc(11*1024*1024);b.write("%PDF-1.4");fs.writeFileSync(process.argv[1],b)' "$TMP/big.pdf"
: > "$TMP/empty.pdf"

# ---------- storage helpers --------------------------------------------------------------------------------------------
UP_ID=""; UP_URL=""
new_intent() { # new_intent ROLE TOKEN TYPE SCENARIO -> UP_ID/UP_URL/UP_FIELDS
  T "$1" POST /api/doctors/me/documents/uploads "$2" "$4" 201 intent "{\"type\":\"$3\"}"
  UP_ID="$(jget data.uploadId)"; UP_URL="$(jget data.url)"
  node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data.fields;const q=(s)=>String(s).replace(/\\/g,"\\\\").replace(/"/g,"\\\"");require("fs").writeFileSync(process.argv[2],Object.entries(b).map(([k,v])=>`form = "${q(k)}=${q(v)}"`).join("\n")+"\n")' "$TMP/body" "$TMP/form.cfg"
}
store() { # store FILE CTYPE FILENAME -> storage HTTP status (browser-style presigned POST)
  curl -sS -o /dev/null -w '%{http_code}' -m 60 -K "$TMP/form.cfg" -F "file=@${1/#$TMP/$TMPW};type=$2;filename=$3" "$UP_URL"
}
complete() { # complete ROLE TOKEN SCENARIO EXPECTED SHAPE [UPLOAD_ID]
  T "$1" POST "/api/doctors/me/documents/uploads/${6:-$UP_ID}/complete" "$2" "$3" "$4" "$5"
}
good_doc() { # good_doc ROLE TOKEN TYPE FILE CTYPE FILENAME LABEL -> DOC_ID
  new_intent "$1" "$2" "$3" "$7: create $3 intent"
  check POST "storage presigned POST" "$1" "$7: browser-style upload of $6" 204 "$(store "$4" "$5" "$6")"
  complete "$1" "$2" "$7: complete valid $3" 201 document
  DOC_ID="$(jget data.id)"
}
app_state() { csql "SELECT verification_status||'/'||identity_sync_status FROM doctor_profiles WHERE user_id=$1"; }
audit_count() { csql "SELECT count(*) FROM audit_logs WHERE action='$1' AND entity_id=$2"; }
APPLY='{"headline":"Synthetic QA clinician","bio":"synthetic bio","yearsExperience":6,"languages":["en"],"specialtyIds":[SP],"primarySpecialtyId":SP,"consultationFee":{"amount":5000,"currency":"EGP"},"defaultSlotMinutes":30,"timezone":"UTC","submit":SUBMIT}'
SPEC_ID="$(csql "SELECT id FROM specialties WHERE is_active ORDER BY id LIMIT 1")"
apply_body() { local b="${APPLY//SP/$SPEC_ID}"; printf '%s' "${b//SUBMIT/$1}"; }
wait_state() { # wait_state USER_ID EXPECTED SECONDS
  local i; for ((i = 0; i < $3; i += 2)); do [ "$(app_state "$1")" = "$2" ] && return 0; sleep 2; done; return 1
}

# Brings a fresh pending doctor to `submitted`: draft -> license + id uploads -> submit.
to_submitted() { # to_submitted TAG LABEL
  local tag="$1" tok="${TOK[$1]}"
  T doctor POST /api/doctors/apply "$tok" "$2: create draft profile" 201 none "$(apply_body false)"
  good_doc doctor "$tok" license "$TMP/ok.pdf" application/pdf license.pdf "$2"; LIC_ID="$DOC_ID"
  good_doc doctor "$tok" id "$TMP/ok.png" image/png id.png "$2"; IDD_ID="$DOC_ID"
  T doctor POST /api/doctors/apply "$tok" "$2: submit with license + id" 200 none "$(apply_body true)"
}

# =========================================================================================================================
if [ "$PHASE" = gap ]; then
  echo "== PHASE=gap: approval against the Identity internal API Care is configured for"
  to_submitted docG gap
  APPID="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docG]}")"
  T admin PATCH "/api/admin/applications/$APPID/approve" "${TOK[admin]}" "gap: approve (200 when Identity implements /internal/users, else 202 pending)" "200/202" none
  echo "decision state: $(app_state "${UID_[docG]}"), HTTP $STATUS; $(csql "SELECT status||' attempts='||attempts||' last='||coalesce(last_error_code,'-') FROM identity_sync_jobs WHERE doctor_user_id=${UID_[docG]} ORDER BY id DESC LIMIT 1")"
  echo "== $PASS pass / $FAIL fail"; [ "$FAIL" -eq 0 ]; exit $?
fi

# ---------- 1. auth boundaries and RBAC on every route ------------------------------------------------------------------
echo "== RBAC and authentication"
SOMEID=999999999
for r in "POST /api/doctors/me/documents/uploads" "POST /api/doctors/me/documents/uploads/1/complete" \
         "POST /api/doctors/me/documents/1/download-url" "DELETE /api/doctors/me/documents/1"; do
  m="${r%% *}"; p="${r#* }"; b=""; [ "$p" = /api/doctors/me/documents/uploads ] && b='{"type":"license"}'
  T none "$m" "$p" - "no token" "401 Unauthorized" none "$b"
  T none "$m" "$p" "$BAD_TOKEN" "tampered token" "401 Unauthorized" none "$b"
  T patient "$m" "$p" "${TOK[patient]}" "wrong role (patient)" "403 Forbidden" none "$b"
  T admin "$m" "$p" "${TOK[admin]}" "wrong role (admin)" "403 Forbidden" none "$b"
done
for r in "GET /api/admin/applications" "GET /api/admin/applications/1" "POST /api/admin/applications/1/documents/1/download-url" \
         "PATCH /api/admin/applications/1/approve" "PATCH /api/admin/applications/1/reject" "PATCH /api/admin/applications/1/reopen"; do
  m="${r%% *}"; p="${r#* }"; b=""; case "$p" in */reject|*/reopen) b="{\"reason\":\"$REASON\"}" ;; esac
  T none "$m" "$p" - "no token" "401 Unauthorized" none "$b"
  T patient "$m" "$p" "${TOK[patient]}" "wrong role (patient)" "403 Forbidden" none "$b"
  T doctor "$m" "$p" "${TOK[docA]}" "wrong role (doctor)" "403 Forbidden" none "$b"
done
call GET /api/admin/applications "${TOK[patient]}" "" "" -H 'X-User-Id: 1' -H 'X-Role: admin' -H 'X-Forwarded-User: admin'
rec patient GET /api/admin/applications "spoofed X-Role/X-User-Id headers are ignored" "403" "$STATUS" "$([ "$STATUS" = 403 ] && echo 1 || echo 0)"

# ---------- 2. doctor onboarding, intents, validation ------------------------------------------------------------------
echo "== doctor onboarding and upload intents"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docE]}" "active doctor, no profile yet" "404 NotFound" none '{"type":"license"}'
T doctor POST /api/doctors/apply "${TOK[docA]}" "submit=true with no documents -> no profile created" "400 ValidationFailed" none "$(apply_body true)"
check GET "doctor_profiles" doctor "failed submit leaves no profile row" 0 "$(csql "SELECT count(*) FROM doctor_profiles WHERE user_id=${UID_[docA]}")"
T doctor GET /api/doctors/me/application "${TOK[docA]}" "application before profile" "404 NotFound" none
T doctor POST /api/doctors/apply "${TOK[docA]}" "create draft profile (pending token)" 201 none "$(apply_body false)"
T doctor POST /api/doctors/apply "${TOK[docE]}" "create draft profile (active token)" 201 none "$(apply_body false)"
T doctor GET /api/doctors/me/application "${TOK[docA]}" "own application view lists missingRequirements" 200 application
check GET /api/doctors/me/application doctor "missingRequirements = license_document,id_document" "license_document,id_document" "$(jget data.missingRequirements | tr -d '[]"')"
T doctor POST /api/doctors/apply "${TOK[docA]}" "submit=true with zero documents" "400 ValidationFailed" none "$(apply_body true)"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "intent: invalid type" "400 ValidationFailed" none '{"type":"passport"}'
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "intent: missing type" "400 ValidationFailed" none '{}'
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "intent: unknown property rejected" "400 ValidationFailed" none '{"type":"license","objectKey":"x"}'
T doctor POST /api/doctors/me/documents/uploads/abc/complete "${TOK[docA]}" "complete: non-numeric upload id" "400 ValidationFailed" none
T doctor POST /api/doctors/me/documents/uploads/0/complete "${TOK[docA]}" "complete: zero upload id" "400 ValidationFailed" none
T doctor POST "/api/doctors/me/documents/uploads/$SOMEID/complete" "${TOK[docA]}" "complete: unknown upload id" "404 NotFound" none
T doctor POST /api/doctors/me/documents/abc/download-url "${TOK[docA]}" "download-url: non-numeric document id" "400 ValidationFailed" none
T doctor POST "/api/doctors/me/documents/$SOMEID/download-url" "${TOK[docA]}" "download-url: unknown document" "404 NotFound" none
T doctor DELETE "/api/doctors/me/documents/$SOMEID" "${TOK[docA]}" "delete: unknown document" "404 NotFound" none

echo "== upload verification (MinIO presigned POST -> complete)"
# valid license PDF
new_intent doctor "${TOK[docA]}" license "intent for valid PDF"
T doctor POST "/api/doctors/me/documents/uploads/$UP_ID/complete" "${TOK[docE]}" "complete: another doctor's intent" "404 NotFound" none
T doctor POST "/api/doctors/me/documents/uploads/$UP_ID/complete" "${TOK[docA]}" "complete: nothing uploaded yet (object missing)" "400 ValidationFailed" none
check GET "upload_intents" doctor "intent closed without a document after failed complete" 0 "$(csql "SELECT count(*) FROM verification_documents d JOIN upload_intents i ON i.result_id=d.id WHERE i.id=$UP_ID")"
complete doctor "${TOK[docA]}" "complete again on closed intent" "409 Conflict" none
# fake pdf
new_intent doctor "${TOK[docA]}" license "intent for fake .pdf"
FAKE_ID="$UP_ID"
check POST "storage presigned POST" doctor "upload text file named license.pdf declared application/pdf" 204 "$(store "$TMP/fake.pdf" application/pdf license.pdf)"
complete doctor "${TOK[docA]}" "complete: wrong magic bytes despite .pdf name + application/pdf" "400 ValidationFailed" none
check GET "verification_documents" doctor "no row created for the fake PDF" 0 "$(csql "SELECT count(*) FROM verification_documents d JOIN doctor_profiles p ON p.id=d.doctor_profile_id WHERE p.user_id=${UID_[docA]} AND d.deleted_at IS NULL")"
complete doctor "${TOK[docA]}" "complete: replay on rejected intent" "409 Conflict" none
# oversized
new_intent doctor "${TOK[docA]}" id "intent for oversized file"
OS="$(store "$TMP/big.pdf" application/pdf big.pdf)"
check POST "storage presigned POST" doctor "upload 11 MiB file is refused by the storage policy (content-length-range)" 400 "$OS"
complete doctor "${TOK[docA]}" "complete: oversized object never stored" "400 ValidationFailed" none
# empty file
new_intent doctor "${TOK[docA]}" id "intent for empty file"
ES="$(store "$TMP/empty.pdf" application/pdf empty.pdf)"
check POST "storage presigned POST" doctor "upload 0-byte file is refused by the storage policy" 400 "$ES"
# expired intent
new_intent doctor "${TOK[docA]}" degree "intent to be expired"
check POST "storage presigned POST" doctor "upload valid PDF for the to-be-expired intent" 204 "$(store "$TMP/ok.pdf" application/pdf degree.pdf)"
csql "UPDATE upload_intents SET expires_at = now() - interval '1 minute' WHERE id=$UP_ID" >/dev/null
complete doctor "${TOK[docA]}" "complete after expires_at" "410 UploadIntentExpired" none
complete doctor "${TOK[docA]}" "complete again after expiry" "409 Conflict" none
# degree JPEG (optional type) then valid license + id
good_doc doctor "${TOK[docA]}" degree "$TMP/ok.jpg" image/jpeg degree.jpg "A"; DEG_ID="$DOC_ID"
check GET "document fileType" doctor "JPEG detected from bytes" image/jpeg "$(jget data.fileType)"
good_doc doctor "${TOK[docA]}" license "$TMP/ok.pdf" application/pdf license.pdf "A"; LIC_A="$DOC_ID"; LIC_UP="$UP_ID"
complete doctor "${TOK[docA]}" "replay complete returns the same document" 200 document "$LIC_UP"
check GET "document id" doctor "replay returns identical document id" "$LIC_A" "$(jget data.id)"
check GET "audit_logs" doctor "document_uploaded audited exactly once despite replay" 1 "$(audit_count verification.document_uploaded "$LIC_A")"
good_doc doctor "${TOK[docA]}" id "$TMP/ok.png" image/png id.png "A"; ID_A="$DOC_ID"
T doctor POST "/api/doctors/me/documents/uploads/$LIC_UP/complete" "${TOK[docA]}" "replay complete with unknown body field" "400 ValidationFailed" none '{"x":1}'

echo "== idempotency on intents"
K="$(uuid)"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "intent with Idempotency-Key (first)" 201 intent '{"type":"degree"}' "$K"; FIRST="$(jget data.uploadId)"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "same key + same body replays original" 201 intent '{"type":"degree"}' "$K"
check POST "uploadId" doctor "replay returned the same uploadId" "$FIRST" "$(jget data.uploadId)"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "same key + different body" "422 IdempotencyConflict" none '{"type":"license"}' "$K"

echo "== download-url, delete (draft)"
T doctor POST "/api/doctors/me/documents/$LIC_A/download-url" "${TOK[docA]}" "own document download URL" 200 dlurl
DL_URL="$(jget data.url)"
DL_CODE="$(curl -s -m 30 -D "$TMP/dlh" -o "$TMP/dl.bin" -w '%{http_code}' "$DL_URL")"
check GET "presigned GET" doctor "presigned URL serves the document" 200 "$DL_CODE"
check GET "presigned GET" doctor "attachment disposition + sniffed content type" "attachment|application/pdf" \
  "$(grep -qi '^content-disposition: attachment' "$TMP/dlh" && echo -n attachment || echo -n none)|$(grep -i '^content-type:' "$TMP/dlh" | head -1 | cut -d' ' -f2 | tr -d '\r;')"
check GET "presigned GET" doctor "downloaded bytes equal uploaded bytes" same "$(cmp -s "$TMP/dl.bin" "$TMP/ok.pdf" && echo same || echo different)"
check GET "object URL without signature" doctor "unsigned object URL is private" 403 "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "${DL_URL%%\?*}")"
EARLY_URL="$DL_URL"; EARLY_AT="$(date +%s)"
T doctor POST "/api/doctors/me/documents/$LIC_A/download-url" "${TOK[docA]}" "second issue" 200 dlurl
check GET "audit_logs" doctor "one audit row per issued URL (2 issues)" 2 "$(audit_count verification.document_url_issued "$LIC_A")"
T doctor POST "/api/doctors/me/documents/$LIC_A/download-url" "${TOK[docE]}" "foreign doctor's document -> 404" "404 NotFound" none
T doctor DELETE "/api/doctors/me/documents/$LIC_A" "${TOK[docE]}" "foreign doctor deletes document -> 404" "404 NotFound" none
T doctor GET /api/doctors/me/application "${TOK[docA]}" "application after uploads, no URL or key in DTO" 200 application
check GET "missingRequirements" doctor "all requirements satisfied" "" "$(jget data.missingRequirements | tr -d '[]"')"
T doctor DELETE "/api/doctors/me/documents/$DEG_ID" "${TOK[docA]}" "delete own optional degree (draft)" 204 none
T doctor DELETE "/api/doctors/me/documents/$DEG_ID" "${TOK[docA]}" "delete again -> 404" "404 NotFound" none
check GET "audit_logs" doctor "document_deleted audited" 1 "$(audit_count verification.document_deleted "$DEG_ID")"
T doctor POST "/api/doctors/me/documents/$DEG_ID/download-url" "${TOK[docA]}" "download URL of deleted document" "404 NotFound" none

echo "== submit + edit lock"
T doctor POST /api/doctors/apply "${TOK[docA]}" "submit with license + id" 200 none "$(apply_body true)"
check GET "doctor_profiles" doctor "state after draft submit (no Identity call)" "submitted/not_required" "$(app_state "${UID_[docA]}")"
check GET "audit_logs" doctor "verification.submitted audited" 1 "$(csql "SELECT count(*) FROM audit_logs WHERE action='verification.submitted' AND entity_id=(SELECT id FROM doctor_profiles WHERE user_id=${UID_[docA]})")"
APP_A="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docA]}")"
T doctor POST /api/doctors/apply "${TOK[docA]}" "re-apply while submitted" "409 ApplicationNotEditable" none "$(apply_body false)"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "new intent while submitted" "409 ApplicationNotEditable" none '{"type":"degree"}'
T doctor DELETE "/api/doctors/me/documents/$LIC_A" "${TOK[docA]}" "delete document while submitted" "409 ApplicationNotEditable" none
T doctor POST "/api/doctors/me/documents/$LIC_A/download-url" "${TOK[docA]}" "download own document while submitted" 200 dlurl

# ---------- 3. admin queue / detail / download --------------------------------------------------------------------------
echo "== admin queue, detail, download"
for t in docB docC docD docF; do to_submitted "$t" "$t" >/dev/null; done
# to_submitted prints cases through T/tee already; keep them visible in the report
APP_B="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docB]}")"; APP_C="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docC]}")"
APP_D="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docD]}")"; APP_F="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docF]}")"
T admin GET /api/admin/applications "${TOK[admin]}" "default queue (status=submitted)" 200 list
check GET "queue contents" admin "queue contains submitted applications only" "" "$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).data;process.stdout.write(d.filter(a=>a.status!=="submitted").map(a=>a.id).join(","))' "$TMP/body")"
T admin GET "/api/admin/applications?status=submitted&limit=2" "${TOK[admin]}" "page 1 (limit=2)" 200 list
P1_IDS="$(jget data | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).map(a=>a.id).join(",")))')"; CUR="$(jget meta.nextCursor)"
check GET "meta" admin "page 1 reports hasMore + cursor" "true|yes" "$(jget meta.hasMore)|$([ -n "$CUR" ] && echo yes || echo no)"
T admin GET "/api/admin/applications?status=submitted&limit=2&cursor=$CUR" "${TOK[admin]}" "page 2 via cursor" 200 list
P2_IDS="$(jget data | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).map(a=>a.id).join(",")))')"
check GET "pagination" admin "pages are disjoint" disjoint "$(node -e 'const a=process.argv[1].split(","),b=process.argv[2].split(",");process.stdout.write(a.some(x=>b.includes(x))?"overlap":"disjoint")' "$P1_IDS" "$P2_IDS")"
T admin GET "/api/admin/applications?status=submitted&limit=2&cursor=${CUR}AAAA" "${TOK[admin]}" "tampered cursor" "400 ValidationFailed" none
T admin GET "/api/admin/applications?status=approved&limit=2&cursor=$CUR" "${TOK[admin]}" "cursor reused with another status" "400 ValidationFailed" none
T admin GET "/api/admin/applications?status=bogus" "${TOK[admin]}" "invalid status filter" "400 ValidationFailed" none
T admin GET "/api/admin/applications?limit=0" "${TOK[admin]}" "limit=0" "400 ValidationFailed" none
T admin GET "/api/admin/applications?limit=101" "${TOK[admin]}" "limit=101" "400 ValidationFailed" none
T admin GET "/api/admin/applications?limit=abc" "${TOK[admin]}" "limit not a number" "400 ValidationFailed" none
T admin GET "/api/admin/applications?bogus=1" "${TOK[admin]}" "unknown query key" "400 ValidationFailed" none
T admin GET "/api/admin/applications?status=draft&limit=5" "${TOK[admin]}" "status=draft filter" 200 list
T admin GET "/api/admin/applications/$APP_A" "${TOK[admin]}" "detail" 200 adminapp
check GET "documents" admin "detail lists license + id metadata only" "id,license" "$(jget data.documents | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).map(d=>d.type).sort().join(",")))')"
check GET "audit_logs" admin "documents_viewed audited" 1 "$([ "$(audit_count verification.documents_viewed "$APP_A")" -ge 1 ] && echo 1 || echo 0)"
T admin GET /api/admin/applications/abc "${TOK[admin]}" "detail: non-numeric id" "400 ValidationFailed" none
T admin GET /api/admin/applications/0 "${TOK[admin]}" "detail: id=0" "400 ValidationFailed" none
T admin GET "/api/admin/applications/$SOMEID" "${TOK[admin]}" "detail: unknown id" "404 NotFound" none
T admin POST "/api/admin/applications/$APP_A/documents/$LIC_A/download-url" "${TOK[admin]}" "admin download URL" 200 dlurl
ADL="$(jget data.url)"
check GET "presigned GET" admin "admin URL serves the document" 200 "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$ADL")"
T admin POST "/api/admin/applications/$APP_A/documents/$LIC_A/download-url" "${TOK[admin]}" "second issue" 200 dlurl
check GET "audit_logs" admin "one audit row per issue (3 doctor + 2 admin = 5)" 5 "$(audit_count verification.document_url_issued "$LIC_A")"
T admin POST "/api/admin/applications/$APP_B/documents/$LIC_A/download-url" "${TOK[admin]}" "document belongs to another application" "404 NotFound" none
T admin POST "/api/admin/applications/$APP_A/documents/$SOMEID/download-url" "${TOK[admin]}" "unknown document" "404 NotFound" none
T admin POST "/api/admin/applications/$APP_A/documents/$DEG_ID/download-url" "${TOK[admin]}" "soft-deleted document" "404 NotFound" none

# ---------- 4. decisions: validation and state errors ----------------------------------------------------------------------
echo "== review decisions: validation + state"
T admin PATCH "/api/admin/applications/$SOMEID/approve" "${TOK[admin]}" "approve unknown id" "404 NotFound" none
T admin PATCH /api/admin/applications/abc/approve "${TOK[admin]}" "approve non-numeric id" "400 ValidationFailed" none
T admin PATCH "/api/admin/applications/$APP_A/approve" "${TOK[admin]}" "approve: unknown body field" "400 ValidationFailed" none '{"foo":1}'
T admin PATCH "/api/admin/applications/$APP_A/approve" "${TOK[admin]}" "approve: note > 2000 chars" "400 ValidationFailed" none "{\"note\":\"$(printf 'a%.0s' $(seq 1 2001))\"}"
T admin PATCH "/api/admin/applications/$APP_A/reject" "${TOK[admin]}" "reject: reason missing" "400 ValidationFailed" none '{}'
T admin PATCH "/api/admin/applications/$APP_A/reject" "${TOK[admin]}" "reject: reason too short" "400 ValidationFailed" none '{"reason":"ab"}'
T admin PATCH "/api/admin/applications/$APP_A/reject" "${TOK[admin]}" "reject: control character in reason" "400 ValidationFailed" none '{"reason":"bad\u0007reason"}'
T admin PATCH "/api/admin/applications/$APP_A/reject" "${TOK[admin]}" "reject: no body" "400 ValidationFailed" none
T admin PATCH "/api/admin/applications/$APP_A/reopen" "${TOK[admin]}" "reopen a submitted application" "409 ApplicationNotReviewable" none "{\"reason\":\"$REASON\"}"
T admin PATCH "/api/admin/applications/$SOMEID/reject" "${TOK[admin]}" "reject unknown id" "404 NotFound" none "{\"reason\":\"$REASON\"}"

# ---------- 5. approve (Identity healthy) ---------------------------------------------------------------------------------
echo "== approve with Identity healthy (Case 1)"
KA="$(uuid)"
T admin PATCH "/api/admin/applications/$APP_A/approve" "${TOK[admin]}" "approve with Idempotency-Key, Identity healthy" 200 adminapp '{"note":"Synthetic note"}' "$KA"
check GET "doctor_profiles" admin "approved + synced" "approved/synced" "$(app_state "${UID_[docA]}")"
check GET "identity users.status" admin "Identity account is active" active "$(isql "SELECT status FROM users WHERE id=${UID_[docA]}")"
T admin PATCH "/api/admin/applications/$APP_A/approve" "${TOK[admin]}" "replay same key + body returns original 200" 200 adminapp '{"note":"Synthetic note"}' "$KA"
T admin PATCH "/api/admin/applications/$APP_A/approve" "${TOK[admin]}" "same key, different body" "422 IdempotencyConflict" none '{"note":"another"}' "$KA"
T admin PATCH "/api/admin/applications/$APP_A/approve" "${TOK[admin]}" "approve again without key (already approved)" "409 ApplicationNotReviewable" none
T admin PATCH "/api/admin/applications/$APP_A/reject" "${TOK[admin]}" "reject an approved application" "409 ApplicationNotReviewable" none "{\"reason\":\"$REASON\"}"
T admin PATCH "/api/admin/applications/$APP_A/reopen" "${TOK[admin]}" "reopen an approved application" "409 ApplicationNotReviewable" none "{\"reason\":\"$REASON\"}"
check GET "audit_logs" admin "verification.approved + identity_sync.synced audited once each" "1|1" "$(audit_count verification.approved "$APP_A")|$(audit_count identity_sync.synced "$APP_A")"
check GET "identity_sync_jobs" admin "job succeeded" succeeded "$(csql "SELECT status FROM identity_sync_jobs WHERE doctor_profile_id=$APP_A ORDER BY id DESC LIMIT 1")"
T doctor POST /api/doctors/apply "${TOK[docA]}" "doctor re-submits an approved application" "409 Conflict" none "$(apply_body true)"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docA]}" "intent after approval" "409 ApplicationNotEditable" none '{"type":"degree"}'
T doctor DELETE "/api/doctors/me/documents/$LIC_A" "${TOK[docA]}" "delete document after approval" "409 ApplicationNotEditable" none
T doctor GET /api/doctors/me/application "${TOK[docA]}" "own view after approval" 200 application
check GET "status" doctor "own view shows approved/synced" "approved/synced" "$(jget data.status)/$(jget data.identitySyncStatus)"
T admin GET "/api/admin/applications?status=approved&limit=100" "${TOK[admin]}" "queue status=approved" 200 list
# Case 2 hydration while Identity is up
T admin GET "/api/admin/applications/$APP_A" "${TOK[admin]}" "detail hydrates the doctor block (Case 2)" 200 adminapp
check GET "doctor block" admin "profileHydrated true with displayName" "true|yes" "$(jget data.doctor.profileHydrated)|$([ -n "$(jget data.doctor.displayName)" ] && echo yes || echo no)"

echo "== concurrent approvals"
( call PATCH "/api/admin/applications/$APP_B/approve" "${TOK[admin]}" '{"note":"x"}' ""; echo "$STATUS" > "$TMP/c1" ) &
( call PATCH "/api/admin/applications/$APP_B/approve" "${TOK[admin]}" '{"note":"y"}' ""; echo "$STATUS" > "$TMP/c2" ) &
wait
CONC="$(sort "$TMP/c1" "$TMP/c2" | tr '\n' ' ')"
check PATCH "/api/admin/applications/{id}/approve" admin "two concurrent approvals: exactly one succeeds (200/202), one 409" "200 409 " "${CONC//202/200}"

# ---------- 6. reject / resubmit / reopen / Identity 409 -----------------------------------------------------------------------
echo "== reject, doctor resubmit, admin reopen (Identity pending <-> rejected)"
T admin PATCH "/api/admin/applications/$APP_D/reject" "${TOK[admin]}" "reject, Identity healthy" 200 adminapp "{\"reason\":\"$REASON\"}"
check GET "doctor_profiles" admin "rejected/synced" "rejected/synced" "$(app_state "${UID_[docD]}")"
check GET "identity users.status" admin "Identity account is rejected" rejected "$(isql "SELECT status FROM users WHERE id=${UID_[docD]}")"
T doctor GET /api/doctors/me/application "${TOK[docD]}" "rejected doctor reads the decision (pending-status token)" 200 application
check GET "reviewNote" doctor "decision note visible to the doctor" "$REASON" "$(jget data.reviewNote)"
T admin GET "/api/admin/applications/$APP_D" "${TOK[admin]}" "admin detail after reject" 200 adminapp
TOK[docD]="$(login docD)"
T doctor GET /api/doctors/me/application "${TOK[docD]}" "fresh rejected-status token can read the application" 200 application
T admin PATCH "/api/admin/applications/$APP_D/reject" "${TOK[admin]}" "reject an already rejected application" "409 ApplicationNotReviewable" none "{\"reason\":\"$REASON\"}"
T admin PATCH "/api/admin/applications/$APP_D/approve" "${TOK[admin]}" "approve a rejected application" "409 ApplicationNotReviewable" none
good_doc doctor "${TOK[docD]}" degree "$TMP/ok.pdf" application/pdf degree.pdf "D(rejected)"; DEG_D="$DOC_ID"
T doctor DELETE "/api/doctors/me/documents/$DEG_D" "${TOK[docD]}" "rejected doctor deletes a document" 204 none
T doctor POST /api/doctors/apply "${TOK[docD]}" "doctor resubmits (rejected -> submitted, Identity -> pending)" "200/202" none "$(apply_body true)"
check GET "doctor_profiles" doctor "resubmitted: submitted + Identity pending synced" "submitted/synced" "$(app_state "${UID_[docD]}")"
check GET "identity users.status" doctor "Identity account back to pending" pending "$(isql "SELECT status FROM users WHERE id=${UID_[docD]}")"
T admin PATCH "/api/admin/applications/$APP_D/reject" "${TOK[admin]}" "reject again" 200 adminapp "{\"reason\":\"$REASON second\"}"
T admin PATCH "/api/admin/applications/$APP_D/reopen" "${TOK[admin]}" "admin reopens the rejected application" "200/202" adminapp "{\"reason\":\"$REASON reopen\"}"
check GET "doctor_profiles" admin "reopened: submitted/synced, decision cleared" "submitted/synced|" "$(app_state "${UID_[docD]}")|$(jget data.reviewNote)"
check GET "identity users.status" admin "Identity account pending after reopen" pending "$(isql "SELECT status FROM users WHERE id=${UID_[docD]}")"
check GET "audit_logs" admin "reopened audited" 1 "$(audit_count verification.reopened "$APP_D")"
T admin PATCH "/api/admin/applications/$APP_D/approve" "${TOK[admin]}" "approve the reopened application" 200 adminapp
T doctor GET /api/doctors/me/application "${TOK[docD]}" "doctor sees approved after the full cycle" 200 application

echo "== Identity 409 InvalidStatusTransition (non-retryable)"
isql "UPDATE users SET status='active' WHERE id=${UID_[docC]}" >/dev/null   # simulate drift: Identity already active
T admin PATCH "/api/admin/applications/$APP_C/reject" "${TOK[admin]}" "reject while Identity says active -> 409 from Identity" "202" pending202 "{\"reason\":\"$REASON\"}"
check GET "identitySync" admin "202 body says failed" failed "$(jget data.identitySync)"
check GET "doctor_profiles" admin "profile marked failed, decision kept" "rejected/failed" "$(app_state "${UID_[docC]}")"
check GET "identity_sync_jobs" admin "job failed, not retried" failed "$(csql "SELECT status FROM identity_sync_jobs WHERE doctor_profile_id=$APP_C ORDER BY id DESC LIMIT 1")"
check GET "audit_logs" admin "identity_sync.failed audited" 1 "$(audit_count identity_sync.failed "$APP_C")"

# ---------- 7. Identity outage -> 202 pending -> worker converges ---------------------------------------------------------------
echo "== Identity outage and worker convergence"
if [ -n "${IDENTITY_STOP_CMD:-}" ] && [ -n "${IDENTITY_START_CMD:-}" ]; then
  eval "$IDENTITY_STOP_CMD"; sleep 1
  T doctor POST /api/doctors/apply "${TOK[docH]}" "docH: create draft profile (never hydrated before the outage)" 201 none "$(apply_body false)"
  APP_E="$(csql "SELECT id FROM doctor_profiles WHERE user_id=${UID_[docH]}")"
  T admin GET "/api/admin/applications/$APP_E" "${TOK[admin]}" "Case 2 with Identity down: cold cache, detail still 200 (degraded)" 200 adminapp
  check GET "doctor block" admin "cache miss + outage: profileHydrated=false, displayName null" "false|" "$(jget data.doctor.profileHydrated)|$(jget data.doctor.displayName)"
  T admin GET "/api/admin/applications/$APP_F" "${TOK[admin]}" "Case 2 with Identity down: warm cache entry is served" 200 adminapp
  check GET "doctor block" admin "cache hit + outage: profileHydrated=true" "true" "$(jget data.doctor.profileHydrated)"
  T admin GET "/api/admin/applications?status=submitted&limit=100" "${TOK[admin]}" "Case 2 with Identity down: queue still 200" 200 list
  T0="$(date +%s)"
  T admin PATCH "/api/admin/applications/$APP_F/approve" "${TOK[admin]}" "approve while Identity is down -> 202 pending" 202 pending202
  check PATCH "latency" admin "inline attempts finish in < 15 s" yes "$([ $(( $(date +%s) - T0 )) -lt 15 ] && echo yes || echo no)"
  check GET "identitySync" admin "202 body says pending" pending "$(jget data.identitySync)"
  check GET "doctor_profiles" admin "decision kept, sync pending" "approved/pending" "$(app_state "${UID_[docF]}")"
  check GET "audit_logs" admin "identity_sync.pending audited once" 1 "$(audit_count identity_sync.pending "$APP_F")"
  T admin PATCH "/api/admin/applications/$APP_F/approve" "${TOK[admin]}" "second approve while pending sync" "409 ApplicationNotReviewable" none
  T doctor GET /api/doctors/me/application "${TOK[docF]}" "doctor sees approved + pending" 200 application
  check GET "status" doctor "own view approved/pending" "approved/pending" "$(jget data.status)/$(jget data.identitySyncStatus)"
  sleep 12   # let the worker run at least one failing tick
  check GET "identity_sync_jobs" admin "job still pending with attempts > 0" "pending|yes" "$(csql "SELECT status FROM identity_sync_jobs WHERE doctor_profile_id=$APP_F ORDER BY id DESC LIMIT 1")|$([ "$(csql "SELECT attempts FROM identity_sync_jobs WHERE doctor_profile_id=$APP_F ORDER BY id DESC LIMIT 1")" -gt 0 ] && echo yes || echo no)"
  eval "$IDENTITY_START_CMD"
  if wait_state "${UID_[docF]}" approved/synced "$SYNC_WAIT_SECONDS"; then CONV=approved/synced; else CONV="$(app_state "${UID_[docF]}")"; fi
  check GET "doctor_profiles" admin "care-worker converged the pending sync after Identity returned" approved/synced "$CONV"
  check GET "identity users.status" admin "Identity account is active" active "$(isql "SELECT status FROM users WHERE id=${UID_[docF]}")"
  check GET "audit_logs" admin "identity_sync.synced audited once" 1 "$(audit_count identity_sync.synced "$APP_F")"
  check GET "identity_sync_jobs" admin "job succeeded" succeeded "$(csql "SELECT status FROM identity_sync_jobs WHERE doctor_profile_id=$APP_F ORDER BY id DESC LIMIT 1")"
else
  skip "Identity outage / worker convergence" "set IDENTITY_STOP_CMD and IDENTITY_START_CMD"
fi

# ---------- 8. rate limit, expiry of presigned URL, log hygiene ---------------------------------------------------------------
echo "== idempotency key format, locally suspended doctor, intent purge loop"
call POST /api/doctors/me/documents/uploads "${TOK[docE]}" '{"type":"degree"}' "not-a-uuid"
rec doctor POST /api/doctors/me/documents/uploads "malformed Idempotency-Key" "400 ValidationFailed" "$STATUS $(jget error.code)" "$([ "$STATUS $(jget error.code)" = "400 ValidationFailed" ] && echo 1 || echo 0)"
good_doc doctor "${TOK[docE]}" license "$TMP/ok.pdf" application/pdf license.pdf "E"; LIC_E="$DOC_ID"
good_doc doctor "${TOK[docE]}" id "$TMP/ok.png" image/png id.png "E"
new_intent doctor "${TOK[docE]}" degree "E: open intent with stored PDF, completed after suspension"; INT_E="$UP_ID"
check POST "storage presigned POST" doctor "E: upload PDF for the open intent" 204 "$(store "$TMP/ok.pdf" application/pdf degree.pdf)"
csql "UPDATE doctor_profiles SET suspended_at = now(), suspension_reason = 'synthetic QA suspension' WHERE user_id=${UID_[docE]}" >/dev/null
T doctor POST /api/doctors/me/documents/uploads "${TOK[docE]}" "locally suspended doctor: new intent (token still valid)" "403 Forbidden" none '{"type":"degree"}'
complete doctor "${TOK[docE]}" "locally suspended doctor: complete a pending intent" "403 Forbidden" none "$INT_E"
T doctor DELETE "/api/doctors/me/documents/$LIC_E" "${TOK[docE]}" "locally suspended doctor: delete document" "403 Forbidden" none
T doctor POST /api/doctors/apply "${TOK[docE]}" "locally suspended doctor: submit=true" "403 Forbidden" none "$(apply_body true)"
T doctor POST /api/doctors/apply "${TOK[docE]}" "locally suspended doctor: submit=false draft save (doctors spec: apply route has no doctor_not_suspended)" 200 none "$(apply_body false)"
csql "UPDATE doctor_profiles SET suspended_at = NULL, suspension_reason = NULL WHERE user_id=${UID_[docE]}" >/dev/null
if [ -n "${CARE_WORKER_PURGE_CMD:-}" ]; then
  new_intent doctor "${TOK[docE]}" degree "intent left open then expired (purge loop)"
  PURGE_ID="$UP_ID"
  check POST "storage presigned POST" doctor "upload valid PDF to be purged" 204 "$(store "$TMP/ok.pdf" application/pdf degree.pdf)"
  csql "UPDATE upload_intents SET expires_at = now() - interval '1 minute' WHERE id=$PURGE_ID" >/dev/null
  eval "$CARE_WORKER_PURGE_CMD" >/dev/null 2>&1 || true
  check GET "upload_intents" doctor "worker upload-intent-purge closed the expired open intent" yes "$([ -n "$(csql "SELECT consumed_at FROM upload_intents WHERE id=$PURGE_ID")" ] && echo yes || echo no)"
  complete doctor "${TOK[docE]}" "complete on a purged intent" "409 Conflict" none "$PURGE_ID"
else
  skip "upload-intent-purge worker tick" "set CARE_WORKER_PURGE_CMD (e.g. 'npx tsx src/worker.ts --once upload-intent-purge' with the Care env)"
fi

echo "== rate limit (20 intents/h per doctor)"
[ -n "$(csql "SELECT 1 FROM doctor_profiles WHERE user_id=${UID_[docH]}")" ] || T doctor POST /api/doctors/apply "${TOK[docH]}" "docH: create draft profile" 201 none "$(apply_body false)"
LAST=0
for i in $(seq 1 20); do
  call POST /api/doctors/me/documents/uploads "${TOK[docH]}" '{"type":"degree"}' ""; LAST="$STATUS"
  [ "$STATUS" = 201 ] || break
done
check POST "/api/doctors/me/documents/uploads" doctor "20 intents within the hour all succeed" 201 "$LAST"
T doctor POST /api/doctors/me/documents/uploads "${TOK[docH]}" "21st intent in the hour" "429 RateLimited" none '{"type":"degree"}'
check GET "Retry-After" doctor "429 carries Retry-After" yes "$([ -n "$(hdr retry-after)" ] && echo yes || echo no)"

echo "== request id handling"
call GET /api/admin/applications "${TOK[admin]}" "" "" -H 'X-Request-Id: not-a-uuid'
GEN="$(hdr x-request-id)"
check GET /api/admin/applications admin "non-UUID X-Request-Id replaced by a generated UUID" yes "$([[ "$GEN" =~ ^[0-9a-f-]{36}$ && "$GEN" != "not-a-uuid" ]] && echo yes || echo no)"
RID_SENT="$(uuid)"; curl -s -o /dev/null -D "$TMP/h2" -H "Authorization: Bearer ${TOK[admin]}" "$CARE_URL/api/admin/applications" ; ECHO_GEN="$(grep -i '^x-request-id:' "$TMP/h2" | cut -d' ' -f2 | tr -d '\r')"
check GET /api/admin/applications admin "missing X-Request-Id: one is generated" yes "$([[ "$ECHO_GEN" =~ ^[0-9a-f-]{36}$ ]] && echo yes || echo no)"

echo "== presigned URL expiry and log hygiene"
WAIT=$(( 65 - ($(date +%s) - EARLY_AT) )); [ "$WAIT" -gt 0 ] && sleep "$WAIT"
check GET "presigned GET" doctor "URL is dead after 60 s" 403 "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$EARLY_URL")"
check GET "audit_logs" admin "no reviewer prose in audit metadata" 0 "$(csql "SELECT count(*) FROM audit_logs WHERE metadata::text LIKE '%${REASON}%' OR metadata::text LIKE '%quarantine/%'")"
check GET "identity_sync_jobs" admin "reason kept only on the job row (needed for retry)" yes "$([ "$(csql "SELECT count(*) FROM identity_sync_jobs WHERE reason LIKE '%${REASON}%'")" -ge 1 ] && echo yes || echo no)"
if [ -n "${CARE_LOG_FILES:-}" ]; then
  HITS=0
  for f in $CARE_LOG_FILES; do
    HITS=$((HITS + $(grep -c -E "${REASON}|quarantine/|verification-documents/|X-Amz-|eyJ[A-Za-z0-9_-]{20,}|Bearer " "$f" || true)))
  done
  check GET "care logs" admin "no tokens, keys, signed URLs or reviewer prose in Care logs" 0 "$HITS"
else
  skip "log hygiene grep" "set CARE_LOG_FILES"
fi

echo
echo "== $PASS pass / $FAIL fail / $SKIP skipped (report: $REPORT)"
[ "$FAIL" -eq 0 ]
