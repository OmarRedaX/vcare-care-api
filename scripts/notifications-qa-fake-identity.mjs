import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
// Loopback-only, synthetic Identity for scripts/curl-test-notifications.sh. Everything lives in memory.
// Serves: JWKS + user-token minting (so care-api routes can drive the producers), POST /internal/auth/token (records the
// requested scope), PATCH /internal/users/:id/status (suspension producer), GET /internal/users?ids= (Case 2 hydration) and
// GET /internal/users/contacts?ids= (Case 5, notification contacts), plus a runtime control surface (no restart needed):
//   GET /__ctl?mode=healthy|down|hang|slow|403   switch the /internal/* behaviour
//          healthy  Identity behaves per contract
//          down     every /internal/* answers 503
//          hang     every /internal/* never answers (Care's 2 s client timeout fires)
//          slow     every /internal/* answers after 1 s (inside Care's 2 s timeout)
//          403      only GET /internal/users/contacts answers 403 InsufficientScope (everything else healthy)
//   GET /__ctl?grant=full|none        scope granted to a users:contact:read token request: full (as requested) | none (only users:read,
//                                      so Care's token cache rejects it as MalformedResponse: "client lacks the scope")
//   GET /__user?id=N&status=active|pending|rejected|suspended|unknown   set a directory entry (unknown = absent from the contacts answer)
//   GET /__calls    {mode, grant, tokens:[{scope}], contacts:[{ids,requestId,authKind,mode}], contactCount, batches, patches}
//   GET /__reset    clear the call log and the directory overrides, mode healthy, grant full
// Contacts are synthetic: address qa-fixture-<id>@example.invalid, name "QA Fixture Person <id>", locale en-US. No address or name
// is ever logged by this process, and request/response bodies are never written to stdout.
// The token endpoint returns `fake-contact-token` when the requested scope is exactly users:contact:read and `fake-status-token`
// otherwise; the contacts route accepts only the former, the status and batch routes only the latter (proves the two caches are separate).
import process from "node:process";
import { URL } from "node:url";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

if (process.env.NODE_ENV === "production") throw new Error("QA fake refuses production");
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3024);
const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: "notifications-qa-1", alg: "EdDSA", use: "sig" };
const actors = { expired: ["501", "patient", "active", true] };
let mode = "healthy";
let grant = "full";
let tokens = [];
let contacts = [];
let batches = [];
let patches = [];
const overrides = new Map(); // id -> status | "unknown"
const users = new Map(); // status updates written by PATCH
const minted = new Map();

