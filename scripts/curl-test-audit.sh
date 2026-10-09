#!/usr/bin/env bash
# Repeatable HTTP QA for GET /api/audit-logs (operation listAuditLogs, module audit).
# Use only a disposable *_test or *_qa* database; the script refuses anything else and TRUNCATEs audit_logs in it.
#
# Start first (see docs/audit/manual-qa.md -> Environment):
#   node scripts/admin-doctors-qa-fake-identity.mjs   # FAKE_IDENTITY_PORT (default 3021): JWKS + /mint?case=... user tokens
#   npx tsx src/server.ts                             # IDENTITY_JWKS_URL=<fake>/.well-known/jwks.json, REDIS_URL on a spare db index,
#                                                     # dummy STORAGE_* values; no worker is needed (partitions are created here)
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH).
# Optional: CARE_URL (default http://127.0.0.1:3031), FAKE_IDENTITY_URL (default http://127.0.0.1:3021),
#           REDIS_URL (flushed at start so rate-limit state is clean; a spare db index only),
#           QA_REPORT (file receiving the case table), SERVER_LOG (care-api log, scanned for leaked values).
# Synthetic fixtures only: no PII exists in audit_logs; metadata holds ids, statuses, and scalars.
set -euo pipefail
export MSYS_NO_PATHCONV=1
export PGOPTIONS='-c timezone=UTC'

CARE_URL="${CARE_URL:-http://127.0.0.1:3031}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"
PASS=0; FAIL=0; CASE=0
A='/api/audit-logs'

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
iso() { sql "select to_char(($1) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"; }
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=eval(process.argv[2]);process.stdout.write(String(r))' "$TMP/body" "$1"; }
# comma list of ids, in order, of a SQL predicate (+ order) over audit_logs
sqlids() { sql "select coalesce(string_agg(id::text, ',' order by created_at desc, id desc), '') from (select id, created_at from audit_logs $1) q"; }

call() {
  local path="$1" token="$2" extra="${3:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X GET -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$extra" ] || args+=(-H "$extra")
  curl "${args[@]}" "$CARE_URL$path"
}
# Envelope check: X-Request-Id echoed, Cache-Control no-store, error envelope or success; optional JS assertion (b, h, rid).
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: no-store\r?$/im.test(h)) process.exit(1);
let b; try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(1); }
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
# expect PATH ROLE TOKEN SCENARIO EXPECTED [ASSERT_JS] [EXTRA_HEADER]; EXPECTED "200" or "<status> <ErrorCode>"
expect() {
  local path="$1" role="$2" token="$3" scenario="$4" expected="$5" assertion="${6:-}" extra="${7:-}"
  local status ok=1 kind=ok code='' want="${expected%% *}"
  status="$(call "$path" "$token" "$extra")"
  [ "$expected" != "$want" ] && { kind=error; code="${expected#* }"; }
  [ "$status" = "$want" ] || ok=0
  check_body "$kind" "$code" "$assertion" || ok=0
  local got="$status"
  if [ "$kind" = error ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
  fi
  record GET "${path:0:130}" "$role" "$scenario" "$expected" "$got" "$ok"
}
check_value() { record check "$1" "$2" "$3" "$4" "$5" "$([ "$4" = "$5" ] && echo 1 || echo 0)"; }
check_true() { record check "$1" "$2" "$3" 1 "$4" "$([ "$4" = 1 ] && echo 1 || echo 0)"; }
# detail field of the first error detail
DETAIL0='b.error.details[0].field'
# nine contract keys exactly, enum/uuid/date shapes, meta keys exactly
SHAPE='b.data.every(e=>JSON.stringify(Object.keys(e).sort())===JSON.stringify(["action","actorRole","actorUserId","createdAt","entityId","entityType","id","metadata","requestId"])&&["patient","doctor","admin","service","system"].includes(e.actorRole)&&(e.requestId===null||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.requestId))&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.createdAt)&&typeof e.metadata==="object"&&e.metadata!==null)&&JSON.stringify(Object.keys(b.meta).sort())===JSON.stringify(["count","hasMore","nextCursor"])'
SORTED='b.data.every((e,i)=>i===0||b.data[i-1].createdAt>e.createdAt||(b.data[i-1].createdAt===e.createdAt&&b.data[i-1].id>e.id))'
IDS='b.data.map(e=>e.id).join(",")'
# walk PATH_WITH_QUERY TOKEN -> prints "<ids comma list>|<pages>", following meta.nextCursor until hasMore=false
walk() {
  local base="$1" token="$2" cursor='' ids='' pages=0 more=true sep='?'
  [[ "$base" == *\?* ]] && sep='&'
  while [ "$more" = true ]; do
    local q="$base"; [ -z "$cursor" ] || q="$base${sep}cursor=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$cursor")"
    [ "$(call "$q" "$token")" = 200 ] || { echo "walk-http-error|$pages"; return; }
    ids="$ids${ids:+,}$(js "$IDS" | sed 's/^$//')"; ids="${ids%,}"
    pages=$((pages+1)); more="$(js 'b.meta.hasMore')"; cursor="$(js 'b.meta.nextCursor')"
    [ "$pages" -lt 200 ] || break
  done
  echo "$ids|$pages"
}

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
if [ -n "${REDIS_URL:-}" ]; then
  node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null
