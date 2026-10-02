import net from "node:net";
import type { AddressInfo } from "node:net";
import { createKnex } from "../../src/lib/knex/knex";

/**
 * Review 2026-09-26 (Medium): pg defaults have no connect timeout, no query timeout, and no TCP keepalive, so a
 * black-holed Postgres (partition, failover without RST) hung connections for ~15 min. A local TCP server that
 * accepts and never answers stands in for it — no Postgres needed.
 */
describe("knex client-side timeouts against a server that accepts and never replies (integration)", () => {
    let server: net.Server;
    let port: number;
    const sockets = new Set<net.Socket>();

    beforeAll(async () => {
        server = net.createServer((socket) => {
            sockets.add(socket); // accept, read nothing, answer nothing
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("should fail a query within the 2 s connect timeout even when the pool would wait 60 s (care-migrate)", async () => {
        const knex = createKnex({
            url: `postgres://care:care@127.0.0.1:${port}/care_test`,
            poolMax: 1,
            statementTimeoutMs: null,
            applicationName: "care-migrate",
        });
        const startedAt = Date.now();
        try {
            await expect(knex.raw("SELECT 1")).rejects.toThrow();
            expect(Date.now() - startedAt).toBeLessThan(4_000);
        } finally {
            await knex.destroy();
        }
    }, 15_000);

    it("should fail a query within the 1 s acquire timeout when the application is care-api", async () => {
        const knex = createKnex({
            url: `postgres://care:care@127.0.0.1:${port}/care_test`,
            poolMax: 1,
            statementTimeoutMs: 2_000,
            applicationName: "care-api",
        });
        const startedAt = Date.now();
        try {
            await expect(knex.raw("SELECT 1")).rejects.toThrow();
            expect(Date.now() - startedAt).toBeLessThan(2_500);
        } finally {
            await knex.destroy();
        }
    }, 15_000);
});
