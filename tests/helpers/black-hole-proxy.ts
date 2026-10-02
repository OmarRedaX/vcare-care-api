import net from "node:net";
import type { AddressInfo } from "node:net";
import type { BlackHoleProxy, ProxiedConnection } from "./types";

/**
 * A TCP proxy in front of the test Postgres that stands in for a failover or partition WITHOUT an RST: after
 * `blackHoleEstablished()` the connections that were open stop carrying bytes in either direction and are never
 * closed, while new connections reach Postgres (the "new primary"). Review 2026-09-28, re-opened Medium.
 */
export async function startBlackHoleProxy(targetUrl: string): Promise<BlackHoleProxy> {
    const target = new URL(targetUrl);
    const connections = new Set<ProxiedConnection>();
    let accepted = 0;

    const server = net.createServer((client) => {
        accepted += 1;
        const upstream = net.connect({ host: target.hostname, port: Number(target.port || 5432) });
        const entry: ProxiedConnection = { client, upstream, holed: false };
        connections.add(entry);

        client.on("data", (chunk: Buffer) => {
            if (!entry.holed) {
                upstream.write(chunk);
            }
        });
        upstream.on("data", (chunk: Buffer) => {
            if (!entry.holed) {
                client.write(chunk);
            }
        });
        const teardown = (): void => {
            connections.delete(entry);
            client.destroy();
            upstream.destroy();
        };
        // A black-holed pair never forwards a close either: the application side must give up on its own.
        client.on("close", teardown);
        client.on("error", teardown);
        upstream.on("close", () => (entry.holed ? undefined : teardown()));
        upstream.on("error", () => (entry.holed ? undefined : teardown()));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const proxyUrl = new URL(targetUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String((server.address() as AddressInfo).port);

    return {
        url: proxyUrl.toString(),
        acceptedCount: () => accepted,
        blackHoleEstablished: () => {
            for (const entry of connections) {
                entry.holed = true;
            }
        },
        close: async () => {
            for (const entry of connections) {
                entry.client.destroy();
                entry.upstream.destroy();
            }
            connections.clear();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