fi
LOG_MARK_API=0; [ -z "${SERVER_LOG:-}" ] || LOG_MARK_API="$(wc -l < "$SERVER_LOG")"

echo '=== 0. Seed (owner connection): partitions for the last ~5 months, synthetic rows with explicit created_at ==='
sql "DO \$\$ DECLARE m date := date_trunc('month', now() - interval '125 days')::date; n text;
BEGIN WHILE m <= date_trunc('month', now())::date LOOP
  n := format('audit_logs_y%sm%s', to_char(m,'YYYY'), to_char(m,'MM'));
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)', n, m || ' 00:00:00+00', (m + interval '1 month')::date || ' 00:00:00+00');
  EXECUTE format('GRANT SELECT ON %I TO vcare_app', n);
  m := (m + interval '1 month')::date; END LOOP; END \$\$" >/dev/null
sql "TRUNCATE audit_logs" >/dev/null
sql "WITH t AS (SELECT date_trunc('second', now()) AS t0)
INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata, created_at)
SELECT * FROM (
  SELECT 11, 'admin', 'qa.tie', 'qa_tie', 500 + k, gen_random_uuid(), jsonb_build_object('idx', k), t0 - interval '2 days' FROM t, generate_series(1,5) k
  UNION ALL SELECT 12, 'doctor', 'qa.a', 'qa_one', 701, gen_random_uuid(), '{\"fromStatus\":\"a\",\"toStatus\":\"b\",\"consultationId\":1042,\"flag\":true,\"note\":null,\"reasonLength\":12,\"marker\":\"SYNTH-META-7731\"}'::jsonb, t0 - interval '1 day' FROM t
  UNION ALL SELECT 13, 'patient', 'qa.b', 'qa_one', 701, NULL, '{}'::jsonb, t0 - interval '3 days' FROM t
  UNION ALL SELECT 11, 'admin', 'qa.micro', 'qa_micro', 801, NULL, '{}'::jsonb, date_trunc('second', now() - interval '5 days') + interval '123456 microseconds' FROM t
  UNION ALL SELECT 11, 'admin', 'qa.micro', 'qa_micro', 802, NULL, '{}'::jsonb, date_trunc('second', now() - interval '5 days') + interval '123789 microseconds' FROM t
  UNION ALL SELECT 11, 'admin', 'qa.edge', 'qa_edge', 901, NULL, '{}'::jsonb, date_trunc('second', now() - interval '10 days') FROM t
  UNION ALL SELECT 11, 'admin', 'qa.edge', 'qa_edge', 902, NULL, '{}'::jsonb, date_trunc('second', now() - interval '10 days') - interval '1 second' FROM t
  UNION ALL SELECT 11, 'admin', 'qa.edge', 'qa_edge', 903, NULL, '{}'::jsonb, date_trunc('second', now() - interval '9 days') FROM t
  UNION ALL SELECT NULL, 'service', 'qa.svc', 'qa_two', 702, NULL, '{\"retry\":3}'::jsonb, t0 - interval '4 days' FROM t
  UNION ALL SELECT NULL, 'system', 'qa.sys', 'qa_three', 703, NULL, '{}'::jsonb, t0 - interval '6 days' FROM t
  UNION ALL SELECT 12, 'doctor', 'qa.c', 'qa_two', 702, NULL, '{}'::jsonb, t0 - interval '7 days' FROM t
  UNION ALL SELECT 13, 'patient', 'qa.d29', 'qa_three', 704, NULL, '{}'::jsonb, t0 - interval '29 days' FROM t
  UNION ALL SELECT 13, 'patient', 'qa.d31', 'qa_three', 705, NULL, '{}'::jsonb, t0 - interval '31 days' FROM t
  UNION ALL SELECT 13, 'patient', 'qa.old', 'qa_old', 706, NULL, '{}'::jsonb, t0 - interval '45 days' FROM t
  UNION ALL SELECT 13, 'patient', 'qa.old', 'qa_old', 707, NULL, '{}'::jsonb, t0 - interval '75 days' FROM t
  UNION ALL SELECT 13, 'patient', 'qa.old', 'qa_old', 708, NULL, '{}'::jsonb, t0 - interval '105 days' FROM t
) s" >/dev/null
check_value 'audit_logs' owner 'seeded rows, none in audit_logs_default' 0 "$(sql 'select count(*) from audit_logs_default')"
check_value 'audit_logs' owner 'seeded rows (20)' 20 "$(sql 'select count(*) from audit_logs')"
check_true 'audit_logs' owner 'old rows live in >= 3 distinct monthly partitions' "$([ "$(sql "select count(distinct tableoid) from audit_logs where action='qa.old' or action='qa.d31'")" -ge 3 ] && echo 1 || echo 0)"

