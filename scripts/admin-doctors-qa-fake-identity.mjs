import { Buffer } from "node:buffer";
// Loopback-only, synthetic Identity for scripts/curl-test-admin-doctors.sh. Everything lives in memory.
// Serves: JWKS + token minting (user tokens for Care), POST /internal/auth/token, PATCH /internal/users/:id/status,
// GET /internal/users?ids=, and a runtime control surface (no Care restart needed):
//   GET /__ctl?mode=healthy|down|hang|conflict   switch the /internal/* behaviour
//          healthy  Identity behaves per contract (users start `active`, transitions validated)
//          down     /internal/* answers 503
//          hang     /internal/* never answers (Care's 2 s client timeout fires)
//          conflict PATCH status answers 409 InvalidStatusTransition (token + batch still work)
//   GET /__calls                                  {mode, patchCount, patches:[{userId,status,actorUserId,requestId,reasonCodePoints,answered}]}
//   GET /__reset                                  clear the call log and set every user back to `active`, mode healthy
//   GET /__user?id=<n>&status=<s>                 set/read a fake Identity user's status (no status => read only)
// Request/response bodies and reasons are never logged; only the code-point length of a reason is recorded.
import process from 'node:process';
import { URL } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake refuses production');
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3021);
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: 'admin-doctors-qa-1', alg: 'EdDSA', use: 'sig' };
const actors = {
  'patient-101': ['101', 'patient', 'active'],
  'admin-1': ['1', 'admin', 'active'],
  'admin-2': ['2', 'admin', 'active'],
  'admin-suspended': ['3', 'admin', 'suspended'],
  expired: ['1', 'admin', 'active'],
};
let mode = 'healthy';
let patches = [];
const users = new Map(); // id -> status
const statusOf = (id) => users.get(id) ?? 'active';

const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });
  if (req.method === 'GET' && url.pathname === '/__ctl') {
    const m = url.searchParams.get('mode');
    if (!['healthy', 'down', 'hang', 'conflict'].includes(m ?? '')) return json(res, 400, { error: 'bad mode' });
    mode = m; return json(res, 200, { mode });
  }
  if (req.method === 'GET' && url.pathname === '/__calls') return json(res, 200, { mode, patchCount: patches.length, patches });
  if (req.method === 'GET' && url.pathname === '/__reset') { patches = []; users.clear(); mode = 'healthy'; return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/__user') {
    const id = Number(url.searchParams.get('id'));
    const s = url.searchParams.get('status');
    if (s) users.set(id, s);
    return json(res, 200, { id, status: statusOf(id) });
  }
  if (req.method === 'GET' && url.pathname === '/mint') {
    const requested = url.searchParams.get('case') ?? '';
    const generic = /^doctor-(\d{3})$/.exec(requested);
    const genericAdmin = /^admin-(\d{1,3})$/.exec(requested);
    const actor = actors[requested] ?? (generic ? [generic[1], 'doctor', 'active'] : genericAdmin ? [genericAdmin[1], 'admin', 'active'] : undefined);
    if (!actor) { res.writeHead(404).end(); return; }
    const now = Math.floor(Date.now() / 1000);
    const isExpired = requested === 'expired';
    const payload = { iss: 'vcare-identity', aud: ['vcare-identity', 'vcare-care'], sub: actor[0], typ: 'user', role: actor[1],
      status: actor[2], ev: true, jti: randomUUID(), iat: isExpired ? now - 1500 : now, exp: isExpired ? now - 600 : now + 900 };
    try {
      const token = await new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' }).sign(privateKey);
      res.setHeader('Content-Type', 'text/plain'); res.end(token);
    } catch { res.writeHead(500).end(); }
    return;
  }
  if (!url.pathname.startsWith('/internal/')) { res.writeHead(404).end(); return; }

  // ---- /internal/* ----
  const body = req.method === 'PATCH' || req.method === 'POST' ? await readBody(req) : '';
  const match = /^\/internal\/users\/(\d+)\/status$/.exec(url.pathname);
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
  const record = (answered) => {
    if (!match) return;
    patches.push({ userId: Number(match[1]), status: parsed.status, actorUserId: parsed.actorUserId,
      requestId: req.headers['x-request-id'] ?? null, reasonCodePoints: typeof parsed.reason === 'string' ? [...parsed.reason].length : null, answered });
  };
  if (mode === 'hang') { record('hang'); return; } // never answer; the socket is closed when Care times out
  if (mode === 'down') { record(503); return json(res, 503, { success: false }); }
  if (req.method === 'POST' && url.pathname === '/internal/auth/token') {
    return json(res, 200, { success: true, data: { access_token: 'fake-service-token', token_type: 'Bearer', expires_in: 300, scope: 'users:read users:status:write' } });
  }
  if (req.method === 'GET' && url.pathname === '/internal/users') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Boolean);
    return json(res, 200, { success: true, data: ids.map((id) => ({ id, fullName: 'Synthetic User', avatarUrl: null, role: 'doctor', status: statusOf(id), timezone: 'UTC', locale: 'en' })) });
  }
  if (req.method === 'PATCH' && match) {
    const id = Number(match[1]);
    if (typeof parsed.reason !== 'string' || [...parsed.reason].length > 500) {
      record(400);
      return json(res, 400, { success: false, error: { code: 'ValidationFailed', message: 'Request validation failed', details: [{ field: 'reason', issue: 'must be at most 500 characters' }] } });
    }
    if (mode === 'conflict') { record(409); return json(res, 409, { success: false, error: { code: 'InvalidStatusTransition' } }); }
    const cur = statusOf(id);
    const to = parsed.status;
    const allowed = cur === to || (cur === 'pending' && ['active', 'rejected'].includes(to)) || (cur === 'rejected' && to === 'pending') ||
      (cur === 'active' && to === 'suspended') || (cur === 'suspended' && to === 'active');
    if (!allowed) { record(409); return json(res, 409, { success: false, error: { code: 'InvalidStatusTransition' } }); }
    users.set(id, to);
    record(200);
    return json(res, 200, { success: true, data: { id, status: to, updatedAt: new Date().toISOString() } });
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
