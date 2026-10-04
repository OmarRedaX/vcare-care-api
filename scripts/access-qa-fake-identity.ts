/**
 * DEV-ONLY manual-QA helper for the access unit (docs/access/manual-qa.md). A loopback-only stand-in for Identity's
 * public JWKS that also MINTS edge-case user tokens, so scripts/curl-test-access.sh can exercise claim-level guard
 * failures (expired, wrong aud/iss/typ, missing claims, alg none, HS256, tampered, unknown kid, ...) against a second
 * access QA server whose IDENTITY_JWKS_URL points here. Real Identity cannot issue such tokens.
 *
 * Keys are generated fresh at every start (tests/helpers/tokens.ts); no key material is ever written to disk, and
 * tokens are returned only in HTTP responses on 127.0.0.1 — never logged. Refuses NODE_ENV=production.
 *
 *   FAKE_IDENTITY_PORT=3021 npx tsx scripts/access-qa-fake-identity.ts
 *
 *   GET  /.well-known/jwks.json      the published key set (counts requests)
 *   GET  /mint?case=<name>           text/plain token for one named case (see CASES)
 *   POST /keys/add?kid=<kid>         generate + publish a new key (rotation)
 *   GET  /stats                      { jwksRequests }
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import {
    generateSigningKey,
    signExpiredUserToken,
    signHs256Token,
    signUserToken,
    tamperToken,
    unsignedToken,
} from "../tests/helpers/tokens";
import type { SigningKey } from "../tests/helpers/types";

const PRIMARY_KID = "qa-fake-1";

async function main(): Promise<void> {
    if (process.env.NODE_ENV === "production") {
        process.stderr.write("access-qa-fake-identity refused: NODE_ENV is production\n");
        process.exit(1);
    }
    const port = Number(process.env.FAKE_IDENTITY_PORT ?? 3021);
    const keys = new Map<string, SigningKey>();
    const published = new Set<string>();
    keys.set(PRIMARY_KID, await generateSigningKey(PRIMARY_KID));
    published.add(PRIMARY_KID);
    const unpublished = await generateSigningKey("qa-unknown-kid");
    let jwksRequests = 0;

    const primary = (): SigningKey => keys.get(PRIMARY_KID) as SigningKey;
    const now = (): number => Math.floor(Date.now() / 1_000);

    const CASES: Record<string, () => Promise<string> | string> = {
        // valid principals (sub chosen to match the test routers: 101/102 own resources 1/2, 9001 is "blocked")
        "patient-101": () => signUserToken(primary(), { sub: "101", role: "patient" }),
        "patient-102": () => signUserToken(primary(), { sub: "102", role: "patient" }),
        "patient-pending": () => signUserToken(primary(), { sub: "103", role: "patient", status: "pending" }),
        "patient-suspended": () => signUserToken(primary(), { sub: "104", role: "patient", status: "suspended" }),
        "patient-unverified": () => signUserToken(primary(), { sub: "105", role: "patient", ev: false }),
        "doctor-101": () => signUserToken(primary(), { sub: "101", role: "doctor" }),
        "doctor-201": () => signUserToken(primary(), { sub: "201", role: "doctor" }),
        "doctor-9001": () => signUserToken(primary(), { sub: "9001", role: "doctor" }),
        "doctor-pending": () => signUserToken(primary(), { sub: "202", role: "doctor", status: "pending" }),
        "doctor-rejected": () => signUserToken(primary(), { sub: "203", role: "doctor", status: "rejected" }),
        "doctor-suspended": () => signUserToken(primary(), { sub: "204", role: "doctor", status: "suspended" }),
        "admin-1": () => signUserToken(primary(), { sub: "1", role: "admin" }),
        "admin-9001": () => signUserToken(primary(), { sub: "9001", role: "admin" }),
        "admin-suspended": () => signUserToken(primary(), { sub: "3", role: "admin", status: "suspended" }),
        "admin-pending": () => signUserToken(primary(), { sub: "2", role: "admin", status: "pending" }),
        // time
        expired: () => signExpiredUserToken(primary()),
        "expired-within-tolerance": () => signUserToken(primary(), { iat: now() - 900, exp: now() - 20 }),
        "nbf-future": () => signUserToken(primary(), { nbf: now() + 120 }),
        "nbf-within-tolerance": () => signUserToken(primary(), { nbf: now() + 20 }),
        "expired-bad-signature": async () => tamperToken(await signExpiredUserToken(primary())),
        // claims
        "wrong-aud": () => signUserToken(primary(), { aud: ["vcare-identity"] }),
        "wrong-iss": () => signUserToken(primary(), { iss: "evil-identity" }),
        "typ-service": () => signUserToken(primary(), { typ: "service" }),
        "no-sub": () => signUserToken(primary(), { sub: undefined }),
        "no-exp": () => signUserToken(primary(), { exp: undefined }),
        "no-iat": () => signUserToken(primary(), { iat: undefined }),
        "no-jti": () => signUserToken(primary(), { jti: undefined }),
        "sub-zero": () => signUserToken(primary(), { sub: "0" }),
        "sub-nonnumeric": () => signUserToken(primary(), { sub: "abc" }),
        "sub-unsafe": () => signUserToken(primary(), { sub: "9007199254740993" }),
        "role-bogus": () => signUserToken(primary(), { role: "superuser" }),
        "status-bogus": () => signUserToken(primary(), { status: "frozen" }),
        "ev-string": () => signUserToken(primary(), { ev: "true" }),
        "jti-too-long": () => signUserToken(primary(), { jti: "j".repeat(65) }),
        // header / signature
        "unknown-kid": () => signUserToken(unpublished),
        "no-kid": () => signUserToken(primary(), undefined, { header: { kid: undefined } }),
        tampered: async () => tamperToken(await signUserToken(primary())),
        "alg-none": () => unsignedToken(PRIMARY_KID),
        hs256: () => signHs256Token(PRIMARY_KID, randomBytes(32)),
        "oversize": async () => `${await signUserToken(primary())}${"A".repeat(4_100)}`,
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const send = (status: number, body: string, type = "text/plain"): void => {
            res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
            res.end(body);
        };
        void (async () => {
            if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
                jwksRequests += 1;
                const body = { keys: [...published].map((kid) => keys.get(kid)?.publicJwk) };
                res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
                res.end(JSON.stringify(body));
                return;
            }
            if (req.method === "GET" && url.pathname === "/mint") {
                const name = url.searchParams.get("case") ?? "";
                const kid = url.searchParams.get("kid");
                if (kid !== null) {
                    const key = keys.get(kid);
                    if (key === undefined) {
                        send(404, "unknown kid");
                        return;
                    }
                    send(200, await signUserToken(key));
                    return;
                }
                const build = CASES[name];
                if (build === undefined) {
                    send(404, `unknown case; known: ${Object.keys(CASES).join(",")}`);
                    return;
                }
                send(200, await build());
                return;
            }
            if (req.method === "POST" && url.pathname === "/keys/add") {
                const kid = url.searchParams.get("kid") ?? `qa-fake-${keys.size + 1}`;
                keys.set(kid, await generateSigningKey(kid));
                published.add(kid);
                send(201, kid);
                return;
            }
            if (req.method === "GET" && url.pathname === "/stats") {
                send(200, JSON.stringify({ jwksRequests }), "application/json");
                return;
            }
            send(404, "not found");
        })().catch(() => send(500, "mint failed"));
    });

    server.listen(port, "127.0.0.1", () => {
        process.stdout.write(`access_qa_fake_identity_started port=${port}\n`);
    });
    const stop = (): void => {
        server.close(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}

void main();