ADMIN="$(mint admin-11)"; ADMIN2="$(mint admin-12)"; ADMIN3="$(mint admin-13)"
PATIENT="$(mint patient-101)"; DOCTOR="$(mint doctor-410)"; SUSP="$(mint admin-suspended)"; EXPIRED="$(mint expired)"

echo '=== 1. AuthN / AuthZ ==='
expect "$A" none '' 'no token' '401 Unauthorized'
expect "$A" admin "$EXPIRED" 'expired token' '401 TokenExpired'
expect "$A" none 'not.a.jwt' 'garbage bearer' '401 Unauthorized'
expect "$A" patient "$PATIENT" 'wrong role' '403 Forbidden'
expect "$A" doctor "$DOCTOR" 'wrong role' '403 Forbidden'
expect "$A" admin-suspended "$SUSP" 'admin token with status=suspended' '403 Forbidden'
expect "$A?actorUserId=11" patient "$PATIENT" 'wrong role with filters; no data' '403 Forbidden' '!JSON.stringify(b).includes("qa.")'
status="$(call "$A" "$PATIENT" 'X-Role: admin')"; check_value "$A" patient 'spoofed X-Role: admin header ignored' 403 "$status"

echo '=== 2. Default call, shape, headers ==='
D30="select 1 from audit_logs where created_at >= now() - interval '30 days'"
EXP20="$(sql "select coalesce(string_agg(id::text, ',' order by created_at desc, id desc), '') from (select id, created_at from audit_logs where created_at >= now() - interval '30 days' order by created_at desc, id desc limit 20) q")"
EXP_N="$(sql "select count(*) from audit_logs where created_at >= now() - interval '30 days'")"
expect "$A" admin "$ADMIN" 'default: last 30 days, newest first, contract shape, no-store, request id echoed' 200 "$SHAPE&&$SORTED&&$IDS==='$EXP20'&&b.meta.count===b.data.length&&b.meta.hasMore===($EXP_N>20)&&(b.meta.hasMore===(b.meta.nextCursor!==null))"
expect "$A?limit=100" admin "$ADMIN" 'default window excludes rows older than 30 days (29d in, 31d out)' 200 "$IDS==='$(sqlids "where created_at >= now() - interval '30 days' order by created_at desc, id desc")'&&b.data.some(e=>e.entityId===704)&&!b.data.some(e=>e.entityId===705||e.entityId===706)"
INCOMING="$(uuid)"
curl -sS -o "$TMP/discard" -D "$TMP/h2" -H "X-Request-Id: $INCOMING" -H "Authorization: Bearer $ADMIN" "$CARE_URL$A?limit=1"
check_true "$A" admin 'valid incoming X-Request-Id adopted/echoed' "$(grep -qi "^x-request-id: $INCOMING" "$TMP/h2" && echo 1 || echo 0)"
curl -sS -o "$TMP/discard" -D "$TMP/h2" -H "X-Request-Id: not-a-uuid" -H "Authorization: Bearer $ADMIN" "$CARE_URL$A?limit=1"
check_true "$A" admin 'invalid X-Request-Id regenerated (not echoed verbatim)' "$(grep -qi "^x-request-id: not-a-uuid" "$TMP/h2" && echo 0 || echo 1)"
check_true "$A" admin 'Cache-Control no-store on 200' "$(grep -qi '^cache-control: no-store' "$TMP/h2" && echo 1 || echo 0)"

