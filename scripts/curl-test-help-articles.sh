#!/usr/bin/env bash
# Manual QA (CURL) for the `help-articles` module of care-service (docs/help-articles/manual-qa.md; spec §9.5).
#
# Exercises the five routes GET/POST /api/help-articles and GET/PATCH/DELETE /api/help-articles/{id} on the REAL public app
# (CARE_URL) with signed test tokens minted by the loopback fake JWKS in scripts/access-qa-fake-identity.ts. help-articles has
# no Identity dependency and no /internal route, so nothing else is needed. The server should be the COMPILED build
# (npm run build; node dist/server.js): the `isPublished=yes` -> 400 check (CLAUDE.md foundation fix #8) is only meaningful
# there, because tsx/esbuild emits no `design:type` metadata.
#
# Start (Git Bash; synthetic values only, ONE care-api at a time; stop both processes afterwards):
#   FAKE_IDENTITY_PORT=3021 npx tsx scripts/access-qa-fake-identity.ts &
#   npm run build
#   NODE_ENV=development PORT=3051 INTERNAL_PORT=3151 LOG_LEVEL=info \
#     DATABASE_URL=postgres://care_app:<pw>@127.0.0.1:5499/care_test MIGRATION_DATABASE_URL=<owner url> \
#     REDIS_URL=redis://127.0.0.1:6380/14 IDENTITY_JWKS_URL=http://127.0.0.1:3021/.well-known/jwks.json \
#     IDENTITY_INTERNAL_URL=http://127.0.0.1:3021 SERVICE_CLIENT_ID=care-qa SERVICE_CLIENT_SECRET=<synthetic> \
#     STORAGE_BUCKET=care-qa STORAGE_REGION=us-east-1 STORAGE_ENDPOINT=http://127.0.0.1:9 STORAGE_ACCESS_KEY_ID=qa \
#     STORAGE_SECRET_ACCESS_KEY=<synthetic> STORAGE_FORCE_PATH_STYLE=true VIDEO_PROVIDER=fake \
#     VIDEO_PROVIDER_KEY=<synthetic, >= 32 chars> node dist/server.js > care.log 2>&1 &
#   (start Care AFTER the fake identity so the first JWKS fetch succeeds)
#
# Required:
#   CARE_OWNER_DATABASE_URL   owner login to a disposable *_test database (fixtures, audit assertions, cleanup)
# Optional:
#   CARE_URL (http://127.0.0.1:3051) · FAKE_IDENTITY_URL (http://127.0.0.1:3021)
#   REDIS_URL        the SAME Redis the server uses. Set = "Redis-up" run (full suite, rate-limit cases). Unset = "Redis-down"
#                    run against a server whose REDIS_URL is unreachable: a reduced smoke (CRUD works, idempotency steps aside,
#                    no rate-limit reset possible); outcomes are asserted for CRUD and printed as INFO for the rest.
#   CARE_LOG_FILE    the server's stdout file; scanned for tokens, fixture titles/bodies, error-level lines (skipped when unset)
#   SKIP_RATE_LIMIT=1  skip the 121st-read / 21st-write 429 cases
#
# Fixtures: every article this script creates has a title starting `QA-HA-`; the table must hold no other row (the script
# refuses otherwise). All of them are hard-deleted by the owner at start and on exit. audit_logs rows are append-only and stay.
# Redis keys touched: rl:help-articles-* and idem:*help-articles* of the QA principals. No notification_outbox row is touched.
# Exit code: 0 when every case passes, 1 otherwise, 2 when a prerequisite is missing.
set -euo pipefail

CARE_URL="${CARE_URL:-http://127.0.0.1:3051}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL for a disposable *_test database}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*_test($|\?) ]] || { echo 'Refusing a non-test database' >&2; exit 2; }
REDIS_URL="${REDIS_URL:-}"
CARE_LOG_FILE="${CARE_LOG_FILE:-}"
SKIP_RATE_LIMIT="${SKIP_RATE_LIMIT:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$CARE_URL/api/help-articles"
MODE="$([ -n "$REDIS_URL" ] && echo full || echo redis-down)"

TMP="$(mktemp -d)"
PASS=0; FAIL=0; SKIP=0; CASE=0
RUN="$(date +%s)"
P="QA-HA-$RUN"                       # title prefix of this run
MARKER="SYNTHETIC-HELP-BODY-7731"
EXTRA=()
TOKEN_SIGS=()
READS=0; WRITES=0
ST=""; RID=""
SECTION=""; REQ_METHOD="-"; REQ_PATH="-"; REQ_ROLE="-"
TABLE_FILE="${QA_TABLE_FILE:-}"      # optional: append one TSV row per case (n, section, method, path, role, scenario, expected, got, result)

nodepath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
uuid() { printf '%04x%04x-%04x-4%03x-%04x-%04x%04x%04x' $((RANDOM)) $((RANDOM)) $((RANDOM)) $((RANDOM % 4096)) $(( (8 + RANDOM % 4) * 4096 + RANDOM % 4096 )) $((RANDOM)) $((RANDOM)) $((RANDOM)); }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }

# Redis helper (ioredis from node_modules; no redis-cli needed): rds delprefix <p> | exists <key> | ttl <key> | zcard <key>
rds() {
  [ -n "$REDIS_URL" ] || return 0
  ROOT="$ROOT" RURL="$REDIS_URL" node -e '
const Redis = require(process.env.ROOT + "/node_modules/ioredis");
const r = new Redis(process.env.RURL);
const scan = async (p) => { let c = "0"; const out = []; do { const [n, ks] = await r.scan(c, "MATCH", p + "*", "COUNT", 500); c = n; out.push(...ks); } while (c !== "0"); return out; };
(async () => {
  const [cmd, a] = process.argv.slice(1);
  if (cmd === "delprefix") { const ks = await scan(a); for (const k of ks) await r.del(k); console.log(ks.length); }
  else if (cmd === "exists") console.log(await r.exists(a));
  else if (cmd === "keys") console.log((await scan(a)).sort().join(","));
  await r.quit();
})().catch((e) => { console.error(e.message); process.exit(1); });' "$@" | tr -d '\r'
}
reset_rl() { rds delprefix 'rl:help-articles-' >/dev/null; READS=0; WRITES=0; }

cleanup_fixtures() { sql "DELETE FROM help_articles WHERE title LIKE '%QA-HA-%'" >/dev/null 2>&1 || true; }
on_exit() {
  local rc=$?
  cleanup_fixtures
  [ -z "$REDIS_URL" ] || { reset_rl; rds delprefix 'idem:' >/dev/null 2>&1 || true; }
  rm -rf "$TMP"
  printf '\nhelp-articles CURL QA (%s): %s passed, %s failed, %s skipped\n' "$MODE" "$PASS" "$FAIL" "$SKIP"
  if [ "$rc" -eq 0 ] && [ "$FAIL" -gt 0 ]; then rc=1; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# --- HTTP + assertions --------------------------------------------------------------------------------------------------
# call METHOD PATH TOKEN [BODY|@file] -> $ST; body/headers in $TMP; sent request id in $RID. EXTRA=(curl args) is consumed.
call() {
  local method="$1" path="$2" tok="$3" body="${4-}" args=()
  RID="$(uuid)"
  if [ "$method" = GET ]; then READS=$((READS + 1)); else WRITES=$((WRITES + 1)); fi
  if [ -n "$REDIS_URL" ] && { [ "$WRITES" -ge 14 ] || [ "$READS" -ge 100 ]; }; then reset_rl; fi   # stay under 20 writes / 120 reads per minute
  args=(-s -o "$TMP/body" -D "$TMP/headers" -X "$method" -H "X-Request-Id: $RID")
  if [ "$tok" != "-" ]; then args+=(-H "Authorization: Bearer $tok"); fi
  if [ -n "$body" ]; then
    if [ "${body:0:1}" = "@" ]; then body="@$(nodepath "${body:1}")"; fi
    args+=(-H "Content-Type: application/json" --data-binary "$body")
  fi
  if [ "${#EXTRA[@]}" -gt 0 ]; then args+=("${EXTRA[@]}"); fi
  EXTRA=()
  ST="$(curl "${args[@]}" "$BASE$path" -w '%{http_code}' || true)"
}
header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
# jf <dotted path>... -> values of the last JSON body joined by "|" (<undef> absent, <non-json> unparsable)
jf() {
  node -e '
    const fs = require("fs"); let b;
    try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("<non-json>"); process.exit(0); }
    const get = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
    process.stdout.write(process.argv.slice(2).map((p) => { const v = get(b, p);
      return v === undefined ? "<undef>" : typeof v === "object" ? JSON.stringify(v) : String(v); }).join("|"));
  ' "$(nodepath "$TMP/body")" "$@"
}
ids_of() { node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((Array.isArray(b.data)?b.data:[]).map(r=>r.id).join(","))}catch{process.stdout.write("<non-json>")}' "$(nodepath "$TMP/body")"; }
keys_of() { node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=Array.isArray(b.data)?b.data[0]:b.data;process.stdout.write(Object.keys(d).sort().join(","))}catch{process.stdout.write("<none>")}' "$(nodepath "$TMP/body")"; }
# mkjson <file> '<JS object expression>' -> writes JSON (so long / astral / control-character values never pass through the shell)
mkjson() { node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(eval(process.argv[2])))' "$(nodepath "$1")" "$2"; }
b64url() { node -e 'process.stdout.write(Buffer.from(process.argv[1],"utf8").toString("base64url"))' "$1"; }

