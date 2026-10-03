import http from "node:http";
import type {
    FakeHttpServer,
    FakeRoute,
    FakeServerMode,
    FakeServerModeOptions,
    RecordedRequest,
} from "./types";

/**
 * Minimal local HTTP server for faking system-external dependencies (the Identity fake will be built on
 * this). Supports `slow` and `fail` modes so timeout and degradation paths are testable.
 */
export function startFakeHttpServer(routes: FakeRoute[]): Promise<FakeHttpServer> {
    const requests: RecordedRequest[] = [];
    let mode: FakeServerMode = "normal";
    let modeOptions: FakeServerModeOptions = {};

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            requests.push({
                method: req.method ?? "GET",
                url: req.url ?? "/",
                headers: req.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            });

            const respond = (): void => {
                if (mode === "fail") {
                    res.writeHead(modeOptions.status ?? 500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "fake_failure" }));
                    return;
                }

                const path = (req.url ?? "/").split("?")[0] ?? "/";
                const route = routes.find(
                    (candidate) => candidate.method === (req.method ?? "GET") && candidate.path === path,
                );
                if (route === undefined) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "not_found" }));
                    return;
                }
                res.writeHead(route.status, { "Content-Type": route.contentType ?? "application/json" });
                res.end(route.rawBody ?? (route.body === undefined ? "" : JSON.stringify(route.body)));
            };

            if (mode === "slow") {
                setTimeout(respond, modeOptions.delayMs ?? 5_000);
                return;
            }
            respond();
        });
    });

    return new Promise<FakeHttpServer>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}`,
                requests,
                setMode(nextMode: FakeServerMode, options?: FakeServerModeOptions) {
                    mode = nextMode;
                    modeOptions = options ?? {};
                },
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections();
                        server.close(() => done());
                    }),
            });
        });
    });
}