echo '=== 3. Limit bounds ==='
expect "$A?limit=1" admin "$ADMIN" 'limit=1' 200 "b.data.length===1&&b.meta.count===1&&b.meta.hasMore===true&&b.meta.nextCursor!==null"
expect "$A?limit=100" admin "$ADMIN" 'limit=100' 200 "b.data.length===Math.min(100,$EXP_N)&&b.meta.count===b.data.length"
for bad in 0 101 -1 1.5 abc ''; do expect "$A?limit=$bad" admin "$ADMIN" "limit=$bad rejected" '400 ValidationFailed' "$DETAIL0==='limit'"; done

echo '=== 4. Ties and keyset paging (5 rows share one created_at; limit=2) ==='
ALLIDS="$(sqlids "where created_at >= now() - interval '30 days' order by created_at desc, id desc")"
res="$(walk "$A?limit=2" "$ADMIN")"
check_value "$A?limit=2" admin 'walk every page via nextCursor == SQL order (no gap, no duplicate)' "$ALLIDS" "${res%|*}"
check_true "$A?limit=2" admin "walk used ceil(n/2) pages ($(( (EXP_N+1)/2 )))" "$([ "${res#*|}" = "$(( (EXP_N+1)/2 ))" ] && echo 1 || echo 0)"
check_true "$A?limit=2" admin 'walked ids unique' "$(echo "${res%|*}" | tr ',' '\n' | sort | uniq -d | wc -l | tr -d ' ' | grep -qx 0 && echo 1 || echo 0)"
TIEIDS="$(sqlids "where action='qa.tie' order by created_at desc, id desc")"
res="$(walk "$A?limit=2&action=qa.tie" "$ADMIN")"
check_value "$A?limit=2&action=qa.tie" admin 'tie group (5 equal created_at) paged 2/2/1, id DESC, complete' "$TIEIDS|3" "$res"
MICRO="$(sqlids "where action='qa.micro' order by created_at desc, id desc")"
res="$(walk "$A?limit=1&action=qa.micro" "$ADMIN")"
check_value "$A?limit=1&action=qa.micro" admin 'microsecond-only differing rows: no skip/repeat across pages' "$MICRO|2" "$res"
check_true "$A?action=qa.micro" admin 'microsecond rows ordered by full-precision created_at' "$([ "$MICRO" = "$(sql "select string_agg(id::text, ',' order by id desc) from audit_logs where action='qa.micro'")" ] && echo 1 || echo 0)"
# last page
status="$(call "$A?limit=2&action=qa.tie" "$ADMIN")"; C1="$(js 'b.meta.nextCursor')"
status="$(call "$A?limit=2&action=qa.tie&cursor=$C1" "$ADMIN")"; C2="$(js 'b.meta.nextCursor')"
status="$(call "$A?limit=2&action=qa.tie&cursor=$C2" "$ADMIN")"
check_true "$A" admin 'last page: 200, count=1, hasMore=false, nextCursor=null' "$([ "$status" = 200 ] && [ "$(js 'b.meta.count===1&&b.meta.hasMore===false&&b.meta.nextCursor===null')" = true ] && echo 1 || echo 0)"
C1DEC="$(node -e 'process.stdout.write(Buffer.from(process.argv[1].split(".")[0],"base64url").toString())' "$C1")"
check_true "$A" admin 'cursor payload has t (6 fraction digits), id and frozen to' "$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(/\.\d{6}Z$/.test(p.t)&&Number.isInteger(p.id)&&/\.\d{3}Z$/.test(p.to)?"1":"0")' "$C1DEC")"

echo '=== 5. Frozen window (R4): row inserted after page 1 does not appear on page 2; fresh page 1 shows it ==='
status="$(call "$A?limit=2" "$ADMIN")"; P1IDS="$(js "$IDS")"; CF="$(js 'b.meta.nextCursor')"
sleep 1
NEWID="$(sql "insert into audit_logs(actor_user_id,actor_role,action,entity_type,entity_id,metadata) values (11,'admin','qa.late','qa_late',999,'{}') returning id" | head -1)"
status="$(call "$A?limit=100&cursor=$CF" "$ADMIN")"
check_true "$A" admin 'page 2 after a later insert (no to): new row absent' "$([ "$status" = 200 ] && [ "$(js "!b.data.some(e=>e.id===$NEWID)")" = true ] && echo 1 || echo 0)"
expect "$A?limit=1" admin "$ADMIN" 'fresh page 1 now shows the new row' 200 "b.data[0].id===$NEWID"
sql "delete from audit_logs where id=$NEWID" >/dev/null 2>&1 || true

echo '=== 6. Filters ==='
expect "$A?actorUserId=12&limit=100" admin "$ADMIN" 'actorUserId=12 only that actor' 200 "$IDS==='$(sqlids "where actor_user_id=12 and created_at >= now() - interval '30 days' order by created_at desc, id desc")'&&b.data.every(e=>e.actorUserId===12)"
expect "$A?actorUserId=999999" admin "$ADMIN" 'actorUserId with no rows -> empty 200' 200 "b.data.length===0&&b.meta.count===0&&b.meta.hasMore===false&&b.meta.nextCursor===null"
expect "$A?action=qa.svc" admin "$ADMIN" 'action exact; includes service actor with actorUserId null' 200 "b.data.length===1&&b.data[0].actorUserId===null&&b.data[0].actorRole==='service'&&b.data[0].metadata.retry===3"
expect "$A?action=QA.SVC" admin "$ADMIN" 'action is case-sensitive' 200 'b.data.length===0'
expect "$A?action=qa%25" admin "$ADMIN" 'action with % is literal (no LIKE)' 200 'b.data.length===0'
expect "$A?action=qa._ic" admin "$ADMIN" 'action with _ is literal' 200 'b.data.length===0'
expect "$A?action=qa%27%20OR%201%3D1--" admin "$ADMIN" 'SQL metacharacters in action are inert' 200 'b.data.length===0'
expect "$A?entityType=qa_one&limit=100" admin "$ADMIN" 'entityType alone allowed' 200 "$IDS==='$(sqlids "where entity_type='qa_one' and created_at >= now() - interval '30 days' order by created_at desc, id desc")'&&b.data.length===2"
expect "$A?entityType=qa_one&entityId=701" admin "$ADMIN" 'entityType+entityId pair' 200 "b.data.length===2&&b.data.every(e=>e.entityType==='qa_one'&&e.entityId===701)"
expect "$A?entityType=qa_two&entityId=701" admin "$ADMIN" 'entityType/entityId mismatched pair -> empty' 200 'b.data.length===0'
expect "$A?entityId=701" admin "$ADMIN" 'entityId without entityType' '400 ValidationFailed' "$DETAIL0==='entityType'&&b.error.details[0].issue==='is required when entityId is given'"
expect "$A?actorUserId=0" admin "$ADMIN" 'actorUserId=0' '400 ValidationFailed' "$DETAIL0==='actorUserId'"
for bad in 007 1e3 1.5 +1 abc -1; do expect "$A?actorUserId=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$bad")" admin "$ADMIN" "actorUserId=$bad (non strict integer)" '400 ValidationFailed' "$DETAIL0==='actorUserId'"; done
expect "$A?entityType=qa_one&entityId=0" admin "$ADMIN" 'entityId=0' '400 ValidationFailed' "$DETAIL0==='entityId'"
expect "$A?action=" admin "$ADMIN" 'empty action' '400 ValidationFailed' "$DETAIL0==='action'"
expect "$A?entityType=" admin "$ADMIN" 'empty entityType' '400 ValidationFailed' "$DETAIL0==='entityType'"
expect "$A?action=$(printf 'a%.0s' $(seq 1 65))" admin "$ADMIN" 'action 65 chars' '400 ValidationFailed' "$DETAIL0==='action'"
expect "$A?action=$(printf 'a%.0s' $(seq 1 64))" admin "$ADMIN" 'action 64 chars accepted' 200 'b.data.length===0'
expect "$A?action=a%00b" admin "$ADMIN" 'action with NUL byte' '400 ValidationFailed' "$DETAIL0==='action'"
expect "$A?action=qa.a&action=qa.b" admin "$ADMIN" 'duplicated key (array)' '400 ValidationFailed'
expect "$A?foo=1" admin "$ADMIN" 'unknown query key foo' '400 ValidationFailed' "$DETAIL0==='foo'&&b.error.details[0].issue==='is not allowed'"
expect "$A?requestId=$(uuid)" admin "$ADMIN" 'unknown key requestId' '400 ValidationFailed' "$DETAIL0==='requestId'"
expect "$A?metadata.x=1" admin "$ADMIN" 'unknown key metadata.x (no metadata filtering)' '400 ValidationFailed'
expect "$A?actorUserId=11&foo=1&limit=0" admin "$ADMIN" 'several invalid keys at once, no 500' '400 ValidationFailed' "b.error.details.length>=2"
expect "$A?actorUserId=12&entityType=qa_one&entityId=701&action=qa.a&from=$(iso "now() - interval '2 days 12 hours'")&to=$(iso "now()")" admin "$ADMIN" 'combination of all filters = intersection' 200 "b.data.length===1&&$IDS==='$(sqlids "where action='qa.a'")'"
expect "$A?actorUserId=12&entityType=qa_one&entityId=701&action=qa.a&from=$(iso "now() - interval '2 days 12 hours'")&to=$(iso "now() - interval '1 day 12 hours'")" admin "$ADMIN" 'combination, window excludes the row -> empty' 200 'b.data.length===0'
expect "$A?actorUserId=12&entityType=qa_one&entityId=701&action=qa.b" admin "$ADMIN" 'combination, conflicting action -> empty' 200 'b.data.length===0'
res="$(walk "$A?limit=1&entityType=qa_one&entityId=701" "$ADMIN")"
check_value "$A?limit=1&entityType=qa_one&entityId=701" admin 'paging with a filter yields the rest (2 pages)' "$(sqlids "where entity_type='qa_one' and entity_id=701 order by created_at desc, id desc")|2" "$res"
status="$(call "$A?limit=1&entityType=qa_one&entityId=701" "$ADMIN")"; CE="$(js 'b.meta.nextCursor')"
expect "$A?limit=100&action=qa.svc&cursor=$CE" admin "$ADMIN" 'cursor reused with a different filter: only rows matching the new filter (position, not grant)' 200 "b.data.every(e=>e.action==='qa.svc')"