const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const json = (res, status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
const statusOf = (id) => users.get(id) ?? "active";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") return json(res, 200, { keys: [jwk] });
  if (req.method === "GET" && url.pathname === "/__ctl") {
    const m = url.searchParams.get("mode");
    const g = url.searchParams.get("grant");
    if (m !== null) {
      if (!["healthy", "down", "hang", "slow", "403"].includes(m)) return json(res, 400, { error: "bad mode" });
      mode = m;
    }
    if (g !== null) {
      if (!["full", "none"].includes(g)) return json(res, 400, { error: "bad grant" });
      grant = g;
    }
    return json(res, 200, { mode, grant });
  }
  if (req.method === "GET" && url.pathname === "/__user") {
    const id = Number(url.searchParams.get("id"));
    const status = url.searchParams.get("status") ?? "";
    if (!Number.isSafeInteger(id) || id <= 0 || !["active", "pending", "rejected", "suspended", "unknown"].includes(status)) return json(res, 400, { error: "bad user" });
    overrides.set(id, status); return json(res, 200, { id, status });
  }
  if (req.method === "GET" && url.pathname === "/__calls") {
    return json(res, 200, { mode, grant, tokens, contacts, contactCount: contacts.length, batches, batchCount: batches.length, patches, patchCount: patches.length });
  }
  if (req.method === "GET" && url.pathname === "/__reset") {
    tokens = []; contacts = []; batches = []; patches = []; overrides.clear(); users.clear(); mode = "healthy"; grant = "full";
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/mint") {
    const requested = url.searchParams.get("case") ?? "";
    const typ = url.searchParams.get("typ") ?? "user";
    const patient = /^patient-(\d{3})$/.exec(requested);
    const doctor = /^doctor-(\d{3})$/.exec(requested);
    const admin = /^admin-(\d{1,3})$/.exec(requested);
    const actor = actors[requested] ?? (patient ? [patient[1], "patient", "active", true] : doctor ? [doctor[1], "doctor", "active", true] : admin ? [admin[1], "admin", "active", true] : undefined);
    if (!actor) { res.writeHead(404).end(); return; }
    const memo = `${requested}|${typ}`;
    const hit = minted.get(memo);
    if (hit && Date.now() - hit.at < 600_000) { res.setHeader("Content-Type", "text/plain"); res.end(hit.token); return; }
    const now = Math.floor(Date.now() / 1000);
    const isExpired = requested === "expired";
    const payload = { iss: "vcare-identity", aud: ["vcare-identity", "vcare-care"], sub: actor[0], typ, role: actor[1],
      status: actor[2], ev: actor[3], jti: randomUUID(), iat: isExpired ? now - 1500 : now, exp: isExpired ? now - 600 : now + 900 };
    try {
      const token = await new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid, typ: "JWT" }).sign(privateKey);
      minted.set(memo, { token, at: Date.now() });
      res.setHeader("Content-Type", "text/plain"); res.end(token);
    } catch { res.writeHead(500).end(); }
    return;
  }
  if (!url.pathname.startsWith("/internal/")) { res.writeHead(404).end(); return; }

  // ---- /internal/* ----
  const body = req.method === "PATCH" || req.method === "POST" ? await readBody(req) : "";
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
  const authHeader = String(req.headers.authorization ?? "");
  const authKind = authHeader === "Bearer fake-contact-token" ? "contact" : authHeader === "Bearer fake-status-token" ? "status" : "none";
  const match = /^\/internal\/users\/(\d+)\/status$/.exec(url.pathname);
  const isBatch = req.method === "GET" && url.pathname === "/internal/users";
  const isContacts = req.method === "GET" && url.pathname === "/internal/users/contacts";
  const isToken = req.method === "POST" && url.pathname === "/internal/auth/token";
  const ids = (isBatch || isContacts) ? (url.searchParams.get("ids") ?? "").split(",").map(Number).filter(Boolean) : [];
  if (isToken) tokens.push({ scope: String(parsed.scope ?? ""), mode, grant });
  if (isBatch) batches.push({ ids, requestId: req.headers["x-request-id"] ?? null, authKind, mode });
  if (isContacts) contacts.push({ ids, requestId: req.headers["x-request-id"] ?? null, authKind, mode });
  if (match) patches.push({ userId: Number(match[1]), status: parsed.status, requestId: req.headers["x-request-id"] ?? null, authKind, mode });
  if (mode === "hang") return; // never answer; Care times out after 2 s
  if (mode === "down") return json(res, 503, { success: false });
  if (mode === "slow") await new Promise((r) => setTimeout(r, 1000));

  if (isToken) {
    const scope = String(parsed.scope ?? "");
    const contactOnly = scope === "users:contact:read";
    const granted = contactOnly && grant === "none" ? "users:read" : scope;
    return json(res, 200, { success: true, data: { access_token: contactOnly ? "fake-contact-token" : "fake-status-token", token_type: "Bearer", expires_in: 300, scope: granted } });
  }
  if (isContacts) {
    if (mode === "403") return json(res, 403, { success: false, error: { code: "InsufficientScope", message: "scope", details: [], requestId: req.headers["x-request-id"] ?? "" } });
    if (authKind !== "contact") return json(res, 403, { success: false, error: { code: "InsufficientScope", message: "scope", details: [], requestId: "" } });
    const data = ids.filter((id) => overrides.get(id) !== "unknown").map((id) => ({
      id, email: `qa-fixture-${id}@example.invalid`, fullName: `QA Fixture Person ${id}`, locale: "en-US", status: overrides.get(id) ?? "active",
    }));
    return json(res, 200, { success: true, data });
  }
  if (isBatch) {
    if (authKind !== "status") return json(res, 403, { success: false });
    return json(res, 200, { success: true, data: ids.map((id) => ({ id, fullName: `Synthetic User ${id}`, avatarUrl: null, role: id >= 600 ? "doctor" : "patient", status: statusOf(id), timezone: "UTC", locale: "en" })) });
  }
  if (req.method === "PATCH" && match) {
    if (authKind !== "status") return json(res, 403, { success: false });
    const id = Number(match[1]);
    const cur = statusOf(id);
    const to = parsed.status;
    const allowed = cur === to || (cur === "active" && to === "suspended") || (cur === "suspended" && to === "active");
    if (!allowed) return json(res, 409, { success: false, error: { code: "InvalidStatusTransition" } });
    users.set(id, to);
    return json(res, 200, { success: true, data: { id, status: to, updatedAt: new Date().toISOString() } });
  }
  res.writeHead(404).end();
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