record() { # record <label> <request> <expected> <got> <ok 0|1>
  CASE=$((CASE + 1))
  if [ -n "$TABLE_FILE" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$CASE" "$SECTION" "$REQ_METHOD" "$(printf '%s' "$REQ_PATH" | sed -E 's/cursor=[^&]*/cursor=<c>/')" "$REQ_ROLE" "$1" "$3" "$(printf '%s' "$4" | tr '\n\t' '  ' | cut -c1-90)" "$([ "$5" = 1 ] && echo PASS || echo FAIL)" >> "$TABLE_FILE"
  fi
  if [ "$5" = "1" ]; then PASS=$((PASS + 1)); printf "  PASS  H%-4s %-72s exp=[%s] got=[%s]\n" "$CASE" "$1" "$3" "$4"
  else FAIL=$((FAIL + 1)); printf "  FAIL  H%-4s %-72s exp=[%s] got=[%s]  (%s)\n" "$CASE" "$1" "$3" "$4" "$2"; fi
}
skip() { CASE=$((CASE + 1)); SKIP=$((SKIP + 1)); [ -z "$TABLE_FILE" ] || printf '%s\t%s\t-\t-\t-\t%s\t-\t%s\tSKIP\n' "$CASE" "$SECTION" "$1" "$2" >> "$TABLE_FILE"; printf "  SKIP  H%-4s %-72s (%s)\n" "$CASE" "$1" "$2"; }
info() { printf "  INFO  %s\n" "$1"; }
section() { SECTION="$1"; printf "\n== %s ==\n" "$1"; }
role_of() { # role label of a bearer token (never the token itself)
  case "$1" in
    -) echo none ;; "$ADMIN"|"${WT:-@}") echo admin ;; "$PATIENT"|"${RT:-@}") echo patient ;; "$DOCTOR") echo doctor ;;
    "$DOC_PENDING") echo "doctor (pending)" ;; "$DOC_REJECTED") echo "doctor (rejected)" ;; "$DOC_SUSP") echo "doctor (suspended)" ;;
    "$PAT_PENDING") echo "patient (pending)" ;; "$PAT_SUSP") echo "patient (suspended)" ;;
    "$ADM_PENDING") echo "admin (pending)" ;; "$ADM_SUSP") echo "admin (suspended)" ;;
    "$EXPIRED") echo "expired token" ;; "$TAMPERED") echo "tampered token" ;; "$WRONG_AUD") echo "wrong-aud token" ;;
    "$ALG_NONE") echo "alg-none token" ;; "$WRONG_TYP") echo "service-typed token" ;; *) echo "garbage token" ;;
  esac
}

# t <label> <METHOD> <path> <token|-> <status> <errorCode|-> [body|@file]  — status, envelope, X-Request-Id echo, Cache-Control.
# errorCode "-" means a success envelope (or an empty body for 204); a code means success=false, error.code, error.requestId == sent id,
# error.details is an array.
t() {
  local label="$1" method="$2" path="$3" tok="$4" es="$5" ec="$6" body="${7-}" ok=1 note="" f
  call "$method" "$path" "$tok" "$body"
  REQ_METHOD="$method"; REQ_PATH="/api/help-articles$path"; REQ_ROLE="$(role_of "$tok")"
  [ "$ST" = "$es" ] || ok=0
  [ "$(header X-Request-Id)" = "$RID" ] || { ok=0; note="$note rid-not-echoed"; }
  [ "$(header Cache-Control)" = "private, no-cache" ] || { ok=0; note="$note cache-control=[$(header Cache-Control)]"; }
  if [ "$ec" != "-" ]; then
    f="$(jf success error.code error.requestId error.details error.message)"
    [[ "$f" == "false|$ec|$RID|["* ]] || { ok=0; note="$note envelope=[${f:0:120}]"; }
    [[ "$f" != *"|<undef>" ]] || { ok=0; note="$note no-message"; }
  elif [ "$es" = 204 ]; then
    [ ! -s "$TMP/body" ] || { ok=0; note="$note non-empty-204"; }
  else
    [ "$(jf success)" = "true" ] || { ok=0; note="$note success=$(jf success)"; }
  fi
  record "$label" "$method $path" "$es ${ec/#-/ok}" "$ST $([ "$ec" = - ] && echo ok || jf error.code)$note" "$ok"
}
fld() { # fld <label> <json path> <expected>  — last body
  local got; got="$(jf "$2")"
  record "$1" "body $2" "$3" "$got" "$([ "$got" = "$3" ] && echo 1 || echo 0)"
}
val() { local m="$REQ_METHOD" pth="$REQ_PATH" r="$REQ_ROLE"; REQ_METHOD="check"; REQ_PATH="($2)"; REQ_ROLE="-"; record "$1" "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"; REQ_METHOD="$m"; REQ_PATH="$pth"; REQ_ROLE="$r"; }   # val <label> <what> <expected> <got>

# --- Preflight + tokens ---------------------------------------------------------------------------------------------------
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
code="$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/ready" || true)"
[ "$code" = 200 ] || { echo "Care API not ready at $CARE_URL (health/ready=$code); start it as described in the header" >&2; exit 2; }
mint admin-1 >/dev/null 2>&1 || { echo "fake identity not reachable at $FAKE_IDENTITY_URL" >&2; exit 2; }
sql "SELECT 1" >/dev/null || { echo "owner database not reachable" >&2; exit 2; }
cleanup_fixtures
OTHER="$(sql "SELECT count(*) FROM help_articles")"
[ "$OTHER" = 0 ] || { echo "help_articles holds $OTHER non-QA rows; run against a disposable database" >&2; exit 2; }
[ -z "$REDIS_URL" ] || { reset_rl; rds delprefix 'idem:' >/dev/null; }

ADMIN="$(mint admin-1)"; PATIENT="$(mint patient-101)"; DOCTOR="$(mint doctor-201)"
DOC_PENDING="$(mint doctor-pending)"; DOC_REJECTED="$(mint doctor-rejected)"; DOC_SUSP="$(mint doctor-suspended)"
PAT_PENDING="$(mint patient-pending)"; PAT_SUSP="$(mint patient-suspended)"
ADM_PENDING="$(mint admin-pending)"; ADM_SUSP="$(mint admin-suspended)"
EXPIRED="$(mint expired)"; TAMPERED="$(mint tampered)"; WRONG_AUD="$(mint wrong-aud)"; ALG_NONE="$(mint alg-none)"; WRONG_TYP="$(mint typ-service)"
for tk in "$ADMIN" "$PATIENT" "$DOCTOR" "$DOC_PENDING" "$DOC_REJECTED" "$PAT_PENDING" "$EXPIRED"; do TOKEN_SIGS+=("${tk##*.}"); done

echo "help-articles CURL QA — mode=$MODE server=$CARE_URL run=$RUN"

audit_count() { sql "SELECT count(*) FROM audit_logs WHERE entity_type = 'help_article' AND entity_id = $1"; }
audit_total() { sql "SELECT count(*) FROM audit_logs WHERE entity_type = 'help_article'"; }
audit_row() { sql "SELECT action || '|' || actor_user_id || '|' || actor_role || '|' || request_id || '|' || metadata::text FROM audit_logs WHERE entity_type = 'help_article' AND entity_id = $1 ORDER BY id DESC LIMIT ${2:-1}"; }
READER_ORACLE() { sql "SELECT coalesce(string_agg(id::text, ',' ORDER BY published_at DESC, id DESC), '') FROM help_articles WHERE audience = '$1' AND is_published AND deleted_at IS NULL"; }
ADMIN_ORACLE() { sql "SELECT coalesce(string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC), '') FROM help_articles WHERE deleted_at IS NULL"; }
VALID='"category":"how-it-works","audience":"patient","isPublished":false'
AUD_START="$(audit_total)"      # audit_logs is append-only: earlier runs leave rows, so every audit check is a delta or keyed by article id

if [ "$MODE" = redis-down ]; then
  # ------------------------------------------------------------------------------------------------------------------------
  section "Redis-down smoke (server cannot reach Redis): CRUD works, idempotency and rate-limit step aside"
  t "no token: GET list" GET "" - 401 Unauthorized
  t "patient list (empty table)" GET "" "$PATIENT" 200 -
  t "admin creates a published patient article" POST "" "$ADMIN" 201 - "{\"title\":\"$P-down-1\",\"body\":\"Synthetic body $MARKER\",\"category\":\"how-it-works\",\"audience\":\"patient\",\"isPublished\":true}"
  ID=$(jf data.id)
  t "patient reads it by id" GET "/$ID" "$PATIENT" 200 -
  t "patient list shows it" GET "" "$PATIENT" 200 -
  val "list ids" "patient list contains the created id" "$ID" "$(ids_of)"
  t "duplicate title -> 409 Conflict (DB unique index; no Redis involved)" POST "" "$ADMIN" 409 Conflict "{\"title\":\"$P-down-1\",\"body\":\"Synthetic body\",\"category\":\"how-it-works\",\"audience\":\"patient\",\"isPublished\":true}"
  K="$(uuid)"; B2="{\"title\":\"$P-down-2\",\"body\":\"Synthetic body\",\"category\":\"how-it-works\",\"audience\":\"patient\",\"isPublished\":false}"
  EXTRA=(-H "Idempotency-Key: $K"); call POST "" "$ADMIN" "$B2"; S1="$ST"
  EXTRA=(-H "Idempotency-Key: $K"); call POST "" "$ADMIN" "$B2"; S2="$ST"
  info "idempotent replay with Redis down: first POST $S1, same key + same body again $S2 (expected: 201 then 409 from the unique index, middleware stepped aside)"
  val "idempotency with Redis down steps aside (no 5xx)" "POST x2 same key" "201 409" "$S1 $S2"
  t "patch title" PATCH "/$ID" "$ADMIN" 200 - "{\"title\":\"$P-down-1b\"}"
  t "patch no-op" PATCH "/$ID" "$ADMIN" 200 - "{\"title\":\"$P-down-1b\"}"
  t "delete" DELETE "/$ID" "$ADMIN" 204 -
  t "get after delete -> 404" GET "/$ID" "$ADMIN" 404 NotFound
  t "patient write -> 403" POST "" "$PATIENT" 403 Forbidden "{\"title\":\"$P-down-3\",\"body\":\"x\",$VALID}"
  info "rate limiting with Redis down uses the per-instance fallback (not reset-able from here); ready probe: $(curl -s "$CARE_URL/api/health/ready")"
  exit 0
