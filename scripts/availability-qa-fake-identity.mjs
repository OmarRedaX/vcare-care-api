// Loopback-only, synthetic Identity for scripts/curl-test-availability.sh (availability slices 1 to 3).
// Serves: JWKS, a token mint (/mint?case=...), the client-credentials token (POST /internal/auth/token) and the batch user
// summary Care hydrates with (GET /internal/users?ids=...). Display names and avatar URLs are synthetic and unique per id so the
// QA script can scan Care's log for them. A small control surface (loopback only) lets the script flip Identity "down" without
// killing the process (JWKS stays up) and count batch calls. Keys and tokens exist only in memory. Nothing is logged.
import process from 'node:process';
import { URL } from 'node:url';
import http from 'node:http';
import { setTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake refuses production');
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3021);
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: 'availability-qa-1', alg: 'EdDSA', use: 'sig' };
const actors = {
  'patient-101': ['101', 'patient', 'active'],
  'patient-pending': ['109', 'patient', 'pending'],
  'admin-1': ['1', 'admin', 'active'],
  expired: ['101', 'patient', 'active'],
};
const state = { usersMode: 'up', statusOverride: new Map(), nameOverride: new Map(), userCalls: 0, lastIdsCount: 0, maxIdsCount: 0, tokenCalls: 0 };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return json(200, { keys: [jwk] });

  if (req.method === 'POST' && url.pathname === '/internal/auth/token') {
    state.tokenCalls += 1;
    req.resume();
    return json(200, { success: true, data: { access_token: 'qa-service-token', token_type: 'Bearer', expires_in: 300, scope: 'users:read users:status:write' } });
  }

  if (req.method === 'GET' && url.pathname === '/internal/users') {
    state.userCalls += 1;
    if (state.usersMode === 'down') { req.socket.destroy(); return; }
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
    state.lastIdsCount = ids.length;
    state.maxIdsCount = Math.max(state.maxIdsCount, ids.length);
    const reply = () => json(200, { success: true, data: ids.map((id) => ({
      id, fullName: state.nameOverride.get(id) ?? `Synthetic QA Doctor ${id}`, avatarUrl: `https://avatars.example.test/qa/${id}.png`, role: 'doctor',
      status: state.statusOverride.get(id) ?? 'active', timezone: 'UTC', locale: 'en' })) });
    if (state.usersMode === 'slow') return void setTimeout(reply, 4000);
    return reply();
  }

  // Control surface (QA only): /control/mode?users=up|down|slow, /control/user?id=&status= and/or &name= (a missing or empty
  // value restores the default; a call with only `name` leaves the status alone), /control/stats, /control/reset
  if (url.pathname === '/control/mode') { state.usersMode = url.searchParams.get('users') ?? 'up'; return json(200, { usersMode: state.usersMode }); }
  if (url.pathname === '/control/user') {
    const id = Number(url.searchParams.get('id'));
    const status = url.searchParams.get('status');
    const name = url.searchParams.get('name');
    if (url.searchParams.has('name')) { if (name) state.nameOverride.set(id, name); else state.nameOverride.delete(id); }
    if (url.searchParams.has('status') || !url.searchParams.has('name')) {
      if (status === 'active' || status === null) state.statusOverride.delete(id); else state.statusOverride.set(id, status);
    }
    return json(200, { id, status: status ?? 'active', renamed: state.nameOverride.has(id) });
  }
  if (url.pathname === '/control/stats') return json(200, { usersMode: state.usersMode, userCalls: state.userCalls, lastIdsCount: state.lastIdsCount, maxIdsCount: state.maxIdsCount, tokenCalls: state.tokenCalls });
  if (url.pathname === '/control/reset') { state.userCalls = 0; state.lastIdsCount = 0; state.maxIdsCount = 0; state.tokenCalls = 0; state.usersMode = 'up'; state.statusOverride.clear(); state.nameOverride.clear(); return json(200, {}); }

  const requested = url.searchParams.get('case') ?? '';
  const generic = /^(doctor|patient)-(\d{3,5})$/.exec(requested);
  const actor = actors[requested] ?? (generic ? [generic[2], generic[1], 'active'] : undefined);
  if (req.method !== 'GET' || url.pathname !== '/mint' || !actor) { res.writeHead(404).end(); return; }
  const now = Math.floor(Date.now() / 1000);
  const isExpired = requested === 'expired';
  const payload = { iss: 'vcare-identity', aud: ['vcare-identity', 'vcare-care'], sub: actor[0],
    typ: 'user', role: actor[1], status: actor[2], ev: true, jti: randomUUID(),
    iat: isExpired ? now - 1500 : now, exp: isExpired ? now - 600 : now + 900 };
  new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' }).sign(privateKey)
    .then(token => { res.setHeader('Content-Type', 'text/plain'); res.end(token); })
    .catch(() => res.writeHead(500).end());
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
