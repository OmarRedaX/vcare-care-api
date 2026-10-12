import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
// Loopback-only, synthetic Identity for scripts/curl-test-consultations.sh. Everything lives in memory.
// Serves: JWKS + user-token minting, POST /internal/auth/token, PATCH /internal/users/:id/status,
// GET /internal/users?ids= (Case 2 batch hydration), and a runtime control surface (no Care restart needed):
//   GET /__ctl?mode=healthy|down|hang|slow   switch the /internal/* behaviour
//          healthy  Identity behaves per contract
//          down     /internal/* answers 503
//          hang     /internal/* never answers (Care's 2 s client timeout fires)
//          slow     /internal/* answers after 1 s (inside Care's 2 s timeout)
//   GET /__calls    {mode, batchCount, batches:[{ids,requestId}], patchCount, patches:[{userId,status,requestId}]}
//   GET /__reset    clear the call log, mode healthy
// Minted tokens are memoised per (case, typ) for 10 minutes so a script run sees a stable token per actor.
// Request/response bodies and reasons are never logged.
import process from 'node:process';
import { URL } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake refuses production');
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3023);
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: 'consultations-qa-1', alg: 'EdDSA', use: 'sig' };
// case -> [sub, role, status, emailVerified]
const actors = {
  'patient-pending': ['591', 'patient', 'pending', true],
  'patient-rejected': ['592', 'patient', 'rejected', true],
  'patient-suspended': ['593', 'patient', 'suspended', true],
  'patient-unverified': ['594', 'patient', 'active', false],
  'doctor-pending': ['690', 'doctor', 'pending', true],
  'doctor-rejected': ['691', 'doctor', 'rejected', true],
  'admin-suspended': ['3', 'admin', 'suspended', true],
  expired: ['501', 'patient', 'active', true],
};
let mode = 'healthy';
let batches = [];
let patches = [];
const users = new Map();
const statusOf = (id) => users.get(id) ?? 'active';
const minted = new Map();

const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });
  if (req.method === 'GET' && url.pathname === '/__ctl') {
    const m = url.searchParams.get('mode');
    if (!['healthy', 'down', 'hang', 'slow'].includes(m ?? '')) return json(res, 400, { error: 'bad mode' });
    mode = m; return json(res, 200, { mode });
  }
  if (req.method === 'GET' && url.pathname === '/__calls') return json(res, 200, { mode, batchCount: batches.length, batches, patchCount: patches.length, patches });
  if (req.method === 'GET' && url.pathname === '/__reset') { batches = []; patches = []; users.clear(); mode = 'healthy'; return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/mint') {
    const requested = url.searchParams.get('case') ?? '';
    const typ = url.searchParams.get('typ') ?? 'user';
    const patient = /^patient-(\d{3})$/.exec(requested);
    const doctor = /^doctor-(\d{3})$/.exec(requested);
    const admin = /^admin-(\d{1,3})$/.exec(requested);
    const actor = actors[requested] ?? (patient ? [patient[1], 'patient', 'active', true] : doctor ? [doctor[1], 'doctor', 'active', true] : admin ? [admin[1], 'admin', 'active', true] : undefined);
    if (!actor) { res.writeHead(404).end(); return; }
    const memo = `${requested}|${typ}`;
    const hit = minted.get(memo);
    if (hit && Date.now() - hit.at < 600_000) { res.setHeader('Content-Type', 'text/plain'); res.end(hit.token); return; }
    const now = Math.floor(Date.now() / 1000);
    const isExpired = requested === 'expired';
    const payload = { iss: 'vcare-identity', aud: ['vcare-identity', 'vcare-care'], sub: actor[0], typ, role: actor[1],
      status: actor[2], ev: actor[3], jti: randomUUID(), iat: isExpired ? now - 1500 : now, exp: isExpired ? now - 600 : now + 900 };
    try {
      const token = await new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' }).sign(privateKey);
      minted.set(memo, { token, at: Date.now() });
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
  const isBatch = req.method === 'GET' && url.pathname === '/internal/users';
  const ids = isBatch ? (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Boolean) : [];
  if (isBatch) batches.push({ ids, requestId: req.headers['x-request-id'] ?? null, mode });
  if (match) patches.push({ userId: Number(match[1]), status: parsed.status, requestId: req.headers['x-request-id'] ?? null, mode });
  if (mode === 'hang') return; // never answer; Care times out after 2 s
  if (mode === 'down') return json(res, 503, { success: false });
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 1000));
  if (req.method === 'POST' && url.pathname === '/internal/auth/token') {
    return json(res, 200, { success: true, data: { access_token: 'fake-service-token', token_type: 'Bearer', expires_in: 300, scope: 'users:read users:status:write' } });
  }
  if (isBatch) {
    return json(res, 200, { success: true, data: ids.map((id) => ({ id, fullName: `Synthetic User ${id}`, avatarUrl: null, role: id >= 600 ? 'doctor' : 'patient', status: statusOf(id), timezone: 'UTC', locale: 'en' })) });
  }
  if (req.method === 'PATCH' && match) {
    const id = Number(match[1]);
    const cur = statusOf(id);
    const to = parsed.status;
    const allowed = cur === to || (cur === 'active' && to === 'suspended') || (cur === 'suspended' && to === 'active');
    if (!allowed) return json(res, 409, { success: false, error: { code: 'InvalidStatusTransition' } });
    users.set(id, to);
    return json(res, 200, { success: true, data: { id, status: to, updatedAt: new Date().toISOString() } });
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
