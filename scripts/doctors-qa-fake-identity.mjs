// Loopback-only, synthetic JWKS and user-token issuer for scripts/curl-test-doctors.sh.
// Keys and tokens exist only in memory. No requests or responses are logged.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake refuses production');
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3021);
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: 'doctors-qa-1', alg: 'EdDSA', use: 'sig' };
const actors = {
  'patient-101': ['101', 'patient', 'active'],
  'doctor-201': ['201', 'doctor', 'active'],
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
  const actor = actors[url.searchParams.get('case')];
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