echo '=== 7. Time window ==='
F_ISO="$(iso "(select created_at from audit_logs where entity_id=901)")"   # anchors come from the seeded rows, not the test-time clock
TO_ISO="$(iso "(select created_at from audit_logs where entity_id=903)")"
expect "$A?from=$F_ISO&to=$TO_ISO&limit=100" admin "$ADMIN" 'from inclusive, to exclusive: row at exactly from in, row at exactly to out' 200 "b.data.length===1&&b.data[0].entityId===901"
expect "$A?from=$F_ISO&to=$F_ISO" admin "$ADMIN" 'from == to -> empty 200' 200 "b.data.length===0&&b.meta.count===0&&b.meta.hasMore===false&&b.meta.nextCursor===null"
expect "$A?from=$(iso "now()")&to=$(iso "now() - interval '1 hour'")" admin "$ADMIN" 'from > to' '400 ValidationFailed' "$DETAIL0==='from'&&b.error.details[0].issue==='must not be later than to'"
expect "$A?from=$(iso "now() + interval '1 day'")" admin "$ADMIN" 'only from, later than now' '400 ValidationFailed' "$DETAIL0==='from'"
expect "$A?from=$F_ISO&limit=100" admin "$ADMIN" 'from alone (to defaults to now)' 200 "$IDS==='$(sqlids "where created_at >= (select created_at from audit_logs where entity_id=901) order by created_at desc, id desc")'"
expect "$A?to=$TO_ISO&limit=100" admin "$ADMIN" 'to alone (from = to - 30 days)' 200 "b.data.length>0&&b.data.every(e=>e.createdAt<'$TO_ISO')&&b.data.some(e=>e.entityId===705)&&!b.data.some(e=>e.entityId===706)"
# offsets: same instant expressed as Z, +02:00 (encoded), -05:00 (encoded)
INST="(select created_at from audit_logs where entity_id=901)"
Z_Z="$(iso "$INST")"
Z_P2="$(sql "select to_char(($INST + interval '2 hours') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS')")%2B02:00"
Z_M5="$(sql "select to_char(($INST - interval '5 hours') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS')")-05:00"
TOZ="$TO_ISO"
for f in "$Z_Z" "$Z_P2" "$Z_M5"; do
  expect "$A?from=$f&to=$TOZ&limit=100" admin "$ADMIN" "from offset form ${f##*[0-9]}: same instant -> same result" 200 "b.data.length===1&&b.data[0].entityId===901"
done
expect "$A?from=${Z_P2/\%2B/+}&to=$TOZ" admin "$ADMIN" 'raw + offset (decoded to space)' '400 ValidationFailed' "$DETAIL0==='from'&&b.error.details[0].issue==='must be an ISO-8601 date-time with a UTC offset'&&!JSON.stringify(b).includes('02:00')"
for bad in 2026-10-01 2026-10-01T00:00:00 2026-10-01T00:00:00%2B0100 2026-10-01t00:00:00z 2026-10-01%2000:00:00Z 2026-02-30T00:00:00Z 2026-10-01T24:00:00Z 2026-10-01T00:00:60Z 0000-01-01T00:00:00Z 1969-12-31T23:59:59Z 10000-01-01T00:00:00Z 1760000000; do
  expect "$A?to=$bad" admin "$ADMIN" "to=$bad rejected" '400 ValidationFailed' "$DETAIL0==='to'"
done
expect "$A?from=$(printf '2026-10-01T00:00:00.%s' 123456789)Z&to=$(iso "now()")" admin "$ADMIN" 'nanosecond fraction accepted (truncated to ms)' 200
expect "$A?from=$(printf 'x%.0s' $(seq 1 41))" admin "$ADMIN" 'from longer than 40 chars' '400 ValidationFailed' "$DETAIL0==='from'"
expect "$A?from=1970-01-01T00:00:00Z&to=9999-12-31T23:59:59Z&limit=100" admin "$ADMIN" '1970..9999 window accepted (no span cap); all rows reachable' 200 "$IDS==='$(sqlids "order by created_at desc, id desc")'"
res="$(walk "$A?limit=7&from=1970-01-01T00:00:00Z&to=9999-12-31T23:59:59Z" "$ADMIN")"
check_value "$A?limit=7&from=1970..to=9999" admin 'whole-table window paged: complete, ordered' "$(sqlids "order by created_at desc, id desc")" "${res%|*}"
OLDFROM="$(iso "now() - interval '120 days'")"
expect "$A?from=$OLDFROM&to=$(iso "now()")&limit=100" admin "$ADMIN" 'window spanning several monthly partitions (105d back)' 200 "$IDS==='$(sqlids "where created_at >= now() - interval '120 days' and created_at < now() order by created_at desc, id desc")'&&b.data.some(e=>e.entityId===708)&&b.data.some(e=>e.entityId===707)&&b.data.some(e=>e.entityId===706)"
expect "$A?from=$(iso "now() - interval '110 days'")&to=$(iso "now() - interval '100 days'")" admin "$ADMIN" 'narrow old window returns only the 105d row' 200 'b.data.length===1&&b.data[0].entityId===708'
expect "$A?action=qa.old&from=$OLDFROM&limit=2" admin "$ADMIN" 'old action page 1 of 2' 200 'b.data.length===2&&b.meta.hasMore===true'
res="$(walk "$A?action=qa.old&from=$OLDFROM&limit=1" "$ADMIN")"
check_value "$A?action=qa.old&from=-120d&limit=1" admin 'paging across partitions: 3 old rows in order' "$(sqlids "where action='qa.old' order by created_at desc, id desc")|3" "$res"

echo '=== 8. Cursor tamper ==='
status="$(call "$A?limit=2" "$ADMIN")"; GC="$(js 'b.meta.nextCursor')"
PAY="${GC%%.*}"; MAC="${GC#*.}"
EDIT="$(node -e 'const p=JSON.parse(Buffer.from(process.argv[1],"base64url").toString());p.id=p.id+1;process.stdout.write(Buffer.from(JSON.stringify(p)).toString("base64url"))' "$PAY")"
NOMAC="$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({t:"2026-10-01T00:00:00.000000Z",id:5,to:"2026-10-02T00:00:00.000Z"})).toString("base64url"))')"
FLIPMAC="${MAC%?}$([ "${MAC: -1}" = A ] && echo B || echo A)"
FLIPPAY="${PAY%?}$([ "${PAY: -1}" = A ] && echo B || echo A)"
LONGC="$(printf 'A%.0s' $(seq 1 1100))"
for pair in "random:notacursor" "base64-json-no-mac:$NOMAC" "flipped-mac:$PAY.$FLIPMAC" "edited-payload-old-mac:$EDIT.$MAC" "flipped-payload-byte:$FLIPPAY.$MAC" "empty-mac:$PAY." "dot-only:." "over-1024-chars:$LONGC" "url-encoded-garbage:%00%ff"; do
  ISSUE_CHECK="&&b.error.details[0].issue==='is invalid'"; [ "${pair%%:*}" != over-1024-chars ] || ISSUE_CHECK=''   # the >1024 case is rejected by the DTO length validator
  expect "$A?cursor=${pair#*:}" admin "$ADMIN" "tampered cursor (${pair%%:*})" '400 ValidationFailed' "$DETAIL0==='cursor'$ISSUE_CHECK"
done
expect "$A?cursor=" admin "$ADMIN" 'empty cursor' '400 ValidationFailed'
status="$(call "$A?cursor=$GC" "$ADMIN")"; check_value "$A?cursor=<valid>" admin 'untampered cursor still accepted' 200 "$status"
expect "$A?cursor=$GC&to=$(iso "now()")&limit=1" admin "$ADMIN" 'explicit to wins over cursor.to' 200

echo '=== 9. Privacy, R9, logs ==='
BEFORE="$(sql 'select count(*) from audit_logs')"
for i in 1 2 3; do call "$A?limit=5" "$ADMIN" >/dev/null; done
call "$A?limit=5" "$PATIENT" >/dev/null
check_value 'audit_logs' owner 'reads write no audit row (R9)' "$BEFORE" "$(sql 'select count(*) from audit_logs')"
expect "$A?action=qa.a" admin "$ADMIN" 'metadata passthrough verbatim (types preserved)' 200 '(o=>JSON.stringify(Object.keys(o).sort().map(k=>[k,o[k]])))(b.data[0].metadata)===JSON.stringify([["consultationId",1042],["flag",true],["fromStatus","a"],["marker","SYNTH-META-7731"],["note",null],["reasonLength",12],["toStatus","b"]])'
status="$(call "$A?limit=100" "$ADMIN")"
check_true "$A" admin 'no password/token/secret/clinical key names in body' "$([ "$(js '/passwordHash|accessToken|clientSecret|diagnosis|symptom|prescription|notes"/i.test(JSON.stringify(b))')" = false ] && echo 1 || echo 0)"
# real write path round trip: a specialty create writes an audit row readable through the route
SPEC_RID="$(uuid)"; SLUG="qa-audit-$(date +%s)"
sc="$(curl -sS -o "$TMP/spec" -w '%{http_code}' -X POST "$CARE_URL/api/specialties" -H "Authorization: Bearer $ADMIN" -H "X-Request-Id: $SPEC_RID" -H "Idempotency-Key: $(uuid)" -H 'Content-Type: application/json' --data "{\"name\":\"QA Audit $SLUG\",\"slug\":\"$SLUG\"}")"
SPEC_ID="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1])).data.id))' "$TMP/spec")"
check_value '/api/specialties' admin 'create specialty (seeds a real audit row)' 201 "$sc"
expect "$A?entityType=specialty&entityId=$SPEC_ID" admin "$ADMIN" 'real audit row visible: action specialty.created, actor, request id' 200 "b.data.length===1&&b.data[0].action==='specialty.created'&&b.data[0].actorRole==='admin'&&b.data[0].actorUserId===11&&b.data[0].requestId==='$SPEC_RID'&&$SHAPE"
if [ -n "${SERVER_LOG:-}" ]; then
  tail -n +"$((LOG_MARK_API+1))" "$SERVER_LOG" > "$TMP/api.log"
  check_value 'server log' none 'no metadata marker / cursor / filter value in log' 0 "$(grep -c -e 'SYNTH-META-7731' -e "$GC" -e 'actorUserId=' -e 'entityType=' -e 'Bearer ' "$TMP/api.log" || true)"
  check_true 'server log' none 'audit-logs requests logged with route label, no 5xx' "$([ "$(grep -c '"status":5' "$TMP/api.log" || true)" = 0 ] && echo 1 || echo 0)"
fi

echo '=== 10. Rate limit: 120/min per admin, 121st -> 429, other admin unaffected ==='
RL="$(mint admin-90)"; RL2="$(mint admin-91)"
okc=0; for i in $(seq 1 120); do [ "$(call "$A?limit=1" "$RL")" = 200 ] && okc=$((okc+1)); done
check_value "$A?limit=1" admin-90 'first 120 requests in the window succeed' 120 "$okc"
expect "$A?limit=1" admin-90 "$RL" '121st request' '429 RateLimited' 'true'
check_true "$A" admin-90 '429 carries Retry-After' "$(grep -qi '^retry-after: ' "$TMP/headers" && echo 1 || echo 0)"
expect "$A?limit=1" admin-91 "$RL2" 'a second admin is unaffected' 200
expect "$A" patient "$PATIENT" 'denied role still 403 (not rate limited)' '403 Forbidden'

echo
echo "RESULT: $PASS pass / $FAIL fail (report: ${QA_REPORT:-$TMP/report})"
[ "$FAIL" = 0 ]