fi

# ------------------------------------------------------------------------------------------------------------------------------
section "1. Authentication (401): all five routes"
t "no token: GET list" GET "" - 401 Unauthorized
t "no token: GET by id" GET "/1" - 401 Unauthorized
t "no token: POST" POST "" - 401 Unauthorized "{\"title\":\"$P-x\",\"body\":\"b\",$VALID}"
t "no token: PATCH" PATCH "/1" - 401 Unauthorized '{"title":"abc"}'
t "no token: DELETE" DELETE "/1" - 401 Unauthorized
t "expired token: GET list -> TokenExpired" GET "" "$EXPIRED" 401 TokenExpired
t "expired token: POST -> TokenExpired" POST "" "$EXPIRED" 401 TokenExpired "{\"title\":\"$P-x\",\"body\":\"b\",$VALID}"
t "tampered signature -> 401" GET "" "$TAMPERED" 401 Unauthorized
t "wrong audience -> 401" GET "" "$WRONG_AUD" 401 Unauthorized
t "alg none -> 401" GET "" "$ALG_NONE" 401 Unauthorized
t "service-typed token on a user route -> 401" GET "" "$WRONG_TYP" 401 Unauthorized
t "garbage bearer -> 401" GET "" "not-a-token" 401 Unauthorized
EXTRA=(-H "Authorization: Basic YTpi"); t "Basic scheme instead of Bearer -> 401" GET "" - 401 Unauthorized

# ------------------------------------------------------------------------------------------------------------------------------
section "2. Authorization: roles and account states"
OKBODY="{\"title\":\"$P-rbac\",\"body\":\"b\",$VALID}"
t "patient POST -> 403" POST "" "$PATIENT" 403 Forbidden "$OKBODY"
t "doctor POST -> 403" POST "" "$DOCTOR" 403 Forbidden "$OKBODY"
t "patient PATCH any id -> 403" PATCH "/1" "$PATIENT" 403 Forbidden '{"title":"abc"}'
t "patient PATCH id=abc -> 403 (role before id parsing)" PATCH "/abc" "$PATIENT" 403 Forbidden '{"title":"abc"}'
t "doctor PATCH -> 403" PATCH "/1" "$DOCTOR" 403 Forbidden '{"title":"abc"}'
t "patient DELETE -> 403" DELETE "/1" "$PATIENT" 403 Forbidden
t "doctor DELETE -> 403" DELETE "/1" "$DOCTOR" 403 Forbidden
t "doctor DELETE id=abc -> 403" DELETE "/abc" "$DOCTOR" 403 Forbidden
EXTRA=(-H "X-Role: admin" -H "X-User-Id: 1" -H "X-Forwarded-User: 1"); t "patient token + spoofed X-Role/X-User-Id headers: POST -> 403" POST "" "$PATIENT" 403 Forbidden "$OKBODY"
EXTRA=(-H "X-Role: admin" -H "X-User-Id: 1"); t "patient token + spoofed headers: DELETE -> 403" DELETE "/1" "$PATIENT" 403 Forbidden
t "doctor pending POST -> 403" POST "" "$DOC_PENDING" 403 Forbidden "$OKBODY"
t "doctor rejected PATCH -> 403" PATCH "/1" "$DOC_REJECTED" 403 Forbidden '{"title":"abc"}'
t "admin pending (not active) POST -> 403" POST "" "$ADM_PENDING" 403 Forbidden "$OKBODY"
t "admin suspended POST -> 403" POST "" "$ADM_SUSP" 403 Forbidden "$OKBODY"
t "admin pending list -> 403" GET "" "$ADM_PENDING" 403 Forbidden
t "admin suspended list -> 403" GET "" "$ADM_SUSP" 403 Forbidden
t "admin pending DELETE -> 403" DELETE "/1" "$ADM_PENDING" 403 Forbidden
t "patient pending list -> 403" GET "" "$PAT_PENDING" 403 Forbidden
t "patient pending get -> 403" GET "/1" "$PAT_PENDING" 403 Forbidden
t "patient suspended list -> 403" GET "" "$PAT_SUSP" 403 Forbidden
t "doctor suspended list -> 403" GET "" "$DOC_SUSP" 403 Forbidden
t "doctor suspended get -> 403" GET "/1" "$DOC_SUSP" 403 Forbidden
val "no help_articles row was written by any rejected call" "row count" "0" "$(sql "SELECT count(*) FROM help_articles")"
val "no help_article audit row from rejected calls" "audit delta since the start of this run" "0" "$(( $(audit_total) - AUD_START ))"

# ------------------------------------------------------------------------------------------------------------------------------
section "3. Create (admin): happy paths, shapes, audit"
AUD0="$(audit_total)"
mkjson "$TMP/f1.json" "({title:'$P-pat-pub',body:'# Heading\n\n<script>alert(1)</script>\n\tTabbed line\n\nAstral: \u{1F600}\u{1F3E5} café $MARKER\n',category:'how-it-works',audience:'patient',isPublished:true})"
t "admin POST published patient article -> 201" POST "" "$ADMIN" 201 - "@$TMP/f1.json"; F1_RID="$RID"
F1="$(jf data.id)"
val "201 data keys are exactly the contract HelpArticle required list" "keys" "audience,body,category,createdAt,id,isPublished,publishedAt,title,updatedAt" "$(keys_of)"
fld "isPublished=true -> isPublished true" data.isPublished true
val "publishedAt is set when created published" "publishedAt" "1" "$([[ "$(jf data.publishedAt)" == 20* ]] && echo 1 || echo 0)"
val "Content-Type is JSON" "content-type" "application/json; charset=utf-8" "$(header Content-Type)"
val "audit row written for the create (exactly 1 for this id)" "count" "1" "$(audit_count "$F1")"
ROW="$(audit_row "$F1")"
val "audit row: action|actor|role|request_id" "audit" "help_article.created|1|admin|$F1_RID" "$(printf '%s' "$ROW" | cut -d'|' -f1-4)"
val "audit metadata is exactly isPublishedBefore=null, isPublishedAfter=true" "metadata" '{"isPublishedAfter": true, "isPublishedBefore": null}' "$(printf '%s' "$ROW" | cut -d'|' -f5-)"
t "GET the created article as admin" GET "/$F1" "$ADMIN" 200 -
node -e '
  const fs=require("fs"); const got=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).data.body; const sent=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).body;
  process.stdout.write(got===sent?"identical":"DIFFERENT")' "$(nodepath "$TMP/body")" "$(nodepath "$TMP/f1.json")" > "$TMP/verb"
val "body is returned byte for byte (HTML, newlines, tab, astral, accent)" "verbatim" "identical" "$(cat "$TMP/verb")"

t "admin POST draft patient article (cancellation-policy)" POST "" "$ADMIN" 201 - "{\"title\":\"$P-pat-draft\",\"body\":\"Synthetic draft $MARKER\",\"category\":\"cancellation-policy\",\"audience\":\"patient\",\"isPublished\":false}"
F2="$(jf data.id)"; fld "draft publishedAt is null" data.publishedAt null
t "admin POST published doctor article (platform-rules)" POST "" "$ADMIN" 201 - "{\"title\":\"$P-doc-pub\",\"body\":\"Synthetic doctor body $MARKER\",\"category\":\"platform-rules\",\"audience\":\"doctor\",\"isPublished\":true}"
F3="$(jf data.id)"
t "admin POST draft doctor article" POST "" "$ADMIN" 201 - "{\"title\":\"$P-doc-draft\",\"body\":\"Synthetic doctor draft\",\"category\":\"platform-rules\",\"audience\":\"doctor\",\"isPublished\":false}"
F4="$(jf data.id)"
t "admin POST published patient article (preparing-for-consultation)" POST "" "$ADMIN" 201 - "{\"title\":\"$P-pat-prep\",\"body\":\"Synthetic prep body\",\"category\":\"preparing-for-consultation\",\"audience\":\"patient\",\"isPublished\":true}"
F5="$(jf data.id)"
t "admin POST a published patient article destined for deletion" POST "" "$ADMIN" 201 - "{\"title\":\"$P-pat-gone\",\"body\":\"Synthetic body to be deleted\",\"category\":\"how-it-works\",\"audience\":\"patient\",\"isPublished\":true}"
F6="$(jf data.id)"
t "title of exactly 3 characters is accepted" POST "" "$ADMIN" 201 - '{"title":"QA-HA-3ch","body":"b","category":"how-it-works","audience":"doctor","isPublished":false}'
F7="$(jf data.id)"
t "unicode title with leading spaces (not trimmed) accepted" POST "" "$ADMIN" 201 - "{\"title\":\"  $P-spaces \",\"body\":\"   \",\"category\":\"how-it-works\",\"audience\":\"doctor\",\"isPublished\":false}"
fld "title returned untrimmed" data.title "  $P-spaces "
F8="$(jf data.id)"
val "creates wrote one audit row each (8 articles)" "audit delta" "8" "$(( $(audit_total) - AUD0 ))"

