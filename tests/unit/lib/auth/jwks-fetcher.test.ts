import http from "node:http";
import type { AddressInfo } from "node:net";
import type * as ConstantsModule from "../../../../src/lib/auth/constants";
import type * as FetcherModule from "../../../../src/lib/auth/jwks-fetcher";
import type * as RequestContextModule from "../../../../src/lib/logger/request-context";

/**
 * The real budget is 2 s (asserted below against the actual constant); this suite loads the fetcher in an isolated
 * module registry with a 400 ms budget so the timeout case stays fast while a cold request under a loaded parallel
 * run still fits (beforeAll also warms undici and the connection). tests/setup.ts already loaded the real modules
 * (registerDependencies), so a hoisted jest.mock would not reach them. Every other constant is the real one.
 */
let fetchJwksDocument: typeof FetcherModule.fetchJwksDocument;
let JwksFetchError: typeof FetcherModule.JwksFetchError;
let requestContext: typeof RequestContextModule.requestContext;
jest.isolateModules(() => {
    jest.doMock("../../../../src/lib/auth/constants", () => ({
        ...jest.requireActual<typeof ConstantsModule>("../../../../src/lib/auth/constants"),
        JWKS_FETCH_TIMEOUT_MS: 400,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require("../../../../src/lib/auth/jwks-fetcher") as typeof FetcherModule;
    fetchJwksDocument = loaded.fetchJwksDocument;
    JwksFetchError = loaded.JwksFetchError;
    // The same registry instance the fetcher reads its request id from.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    requestContext = (require("../../../../src/lib/logger/request-context") as typeof RequestContextModule).requestContext;
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let base: string;
let handler: Handler;
const seenHeaders: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        seenHeaders.push(req.headers);
        handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handler = json("{\"keys\":[]}");
    await fetchJwksDocument(`${base}/warm-up`, new AbortController().signal);
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    seenHeaders.length = 0;
});

const json = (body: string, contentType = "application/json"): Handler => (_req, res) => {
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
};

async function reasonOf(promise: Promise<unknown>): Promise<{ reason: string; status?: number }> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(JwksFetchError);
        const failure = error as FetcherModule.JwksFetchError;
        return { reason: failure.reason, ...(failure.status !== undefined ? { status: failure.status } : {}) };
    }
    throw new Error("expected the fetch to fail");
}

const signal = (): AbortSignal => new AbortController().signal;

describe("lib/auth/fetchJwksDocument", () => {
    it("should keep the real fetch budget at 2 s, 64 KiB", () => {
        const actual = jest.requireActual<typeof ConstantsModule>(
            "../../../../src/lib/auth/constants",
        );
        expect(actual.JWKS_FETCH_TIMEOUT_MS).toBe(2_000);
        expect(actual.JWKS_MAX_BYTES).toBe(65_536);
    });

    it("should return the parsed document when the response is 200 JSON", async () => {
        handler = json('{"keys":[{"kid":"k1"}]}');
        await expect(fetchJwksDocument(`${base}/jwks`, signal())).resolves.toEqual({ keys: [{ kid: "k1" }] });
        expect(seenHeaders[0]?.accept).toBe("application/json");
    });

    it("should accept application/jwk-set+json with parameters", async () => {
        handler = json('{"keys":[]}', "application/jwk-set+json; charset=utf-8");
        await expect(fetchJwksDocument(`${base}/jwks`, signal())).resolves.toEqual({ keys: [] });
    });

    it("should reject a redirect with http_status and never follow it", async () => {
        handler = (req, res) => {
            if (req.url === "/moved") {
                res.writeHead(302, { Location: "/jwks" });
                res.end();
                return;
            }
            json('{"keys":[]}')(req, res);
        };
        await expect(reasonOf(fetchJwksDocument(`${base}/moved`, signal()))).resolves.toEqual({
            reason: "http_status",
            status: 302,
        });
        expect(seenHeaders).toHaveLength(1);
    });

    it("should reject a 5xx with http_status and its status", async () => {
        handler = (_req, res) => {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end("{}");
        };
        await expect(reasonOf(fetchJwksDocument(`${base}/jwks`, signal()))).resolves.toEqual({
            reason: "http_status",
            status: 503,
        });
    });

    it("should reject a non-JSON content type with content_type", async () => {
        handler = json('{"keys":[]}', "text/html");
        await expect(reasonOf(fetchJwksDocument(`${base}/jwks`, signal()))).resolves.toEqual({ reason: "content_type" });
    });

    it("should reject a body over 64 KiB with too_large", async () => {
        handler = json(`{"keys":[],"pad":"${"a".repeat(70_000)}"}`);
        await expect(reasonOf(fetchJwksDocument(`${base}/jwks`, signal()))).resolves.toEqual({ reason: "too_large" });
    });

    it("should reject invalid JSON with invalid_json", async () => {
        handler = json('{"keys": [');
        await expect(reasonOf(fetchJwksDocument(`${base}/jwks`, signal()))).resolves.toEqual({ reason: "invalid_json" });
    });

    it("should time out with reason timeout when the server does not answer within the budget", async () => {
        handler = () => undefined; // never responds
        const startedAt = Date.now();
        await expect(reasonOf(fetchJwksDocument(`${base}/jwks`, signal()))).resolves.toEqual({ reason: "timeout" });
        expect(Date.now() - startedAt).toBeLessThan(1_500);
    });

    it("should reject with network when nothing listens on the port", async () => {
        await expect(reasonOf(fetchJwksDocument("http://127.0.0.1:1/jwks", signal()))).resolves.toEqual({
            reason: "network",
        });
    });

    it("should stop when the caller's signal aborts", async () => {
        handler = () => undefined;
        const controller = new AbortController();
        const pending = fetchJwksDocument(`${base}/jwks`, controller.signal);
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(JwksFetchError);
    });

    it("should send X-Request-Id from the request context when one is open, else a generated UUID", async () => {
        handler = json('{"keys":[]}');
        const requestId = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
        await requestContext.run({ requestId }, () => fetchJwksDocument(`${base}/jwks`, signal()));
        await fetchJwksDocument(`${base}/jwks`, signal());

        expect(seenHeaders[0]?.["x-request-id"]).toBe(requestId);
        expect(seenHeaders[1]?.["x-request-id"]).toMatch(UUID);
        expect(seenHeaders[1]?.["x-request-id"]).not.toBe(requestId);
    });

    it("should never put the URL path or the body into the error message", async () => {
        handler = json("SYNTHETIC-BODY-7781 not json");
        try {
            await fetchJwksDocument(`${base}/secret-path-3321`, signal());
            throw new Error("expected failure");
        } catch (error) {
            expect((error as Error).message).toBe("jwks_fetch_failed: invalid_json");
            expect((error as Error).message).not.toContain("secret-path-3321");
        }
    });
});
