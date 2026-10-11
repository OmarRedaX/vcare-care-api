// Loopback-only, synthetic JWKS and user-token issuer for scripts/curl-test-patients.sh.
// Keys and tokens exist only in memory. No requests or responses are logged.
import process from 'node:process';
import { URL } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake refuses production');
const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3022);
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: 'patients-qa-1', alg: 'EdDSA', use: 'sig' };
// case -> [sub, role, status, emailVerified]
const actors = {
  'doctor-201': ['201', 'doctor', 'active', true],
  'doctor-pending': ['202', 'doctor', 'pending', true],
  'doctor-rejected': ['203', 'doctor', 'rejected', true],
  'admin-1': ['1', 'admin', 'active', true],
  'patient-pending': ['391', 'patient', 'pending', true],
  'patient-rejected': ['392', 'patient', 'rejected', true],
  'patient-suspended': ['393', 'patient', 'suspended', true],
  'patient-unverified': ['394', 'patient', 'active', false],
  expired: ['301', 'patient', 'active', true],
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
  const generic = /^patient-(\d{3})$/.exec(requested);
  const actor = actors[requested] ?? (generic ? [generic[1], 'patient', 'active', true] : undefined);
  if (req.method !== 'GET' || url.pathname !== '/mint' || !actor) {
    res.writeHead(404).end();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const isExpired = requested === 'expired';
  const typ = url.searchParams.get('typ') ?? 'user';
  const payload = { iss: 'vcare-identity', aud: ['vcare-identity', 'vcare-care'], sub: actor[0],
    typ, role: actor[1], status: actor[2], ev: actor[3], jti: randomUUID(),
    iat: isExpired ? now - 1500 : now, exp: isExpired ? now - 600 : now + 900 };
  new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' }).sign(privateKey)
    .then(token => { res.setHeader('Content-Type', 'text/plain'); res.end(token); })
    .catch(() => res.writeHead(500).end());
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
