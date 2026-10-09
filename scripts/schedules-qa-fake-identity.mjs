// Loopback-only, synthetic JWKS and user-token issuer for scripts/curl-test-schedules.sh.
// Keys and tokens exist only in memory. No requests or responses are logged.
import process from 'node:process';
import { URL } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake refuses production');
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3021);
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: 'schedules-qa-1', alg: 'EdDSA', use: 'sig' };
const actors = {
  'patient-101': ['101', 'patient', 'active'],
  'doctor-201': ['201', 'doctor', 'active'],       // owner doctor (Africa/Cairo)
  'doctor-204': ['204', 'doctor', 'active'],       // other doctor with its own profile (non-owner)
  'doctor-205': ['205', 'doctor', 'active'],       // active token, no profile
  'doctor-206': ['206', 'doctor', 'active'],       // DST doctor (Europe/Berlin)
  'doctor-207': ['207', 'doctor', 'active'],       // rate-limit doctor
  'doctor-pending': ['202', 'doctor', 'pending'],
  'doctor-rejected': ['203', 'doctor', 'rejected'],
  'admin-1': ['1', 'admin', 'active'],
  expired: ['201', 'doctor', 'active'],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  const requested = url.searchParams.get('case') ?? '';
  const generic = /^doctor-(\d{3})$/.exec(requested);
  const actor = actors[requested] ?? (generic ? [generic[1], 'doctor', 'active'] : undefined);
  if (req.method !== 'GET' || url.pathname !== '/mint' || !actor) {
    res.writeHead(404).end();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const isExpired = url.searchParams.get('case') === 'expired';
  const payload = { iss: 'vcare-identity', aud: ['vcare-identity', 'vcare-care'], sub: actor[0],
    typ: 'user', role: actor[1], status: actor[2], ev: true, jti: randomUUID(),
    iat: isExpired ? now - 1500 : now, exp: isExpired ? now - 600 : now + 900 };
  new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' }).sign(privateKey)
    .then(token => { res.setHeader('Content-Type', 'text/plain'); res.end(token); })
    .catch(() => res.writeHead(500).end());
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