section "3b. Create: duplicates and validation"
A1="$(audit_total)"
t "duplicate (audience,title) -> 409 Conflict" POST "" "$ADMIN" 409 Conflict "{\"title\":\"$P-pat-pub\",\"body\":\"another\",\"category\":\"platform-rules\",\"audience\":\"patient\",\"isPublished\":true}"
fld "409 details[0].field = title" error.details '[{"field":"title","issue":"is already in use for this audience"}]'
val "409 left no audit row" "audit delta" "0" "$(( $(audit_total) - A1 ))"
val "409 left no extra article row" "rows with that title" "1" "$(sql "SELECT count(*) FROM help_articles WHERE title = '$P-pat-pub'")"
t "same title in the OTHER audience -> 201" POST "" "$ADMIN" 201 - "{\"title\":\"$P-pat-pub\",\"body\":\"doctor copy\",\"category\":\"how-it-works\",\"audience\":\"doctor\",\"isPublished\":false}"
F9="$(jf data.id)"
t "title differing only by case -> 201 (case-sensitive uniqueness)" POST "" "$ADMIN" 201 - "{\"title\":\"$(echo "$P-PAT-PUB" | tr 'A-Z' 'A-Z')\",\"body\":\"case\",\"category\":\"how-it-works\",\"audience\":\"patient\",\"isPublished\":false}"
F10="$(jf data.id)"

V400() { # V400 <label> <js object expression>
  mkjson "$TMP/v.json" "$2"; t "$1" POST "" "$ADMIN" 400 ValidationFailed "@$TMP/v.json"
}
V400 "title of 2 chars -> 400" "({title:'ab',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"; fld "  details[0].field" error.details.0.field title
V400 "title of 201 chars -> 400" "({title:'x'.repeat(201),body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "title with newline -> 400" "({title:'abc\ndef',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "title with BEL control char -> 400" "({title:'abc\u0007def',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "title with tab -> 400" "({title:'abc\tdef',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "title not a string -> 400" "({title:12345,body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "title missing -> 400" "({body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "body empty -> 400" "({title:'$P-v',body:'',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "body missing -> 400" "({title:'$P-v',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "body with NUL -> 400" "({title:'$P-v',body:'abc\u0000def',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "category not in enum -> 400" "({title:'$P-v',body:'b',category:'other',audience:'patient',isPublished:false})"
V400 "audience 'admin' -> 400" "({title:'$P-v',body:'b',category:'how-it-works',audience:'admin',isPublished:false})"
V400 "audience missing -> 400" "({title:'$P-v',body:'b',category:'how-it-works',isPublished:false})"
V400 "isPublished missing (no default) -> 400" "({title:'$P-v',body:'b',category:'how-it-works',audience:'patient'})"
V400 "isPublished as string 'true' -> 400" "({title:'$P-v',body:'b',category:'how-it-works',audience:'patient',isPublished:'true'})"
V400 "isPublished null -> 400" "({title:'$P-v',body:'b',category:'how-it-works',audience:'patient',isPublished:null})"
V400 "unknown member id -> 400" "({id:5,title:'$P-v',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "unknown member publishedAt -> 400" "({publishedAt:'2026-01-01T00:00:00Z',title:'$P-v',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "unknown member createdBy -> 400" "({createdBy:1,title:'$P-v',body:'b',category:'how-it-works',audience:'patient',isPublished:false})"
V400 "JSON array body -> 400" "([1,2])"
V400 "JSON null body -> 400" "(null)"
t "malformed JSON -> 400" POST "" "$ADMIN" 400 ValidationFailed '{"title": '
t "empty body -> 400" POST "" "$ADMIN" 400 ValidationFailed
val "no article created by the 400 cases" "rows named $P-v" "0" "$(sql "SELECT count(*) FROM help_articles WHERE title = '$P-v'")"

section "3c. Create: body size boundaries (50,000 accepted, 50,001 rejected, 100 kb request cap)"
mkjson "$TMP/b50000.json" "({title:'$P-big-ok',body:'a'.repeat(50000),category:'how-it-works',audience:'doctor',isPublished:false})"
t "body of exactly 50,000 chars -> 201" POST "" "$ADMIN" 201 - "@$TMP/b50000.json"; FBIG="$(jf data.id)"
val "stored length is 50000" "char_length(body)" "50000" "$(sql "SELECT char_length(body) FROM help_articles WHERE id = $FBIG")"
t "GET it back: body length 50000" GET "/$FBIG" "$ADMIN" 200 -
val "returned body length" "length" "50000" "$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String([...b.data.body].length))' "$(nodepath "$TMP/body")")"
mkjson "$TMP/b50001.json" "({title:'$P-big-bad',body:'a'.repeat(50001),category:'how-it-works',audience:'doctor',isPublished:false})"
t "body of 50,001 chars -> 400" POST "" "$ADMIN" 400 ValidationFailed "@$TMP/b50001.json"; fld "  details[0].field" error.details.0.field body
mkjson "$TMP/b50000astral.json" "({title:'$P-big-astral',body:'\u{1F600}'.repeat(24000),category:'how-it-works',audience:'doctor',isPublished:false})"
t "24,000 astral chars (96 KB, code points counted not UTF-16 units) -> 201" POST "" "$ADMIN" 201 - "@$TMP/b50000astral.json"; FAST="$(jf data.id)"
mkjson "$TMP/b100k.json" "({title:'$P-big-100k',body:'\u{1F600}'.repeat(30000),category:'how-it-works',audience:'doctor',isPublished:false})"
t "30,000 astral chars = 120 KB request > 100 kb parser limit -> 400 ValidationFailed" POST "" "$ADMIN" 400 ValidationFailed "@$TMP/b100k.json"
fld "  details[0].issue (HA-D13)" error.details.0.issue "must not exceed 100kb"
mkjson "$TMP/b50000p2.json" "({body:'b'.repeat(50000)})"
t "PATCH body to 50,000 chars -> 200" PATCH "/$FBIG" "$ADMIN" 200 - "@$TMP/b50000p2.json"
mkjson "$TMP/b50001p.json" "({body:'a'.repeat(50001)})"
t "PATCH body to 50,001 chars -> 400" PATCH "/$FBIG" "$ADMIN" 400 ValidationFailed "@$TMP/b50001p.json"
sql "DELETE FROM help_articles WHERE id IN ($FBIG, $FAST)" >/dev/null   # owner cleanup of the big fixtures (keeps the list pages small)

# ------------------------------------------------------------------------------------------------------------------------------
section "4. Create: idempotency (POST only)"
mkjson "$TMP/i1.json" "({title:'$P-idem',body:'Synthetic idem body',category:'how-it-works',audience:'doctor',isPublished:false})"
mkjson "$TMP/i2.json" "({title:'$P-idem',body:'Synthetic DIFFERENT body',category:'how-it-works',audience:'doctor',isPublished:false})"
K1="$(uuid)"
A2="$(audit_total)"
EXTRA=(-H "Idempotency-Key: $K1"); t "POST with Idempotency-Key -> 201" POST "" "$ADMIN" 201 - "@$TMP/i1.json"; IDEM1="$(jf data.id)"; IDEM_BODY1="$(cat "$TMP/body")"
EXTRA=(-H "Idempotency-Key: $K1"); t "same key + same body -> original 201 replayed" POST "" "$ADMIN" 201 - "@$TMP/i1.json"
val "replay returns the same id" "id" "$IDEM1" "$(jf data.id)"
val "replay body identical to the original" "body" "$IDEM_BODY1" "$(cat "$TMP/body")"
val "exactly one row for that title" "rows" "1" "$(sql "SELECT count(*) FROM help_articles WHERE title = '$P-idem' AND audience = 'doctor'")"
val "exactly one audit row for the replayed create" "audit delta" "1" "$(( $(audit_total) - A2 ))"
EXTRA=(-H "Idempotency-Key: $K1"); t "same key + different body -> 422 IdempotencyConflict" POST "" "$ADMIN" 422 IdempotencyConflict "@$TMP/i2.json"
EXTRA=(-H "Idempotency-Key: not-a-uuid"); t "Idempotency-Key not a UUID -> 400" POST "" "$ADMIN" 400 ValidationFailed "@$TMP/i1.json"
t "no key, same body again -> 409 Conflict (unique title)" POST "" "$ADMIN" 409 Conflict "@$TMP/i1.json"
K2="$(uuid)"
EXTRA=(-H "Idempotency-Key: $K2"); t "a NEW key, same body (title taken) -> 409 Conflict" POST "" "$ADMIN" 409 Conflict "@$TMP/i1.json"
EXTRA=(-H "Idempotency-Key: $K2"); t "replay of that 409 (same key, same body) -> 409 again" POST "" "$ADMIN" 409 Conflict "@$TMP/i1.json"
K3="$(uuid)"
mkjson "$TMP/i3.json" "({title:'$P-idem-3',body:'b',category:'how-it-works',audience:'doctor',isPublished:false})"
EXTRA=(-H "Idempotency-Key: $K3"); t "POST with another fresh key -> 201" POST "" "$ADMIN" 201 - "@$TMP/i3.json"; IDEM3="$(jf data.id)"
EXTRA=(-H "Idempotency-Key: $K3"); t "PATCH with an Idempotency-Key is accepted and ignored (not declared on PATCH)" PATCH "/$IDEM3" "$ADMIN" 200 - '{"body":"b2"}'
EXTRA=(-H "Idempotency-Key: $K3"); t "DELETE with an Idempotency-Key header is ignored" DELETE "/$IDEM3" "$ADMIN" 204 -

section "4b. Create: concurrency (two parallel POSTs of one (audience,title), different keys)"
CT="{\"title\":\"$P-race\",\"body\":\"race\",$VALID}"
for n in 1 2; do
  ( curl -s -o "$TMP/race$n.body" -w '%{http_code}' -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuid)" -H "X-Request-Id: $(uuid)" --data-binary "$CT" "$BASE" > "$TMP/race$n.status" ) &
done
wait
val "parallel POSTs: exactly one 201 and one 409" "statuses" "201 409" "$(printf '%s\n%s\n' "$(cat "$TMP/race1.status")" "$(cat "$TMP/race2.status")" | sort | tr '\n' ' ' | sed 's/ $//')"
val "parallel POSTs: exactly one row" "rows" "1" "$(sql "SELECT count(*) FROM help_articles WHERE title = '$P-race'")"
WRITES=$((WRITES + 2))

section "4c. Create: two parallel POSTs with the SAME Idempotency-Key and body (in-flight lock or replay)"
KF="$(uuid)"; CT2="{\"title\":\"$P-flight\",\"body\":\"flight\",$VALID}"
for n in 1 2; do
  ( curl -s -o "$TMP/fl$n.body" -D "$TMP/fl$n.hdr" -w '%{http_code}' -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "Idempotency-Key: $KF" -H "X-Request-Id: $(uuid)" --data-binary "$CT2" "$BASE" > "$TMP/fl$n.status" ) &
done
wait
FL="$(printf '%s\n%s\n' "$(cat "$TMP/fl1.status")" "$(cat "$TMP/fl2.status")" | sort | tr '\n' ' ' | sed 's/ $//')"
if [ "$FL" = "201 201" ]; then FLOK=1; FLN="replayed (first finished before the second arrived)"
elif [ "$FL" = "201 409" ] && grep -qi '^retry-after: 1' "$TMP/fl1.hdr" "$TMP/fl2.hdr"; then FLOK=1; FLN="in-flight 409 with Retry-After: 1"
else FLOK=0; FLN="unexpected"; fi
REQ_METHOD=POST; REQ_PATH=/api/help-articles; REQ_ROLE=admin
record "same key twice in parallel: 201+201 (replay) or 201+409 with Retry-After: 1 ($FLN)" "statuses" "201 201 | 201 409+Retry-After" "$FL" "$FLOK"
val "never two rows for the title" "rows" "1" "$(sql "SELECT count(*) FROM help_articles WHERE title = '$P-flight'")"
WRITES=$((WRITES + 2))

# ------------------------------------------------------------------------------------------------------------------------------
section "5. Delete (soft) then 404 for everyone; title reuse"
A3="$(audit_total)"
t "admin DELETE F6 -> 204, empty body" DELETE "/$F6" "$ADMIN" 204 -
val "row still exists with deleted_at set (soft delete)" "deleted_at set" "t" "$(sql "SELECT deleted_at IS NOT NULL FROM help_articles WHERE id = $F6")"
ROW="$(audit_row "$F6")"
val "audit: help_article.deleted by admin 1" "audit" "help_article.deleted|1|admin" "$(printf '%s' "$ROW" | cut -d'|' -f1-3)"
val "audit metadata isPublishedBefore=true, isPublishedAfter=null" "metadata" '{"isPublishedAfter": null, "isPublishedBefore": true}' "$(printf '%s' "$ROW" | cut -d'|' -f5-)"
val "delete wrote exactly one audit row" "audit delta" "1" "$(( $(audit_total) - A3 ))"
t "admin GET the deleted article -> 404" GET "/$F6" "$ADMIN" 404 NotFound
t "patient GET the deleted article -> 404" GET "/$F6" "$PATIENT" 404 NotFound
t "doctor GET the deleted article -> 404" GET "/$F6" "$DOCTOR" 404 NotFound
t "admin PATCH the deleted article -> 404" PATCH "/$F6" "$ADMIN" 404 NotFound '{"title":"Zzz deleted"}'
t "second DELETE of the same article -> 404" DELETE "/$F6" "$ADMIN" 404 NotFound
t "title of the deleted article is reusable -> 201" POST "" "$ADMIN" 201 - "{\"title\":\"$P-pat-gone\",\"body\":\"reborn\",\"category\":\"how-it-works\",\"audience\":\"patient\",\"isPublished\":false}"
F6B="$(jf data.id)"
val "the new article has a new id" "id differs" "1" "$([ "$F6B" != "$F6" ] && echo 1 || echo 0)"
t "DELETE unknown id -> 404" DELETE "/999999" "$ADMIN" 404 NotFound
for bad in abc 0 007 -1 1.5 9007199254740993; do
  t "admin DELETE non-canonical id '$bad' -> 404" DELETE "/$bad" "$ADMIN" 404 NotFound
done

# ------------------------------------------------------------------------------------------------------------------------------
section "6. Update (PATCH): partial, publish/unpublish, no-op, category and audience change"
A4="$(audit_total)"; UPD0="$(sql "SELECT updated_at::text FROM help_articles WHERE id = $F2")"
t "PATCH title + body of the draft F2 -> 200" PATCH "/$F2" "$ADMIN" 200 - "{\"title\":\"$P-pat-draft-v2\",\"body\":\"Synthetic edited $MARKER\"}"; P_RID="$RID"
fld "title changed" data.title "$P-pat-draft-v2"
fld "still a draft" data.isPublished false
val "updated_at moved forward" "updated_at" "1" "$([ "$(sql "SELECT updated_at > '$UPD0'::timestamptz FROM help_articles WHERE id = $F2")" = t ] && echo 1 || echo 0)"
ROW="$(audit_row "$F2")"
val "audit: updated by admin 1 with the request id" "audit" "help_article.updated|1|admin|$P_RID" "$(printf '%s' "$ROW" | cut -d'|' -f1-4)"
val "audit metadata: sorted changedFields, no title or body" "metadata" '{"changedFields": "body,title", "isPublishedAfter": false, "isPublishedBefore": false}' "$(printf '%s' "$ROW" | cut -d'|' -f5-)"
val "exactly one audit row for the update" "audit delta" "1" "$(( $(audit_total) - A4 ))"

t "publish the draft F2 -> publishedAt set" PATCH "/$F2" "$ADMIN" 200 - '{"isPublished":true}'
PUB1="$(jf data.publishedAt)"; val "publishedAt is set on first publish" "publishedAt" "1" "$([[ "$PUB1" == 20* ]] && echo 1 || echo 0)"
fld "audit-visible isPublished" data.isPublished true
val "audit changedFields = isPublished, before false after true" "metadata" '{"changedFields": "isPublished", "isPublishedAfter": true, "isPublishedBefore": false}' "$(audit_row "$F2" | cut -d'|' -f5-)"
sleep 1
t "unpublish F2 -> publishedAt kept" PATCH "/$F2" "$ADMIN" 200 - '{"isPublished":false}'
fld "isPublished false" data.isPublished false; fld "publishedAt unchanged after unpublish" data.publishedAt "$PUB1"
t "re-publish F2 -> original publishedAt kept" PATCH "/$F2" "$ADMIN" 200 - '{"isPublished":true}'
fld "publishedAt unchanged after re-publish" data.publishedAt "$PUB1"
t "patient can now read F2 by id" GET "/$F2" "$PATIENT" 200 -
t "unpublish again, patient gets 404 immediately" PATCH "/$F2" "$ADMIN" 200 - '{"isPublished":false}'
t "patient GET unpublished F2 -> 404" GET "/$F2" "$PATIENT" 404 NotFound
t "re-publish F2 for the later list cases" PATCH "/$F2" "$ADMIN" 200 - '{"isPublished":true}'

section "6b. PATCH: no-op, partial equal, category and audience change"
t "rename F9 (doctor copy of the same title) away first" PATCH "/$F9" "$ADMIN" 200 - "{\"title\":\"$P-doc-copy\"}"
A5="$(audit_total)"; UPD1="$(sql "SELECT updated_at::text FROM help_articles WHERE id = $F1")"
t "no-op PATCH (every value equals stored) -> 200" PATCH "/$F1" "$ADMIN" 200 - "{\"title\":\"$P-pat-pub\",\"category\":\"how-it-works\",\"isPublished\":true}"
val "no-op wrote no audit row" "audit delta" "0" "$(( $(audit_total) - A5 ))"
val "no-op left updated_at unchanged" "updated_at" "$UPD1" "$(sql "SELECT updated_at::text FROM help_articles WHERE id = $F1")"
t "partly equal PATCH (title same, category changes) -> 200" PATCH "/$F1" "$ADMIN" 200 - "{\"title\":\"$P-pat-pub\",\"category\":\"platform-rules\"}"
fld "category changed" data.category platform-rules
val "audit changedFields lists only category" "metadata" '{"changedFields": "category", "isPublishedAfter": true, "isPublishedBefore": true}' "$(audit_row "$F1" | cut -d'|' -f5-)"
val "updated_at moved on the real change" "updated_at" "1" "$([ "$(sql "SELECT updated_at::text FROM help_articles WHERE id = $F1")" != "$UPD1" ] && echo 1 || echo 0)"
t "own current title in the PATCH is not a 409 against itself -> 200 (no-op)" PATCH "/$F1" "$ADMIN" 200 - "{\"title\":\"$P-pat-pub\"}"
t "PATCH category AND audience of a PUBLISHED article in one call (no unpublish) -> 200" PATCH "/$F1" "$ADMIN" 200 - '{"category":"cancellation-policy","audience":"doctor"}'
fld "audience now doctor" data.audience doctor; fld "still published" data.isPublished true
val "audit changedFields = audience,category" "metadata" '{"changedFields": "audience,category", "isPublishedAfter": true, "isPublishedBefore": true}' "$(audit_row "$F1" | cut -d'|' -f5-)"
t "patient no longer sees F1 -> 404" GET "/$F1" "$PATIENT" 404 NotFound
t "doctor now sees F1 -> 200" GET "/$F1" "$DOCTOR" 200 -
t "move F1 back to the patient audience and category" PATCH "/$F1" "$ADMIN" 200 - '{"category":"how-it-works","audience":"patient"}'
t "patient sees F1 again -> 200" GET "/$F1" "$PATIENT" 200 -
t "PATCH title to one taken in the same audience -> 409 Conflict" PATCH "/$F5" "$ADMIN" 409 Conflict "{\"title\":\"$P-pat-pub\"}"
fld "409 details" error.details '[{"field":"title","issue":"is already in use for this audience"}]'
val "the 409 PATCH changed nothing" "title of F5" "$P-pat-prep" "$(sql "SELECT title FROM help_articles WHERE id = $F5")"
A6="$(audit_total)"
t "give F9 (doctor) the title of F1 (patient): allowed, different audience" PATCH "/$F9" "$ADMIN" 200 - "{\"title\":\"$P-pat-pub\"}"
t "moving F1 to the doctor audience now collides on the RESULTING (audience,title) -> 409" PATCH "/$F1" "$ADMIN" 409 Conflict '{"audience":"doctor"}'
val "the colliding move left F1 in the patient audience" "audience" "patient" "$(sql "SELECT audience FROM help_articles WHERE id = $F1")"
val "only the F9 rename (200) wrote an audit row, the 409 wrote none" "audit delta" "1" "$(( $(audit_total) - A6 ))"
t "rename F9 away again" PATCH "/$F9" "$ADMIN" 200 - "{\"title\":\"$P-doc-copy\"}"

section "6c. PATCH: validation and ids"
t "PATCH {} -> 400 'must contain at least one property'" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{}'
fld "  details" error.details '[{"field":"body","issue":"must contain at least one property"}]'
t "PATCH title:null -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"title":null}'
t "PATCH isPublished:'true' -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"isPublished":"true"}'
t "PATCH publishedAt (server-derived) -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"publishedAt":"2026-01-01T00:00:00Z"}'
t "PATCH id member -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"id":99}'
t "PATCH createdAt member -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"createdAt":"2026-01-01T00:00:00Z"}'
t "PATCH title 2 chars -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"title":"ab"}'
t "PATCH title with newline -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"title":"abc\ndef"}'
t "PATCH body '' -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"body":""}'
t "PATCH body with NUL escape -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"body":"a\u0000b"}'
t "PATCH category 'other' -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"category":"other"}'
t "PATCH audience 'admin' -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"audience":"admin"}'
t "PATCH malformed JSON -> 400" PATCH "/$F1" "$ADMIN" 400 ValidationFailed '{"title": '
t "PATCH unknown id -> 404" PATCH "/999999" "$ADMIN" 404 NotFound '{"title":"abc"}'
for bad in abc 0 007 -1 1.5 9007199254740993; do
  t "admin PATCH non-canonical id '$bad' -> 404" PATCH "/$bad" "$ADMIN" 404 NotFound '{"title":"abc"}'
done

# ------------------------------------------------------------------------------------------------------------------------------
section "7. Reads: visibility per role (oracle = owner SQL)"
A7="$(audit_total)"
PAT_EXP="$(READER_ORACLE patient)"; DOC_EXP="$(READER_ORACLE doctor)"; ADM_EXP="$(ADMIN_ORACLE)"
t "patient list -> 200" GET "" "$PATIENT" 200 -
val "patient sees exactly the published patient articles, published_at DESC, id DESC" "ids" "$PAT_EXP" "$(ids_of)"
val "list item keys: no body, no createdAt" "keys" "audience,category,id,isPublished,publishedAt,title,updatedAt" "$(keys_of)"
fld "meta shape (nextCursor,hasMore,count)" meta "{\"nextCursor\":null,\"hasMore\":false,\"count\":$(echo "$PAT_EXP" | tr ',' '\n' | grep -c .)}"
t "doctor (active) list -> 200" GET "" "$DOCTOR" 200 -
val "doctor sees exactly the published doctor articles" "ids" "$DOC_EXP" "$(ids_of)"
t "doctor pending list -> 200 (onboarding)" GET "" "$DOC_PENDING" 200 -
val "pending doctor sees the same ids" "ids" "$DOC_EXP" "$(ids_of)"
t "doctor rejected list -> 200" GET "" "$DOC_REJECTED" 200 -
val "rejected doctor sees the same ids" "ids" "$DOC_EXP" "$(ids_of)"
t "admin list -> 200 (drafts included, both audiences)" GET "" "$ADMIN" 200 -
val "admin sees all live rows, updated_at DESC, id DESC" "ids" "$ADM_EXP" "$(ids_of)"
val "admin list items also have no body" "keys" "audience,category,id,isPublished,publishedAt,title,updatedAt" "$(keys_of)"
val "the deleted article is absent from the admin list" "contains F6" "0" "$(echo ",$(ids_of)," | grep -c ",$F6,")"
val "the draft IS in the admin list" "contains F4" "1" "$(echo ",$(ids_of)," | grep -c ",$F4,")"
val "the doctor draft F4 is NOT in the doctor list" "contains F4" "0" "$(echo ",$DOC_EXP," | grep -c ",$F4,")"
val "the published doctor article F3 is NOT in the patient list" "contains F3" "0" "$(echo ",$PAT_EXP," | grep -c ",$F3,")"
t "patient list with audience=doctor&isPublished=false ignored (HA-D10)" GET "?audience=doctor&isPublished=false" "$PATIENT" 200 -
val "same ids as the plain patient list" "ids" "$PAT_EXP" "$(ids_of)"
t "doctor list with audience=patient&isPublished=false ignored" GET "?audience=patient&isPublished=false" "$DOCTOR" 200 -
val "same ids as the plain doctor list" "ids" "$DOC_EXP" "$(ids_of)"
t "patient category filter" GET "?category=preparing-for-consultation" "$PATIENT" 200 -
val "only the preparing-for-consultation patient article" "ids" "$F5" "$(ids_of)"
t "admin audience=doctor filter" GET "?audience=doctor" "$ADMIN" 200 -
val "admin audience=doctor oracle" "ids" "$(sql "SELECT coalesce(string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC), '') FROM help_articles WHERE audience='doctor' AND deleted_at IS NULL")" "$(ids_of)"
t "admin isPublished=false filter (drafts only)" GET "?isPublished=false" "$ADMIN" 200 -
val "admin drafts oracle" "ids" "$(sql "SELECT coalesce(string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC), '') FROM help_articles WHERE NOT is_published AND deleted_at IS NULL")" "$(ids_of)"
t "admin isPublished=true&audience=patient&category filter" GET "?isPublished=true&audience=patient&category=preparing-for-consultation" "$ADMIN" 200 -
val "combined admin filters" "ids" "$F5" "$(ids_of)"
t "admin filter with no match -> empty page" GET "?category=platform-rules&audience=patient&isPublished=false" "$ADMIN" 200 -
fld "empty page meta" meta '{"nextCursor":null,"hasMore":false,"count":0}'
fld "empty page data" data '[]'

t "patient GET published own-audience F5 -> 200" GET "/$F5" "$PATIENT" 200 -
val "detail keys (body included)" "keys" "audience,body,category,createdAt,id,isPublished,publishedAt,title,updatedAt" "$(keys_of)"
t "patient GET unpublished doctor draft F4 -> 404" GET "/$F4" "$PATIENT" 404 NotFound; NF_BODY="$(jf error.code error.message error.details)"
t "patient GET other-audience published F3 -> 404" GET "/$F3" "$PATIENT" 404 NotFound
val "other-audience 404 body identical to the draft 404" "code|message|details" "$NF_BODY" "$(jf error.code error.message error.details)"
t "patient GET unknown id -> 404" GET "/999999" "$PATIENT" 404 NotFound
val "unknown-id 404 body identical to the hidden-article 404" "code|message|details" "$NF_BODY" "$(jf error.code error.message error.details)"
t "doctor GET published doctor article F3 -> 200" GET "/$F3" "$DOCTOR" 200 -
t "doctor GET patient article F5 -> 404" GET "/$F5" "$DOCTOR" 404 NotFound
t "doctor GET own-audience draft F4 -> 404" GET "/$F4" "$DOCTOR" 404 NotFound
t "pending doctor GET F3 -> 200" GET "/$F3" "$DOC_PENDING" 200 -
t "rejected doctor GET F3 -> 200" GET "/$F3" "$DOC_REJECTED" 200 -
t "pending doctor GET draft F4 -> 404" GET "/$F4" "$DOC_PENDING" 404 NotFound
t "admin GET draft F4 -> 200" GET "/$F4" "$ADMIN" 200 -
t "admin GET patient published F5 -> 200" GET "/$F5" "$ADMIN" 200 -
for bad in abc 0 007 -1 1.5 9007199254740993 999999; do
  t "admin GET id '$bad' -> 404" GET "/$bad" "$ADMIN" 404 NotFound
done
t "patient GET id 'abc' -> 404" GET "/abc" "$PATIENT" 404 NotFound
val "reads wrote no audit row (HA-R14)" "audit delta" "0" "$(( $(audit_total) - A7 ))"

section "7b. Reads: query validation (the compiled build converts nothing implicitly)"
for q in "limit=0" "limit=101" "limit=1.5" "limit=abc" "limit=1e1" "limit=05" "limit=-1" "limit=" \
         "category=other" "category=" "audience=admin" "audience=Patient" "isPublished=yes" "isPublished=1" "isPublished=TRUE" "isPublished=" \
         "unknown=1" "cursor=" "cursor=garbage"; do
  t "patient list ?$q -> 400" GET "?$q" "$PATIENT" 400 ValidationFailed
done
t "admin list ?isPublished=yes -> 400 (compiled-build #8 check)" GET "?isPublished=yes" "$ADMIN" 400 ValidationFailed
t "isPublished repeated -> 400" GET "?isPublished=true&isPublished=false" "$ADMIN" 400 ValidationFailed
t "admin list ?isPublished=true -> 200" GET "?isPublished=true" "$ADMIN" 200 -
t "admin list ?isPublished=false -> 200" GET "?isPublished=false" "$ADMIN" 200 -
t "limit=1 -> one row, hasMore" GET "?limit=1" "$PATIENT" 200 -
fld "meta.count 1 and hasMore" meta "$(printf '{"nextCursor":"%s","hasMore":true,"count":1}' "$(jf meta.nextCursor)")"
t "limit=100 -> 200" GET "?limit=100" "$PATIENT" 200 -
t "valid base64url of a non-array cursor -> 400" GET "?cursor=$(b64url '{"a":1}')" "$PATIENT" 400 ValidationFailed
fld "  cursor error detail" error.details '[{"field":"cursor","issue":"is invalid"}]'
t "numeric sort value cursor -> 400" GET "?cursor=$(b64url '[123,5]')" "$PATIENT" 400 ValidationFailed
t "id 0 cursor -> 400" GET "?cursor=$(b64url '["published:2026-03-01T00:00:00.000000Z",0]')" "$PATIENT" 400 ValidationFailed
t "millisecond-only timestamp cursor -> 400" GET "?cursor=$(b64url '["published:2026-03-01T00:00:00.000Z",5]')" "$PATIENT" 400 ValidationFailed
t "impossible date cursor -> 400" GET "?cursor=$(b64url '["published:2026-02-31T00:00:00.000000Z",5]')" "$PATIENT" 400 ValidationFailed
t "cursor without a kind prefix -> 400" GET "?cursor=$(b64url '["2026-03-01T00:00:00.000000Z",5]')" "$PATIENT" 400 ValidationFailed
t "admin-kind cursor given to a patient -> 400" GET "?cursor=$(b64url '["updated:2026-03-01T00:00:00.000000Z",5]')" "$PATIENT" 400 ValidationFailed
t "patient-kind cursor given to an admin -> 400" GET "?cursor=$(b64url '["published:2026-03-01T00:00:00.000000Z",5]')" "$ADMIN" 400 ValidationFailed
t "cursor longer than 1024 chars -> 400" GET "?cursor=$(node -e 'process.stdout.write("A".repeat(1100))')" "$PATIENT" 400 ValidationFailed
t "NUL inside the cursor sort value -> 400" GET "?cursor=$(b64url '["published:2026-03-01T00:00:00.000000Z\u0000",5]')" "$PATIENT" 400 ValidationFailed
t "well-formed forged cursor is accepted as a POSITION only (no widening): patient still sees only own audience" GET "?cursor=$(b64url '["published:2099-01-01T00:00:00.000000Z",999999]')" "$PATIENT" 200 -
val "forged cursor returns only patient-visible ids" "ids subset of oracle" "$PAT_EXP" "$(ids_of)"

# ------------------------------------------------------------------------------------------------------------------------------
section "8. Pagination: page 2 and last page on both default sorts (45 seeded rows with timestamp ties)"
sql "INSERT INTO help_articles (title, body, category, audience, is_published, published_at, created_by, updated_by, created_at, updated_at)
     SELECT 'QA-HA-PG-' || lpad(i::text, 3, '0'), 'Synthetic pagination body', 'how-it-works', 'patient', true,
            timestamptz '2026-03-01 00:00:00+00' + (i/3) * interval '1 second' + (i/3) * interval '7 microseconds',
            1, 1, now(), timestamptz '2026-03-02 00:00:00+00' + (i/3) * interval '1 second' + (i/3) * interval '7 microseconds'
     FROM generate_series(1, 45) AS i" >/dev/null
PAT_ALL="$(READER_ORACLE patient)"; ADM_ALL="$(ADMIN_ORACLE)"
page_all() { # page_all <token> -> sets PAGES (counts "n,n,n"), ALL_IDS (ids in order), and checks cursors chain
  local tok="$1" cur="" out="" counts="" n=0 more=true
  while [ "$more" = true ] && [ "$n" -lt 20 ]; do
    if [ -z "$cur" ]; then call GET "" "$tok"; else call GET "?cursor=$cur" "$tok"; fi
    [ "$ST" = 200 ] || { ALL_IDS="status-$ST"; PAGES=""; return; }
    out="$out${out:+,}$(ids_of)"; counts="$counts${counts:+,}$(jf meta.count)"
    more="$(jf meta.hasMore)"; cur="$(jf meta.nextCursor)"; n=$((n + 1))
    [ "$more" = true ] || break
  done
  ALL_IDS="$out"; PAGES="$counts"; LAST_NEXT="$cur"; LAST_MORE="$more"
}
t "patient page 1 (default limit 20)" GET "" "$PATIENT" 200 -
fld "page 1 count 20 / hasMore true" meta.count 20; fld "hasMore" meta.hasMore true
CUR1="$(jf meta.nextCursor)"
val "nextCursor is an opaque non-empty string" "cursor" "1" "$([ -n "$CUR1" ] && [ "$CUR1" != null ] && echo 1 || echo 0)"
P1_IDS="$(ids_of)"
t "patient PAGE 2 with the page-1 cursor" GET "?cursor=$CUR1" "$PATIENT" 200 -
fld "page 2 count 20" meta.count 20; fld "page 2 hasMore true" meta.hasMore true
P2_IDS="$(ids_of)"
val "page 2 does not overlap page 1" "overlap" "0" "$(comm -12 <(echo "$P1_IDS" | tr ',' '\n' | sort) <(echo "$P2_IDS" | tr ',' '\n' | sort) | grep -c . || true)"
page_all "$PATIENT"
val "patient: paging through returns every visible row exactly once in published_at DESC, id DESC order" "ids" "$PAT_ALL" "$ALL_IDS"
val "patient: page sizes 20,20,N,... then the last page has hasMore=false and nextCursor null" "last page" "false|null" "$LAST_MORE|$LAST_NEXT"
PAT_N="$(echo "$PAT_ALL" | tr ',' '\n' | grep -c .)"
val "patient: $PAT_N visible rows are served as pages of 20" "counts" "$(node -e 'const n=+process.argv[1];const a=[];for(let r=n;r>0;r-=20)a.push(Math.min(20,r));process.stdout.write(a.join(","))' "$PAT_N")" "$PAGES"
page_all "$ADMIN"
val "admin: paging returns every live row exactly once in updated_at DESC, id DESC order" "ids" "$ADM_ALL" "$ALL_IDS"
val "admin: last page hasMore=false" "last" "false" "$LAST_MORE"
ADM_N="$(echo "$ADM_ALL" | tr ',' '\n' | grep -c .)"
val "admin: page sizes follow 20 per page" "counts" "$(node -e 'const n=+process.argv[1];const a=[];for(let r=n;r>0;r-=20)a.push(Math.min(20,r));process.stdout.write(a.join(","))' "$ADM_N")" "$PAGES"
t "limit=7 pages: first page" GET "?limit=7" "$PATIENT" 200 -; L1="$(ids_of)"; LC="$(jf meta.nextCursor)"
t "limit=7 pages: second page" GET "?limit=7&cursor=$LC" "$PATIENT" 200 -; L2="$(ids_of)"
val "limit=7: the two pages are the first 14 oracle ids" "ids" "$(echo "$PAT_ALL" | cut -d, -f1-14)" "$L1,$L2"
t "limit=100 returns all patient-visible rows in one page" GET "?limit=100" "$PATIENT" 200 -
val "limit=100: one page, hasMore false" "ids" "$PAT_ALL" "$(ids_of)"
fld "limit=100: hasMore false" meta.hasMore false
cursor_id() { node -e 'process.stdout.write(String(JSON.parse(Buffer.from(process.argv[1],"base64url").toString())[1]))' "$1"; }
t "page-1 cursor + category=how-it-works: the filter is re-applied (cursor is a position, never a grant)" GET "?category=how-it-works&cursor=$CUR1" "$PATIENT" 200 -
val "ids = how-it-works rows after the cursor position" "ids" "$(sql "SELECT coalesce(string_agg(id::text, ',' ORDER BY published_at DESC, id DESC), '') FROM (SELECT id, published_at FROM help_articles WHERE audience='patient' AND is_published AND deleted_at IS NULL AND category='how-it-works' AND (published_at, id) < (SELECT published_at, id FROM help_articles WHERE id = $(cursor_id "$CUR1")) ORDER BY published_at DESC, id DESC LIMIT 20) s")" "$(ids_of)"
t "page-1 cursor + category=preparing-for-consultation" GET "?category=preparing-for-consultation&cursor=$CUR1" "$PATIENT" 200 -
val "ids = preparing rows after the position (F5 is newer than the seeded rows, so none)" "ids" "" "$(ids_of)"

t "page-1 cursor again (limit=20)" GET "" "$PATIENT" 200 -
CURX="$(jf meta.nextCursor)"; LASTID="$(ids_of | awk -F, '{print $NF}')"
sql "UPDATE help_articles SET deleted_at = now() WHERE id = $LASTID" >/dev/null     # owner: the cursor's own row disappears between pages
t "page 2 with a cursor whose row was deleted in between -> still 200 (position, not grant)" GET "?cursor=$CURX" "$PATIENT" 200 -
val "page 2 equals the rows after that position" "ids" "$(sql "SELECT coalesce(string_agg(id::text, ',' ORDER BY published_at DESC, id DESC), '') FROM (SELECT id, published_at FROM help_articles WHERE audience='patient' AND is_published AND deleted_at IS NULL AND (published_at, id) < (SELECT published_at, id FROM help_articles WHERE id = $LASTID) ORDER BY published_at DESC, id DESC LIMIT 20) s")" "$(ids_of)"
sql "UPDATE help_articles SET deleted_at = NULL WHERE id = $LASTID" >/dev/null
sql "DELETE FROM help_articles WHERE title LIKE 'QA-HA-PG-%'" >/dev/null

# ------------------------------------------------------------------------------------------------------------------------------
section "9. Audit completeness and privacy"
val "every audit row of this run: entity_type help_article, actor admin 1" "non-admin actors" "0" "$(sql "SELECT count(*) FROM audit_logs WHERE entity_type = 'help_article' AND (actor_role <> 'admin' OR actor_user_id <> 1)")"
val "no audit metadata key other than isPublishedBefore/After and changedFields" "other keys" "0" "$(sql "SELECT count(*) FROM audit_logs a, jsonb_object_keys(a.metadata) k WHERE a.entity_type = 'help_article' AND k NOT IN ('isPublishedBefore','isPublishedAfter','changedFields')")"
val "no audit metadata contains article text (marker, fixture title, body words); field NAMES in changedFields are allowed" "leaks" "0" "$(sql "SELECT count(*) FROM audit_logs WHERE entity_type = 'help_article' AND (metadata::text LIKE '%SYNTHETIC%' OR metadata::text LIKE '%QA-HA-%' OR metadata::text ILIKE '%script%' OR metadata::text ILIKE '%Synthetic%')")"
val "every audit row has a request_id" "null request ids" "0" "$(sql "SELECT count(*) FROM audit_logs WHERE entity_type = 'help_article' AND request_id IS NULL")"
val "audit actions used are exactly created/updated/deleted" "actions" "help_article.created,help_article.deleted,help_article.updated" "$(sql "SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_logs WHERE entity_type = 'help_article'")"
val "vcare_app cannot hard-delete help_articles (no DELETE grant)" "has_table_privilege" "f" "$(sql "SELECT has_table_privilege('vcare_app','help_articles','DELETE')")"

# ------------------------------------------------------------------------------------------------------------------------------
if [ "$SKIP_RATE_LIMIT" = 1 ]; then
  section "10. Rate limits"; skip "reads 120/min and writes 20/min" "SKIP_RATE_LIMIT=1"
else
  section "10. Rate limits: reads 120/min per user, writes 20/min per user (one shared bucket)"
  reset_rl
  RT="$(mint patient-102)"; WT="$(mint admin-9001)"; TOKEN_SIGS+=("${RT##*.}" "${WT##*.}")
  codes="$(curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $RT" "$BASE/[1-121]" | tr -d '\r')"
  val "patient-102: requests 1..120 are not 429" "429 count in the first 120" "0" "$(echo "$codes" | head -120 | grep -c 429 || true)"
  val "patient-102: the 121st read in a minute -> 429" "121st status" "429" "$(echo "$codes" | sed -n 121p)"
  val "Redis holds the read bucket" "key" "1" "$(rds exists 'rl:help-articles-read-user:102')"
  call GET "" "$RT"; val "429 body: success=false, RateLimited, requestId = sent id" "envelope" "429|false|RateLimited|$RID" "$ST|$(jf success error.code error.requestId)"
  val "429 carries Retry-After >= 1" "Retry-After" "1" "$([ "$(header Retry-After)" -ge 1 ] 2>/dev/null && echo 1 || echo 0)"
  val "429 carries Cache-Control: private, no-cache" "header" "private, no-cache" "$(header Cache-Control)"
  val "429 echoes X-Request-Id" "header" "$RID" "$(header X-Request-Id)"
  READS=0
  call GET "" "$PATIENT"; val "another user (patient-101) is not limited by patient-102's bucket" "status" "200" "$ST"
  # writes: 20 mixed POST / PATCH / DELETE (404/400 outcomes still count), the 21st is 429
  wcodes=""
  for n in 1 2 3 4 5 6 7; do wcodes="$wcodes $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $WT" "$BASE/999999")"; done
  for n in 1 2 3 4 5 6 7; do wcodes="$wcodes $(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $WT" -H 'Content-Type: application/json' --data-binary '{"title":"abc"}' "$BASE/999999")"; done
  for n in 1 2 3 4 5 6; do wcodes="$wcodes $(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $WT" -H 'Content-Type: application/json' --data-binary '{}' "$BASE")"; done
  val "admin-9001: 7 DELETE + 7 PATCH + 6 POST (404/404/400) = 20 writes, none 429" "429 count" "0" "$(echo "$wcodes" | tr ' ' '\n' | grep -c 429 || true)"
  EXTRA=(); call DELETE "/999999" "$WT"
  val "21st write (any verb, one shared bucket) in a minute -> 429" "status" "429" "$ST"
  val "429 on write is the RateLimited envelope" "code" "RateLimited" "$(jf error.code)"
  call GET "" "$WT"; val "admin-9001 reads use a separate bucket -> still 200" "status" "200" "$ST"
  call POST "" "$WT" "{\"title\":\"$P-rl\",\"body\":\"b\",$VALID}"; val "POST by the exhausted admin -> 429 (not 201)" "status" "429" "$ST"
  val "no article was created by the limited POST" "rows" "0" "$(sql "SELECT count(*) FROM help_articles WHERE title = '$P-rl'")"
  reset_rl
fi

# ------------------------------------------------------------------------------------------------------------------------------
section "11. Server log hygiene"
if [ -n "$CARE_LOG_FILE" ] && [ -f "$CARE_LOG_FILE" ]; then
  val "no bearer token signature appears in the log" "leaked signatures" "0" "$(leaks=0; for sig in "${TOKEN_SIGS[@]}"; do c="$(grep -c -F -- "$sig" "$CARE_LOG_FILE" || true)"; leaks=$((leaks + c)); done; echo "$leaks")"
  val "no Authorization header value in the log" "matches" "0" "$(grep -c -i -E 'bearer ey|authorization' "$CARE_LOG_FILE" || true)"
  val "no article body marker in the log" "matches" "0" "$(grep -c -F "$MARKER" "$CARE_LOG_FILE" || true)"
  val "no fixture title in the log" "matches" "0" "$(grep -c -F 'QA-HA-' "$CARE_LOG_FILE" || true)"
  val "request_completed route labels are the patterns, never a concrete id" "concrete ids" "0" "$(grep -c -E '"route":"/api/help-articles/[0-9]' "$CARE_LOG_FILE" || true)"
  val "route label /api/help-articles/:id is used" "lines" "1" "$([ "$(grep -c -F '"route":"/api/help-articles/:id"' "$CARE_LOG_FILE")" -gt 0 ] && echo 1 || echo 0)"
  val "no error-level log line" "error lines" "0" "$(grep -c '"level":"error"' "$CARE_LOG_FILE" || true)"
  val "no 5xx request_completed" "5xx" "0" "$(grep -c -E '"status":5[0-9][0-9]' "$CARE_LOG_FILE" || true)"
else
  skip "log hygiene scan" "CARE_LOG_FILE not set"
fi
