import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createKnex } from "../../../../src/lib/knex/knex";
import { isConnectionIdle } from "../../../../src/lib/knex/pg-connection-state";

/**
 * Review 2026-09-28 (re-opened Medium): a connection whose query hit `query_timeout` must be discarded, not reissued.
 * `isConnectionIdle` reads pg-PRIVATE fields; these tests fail first when a pg upgrade changes them.
 */
describe("lib/knex/isConnectionIdle", () => {
    it("should find the private query-state fields it reads on a real pg Client (pinned to pg 8.23)", () => {
        const pgVersion = (JSON.parse(readFileSync(require.resolve("pg/package.json"), "utf8")) as { version: string })
            .version;
        expect(pgVersion).toMatch(/^8\.23\./);
        const client = new Client({ connectionString: "postgres://care:care@127.0.0.1:1/care_unit" });
        expect("_activeQuery" in client).toBe(true);
        const state = client as unknown as Record<string, unknown>;
        expect(state._activeQuery).toBeNull();
        expect(Array.isArray(state._queryQueue)).toBe(true);
        expect(Array.isArray(state._sentQueryQueue)).toBe(true);
        expect(isConnectionIdle(client)).toBe(true);
    });

    it("should report a real pg Client busy when a query is queued on it", () => {
        const client = new Client({ connectionString: "postgres://care:care@127.0.0.1:1/care_unit" });
        // Never connected, so pg is not ready for a query: it stays in `_queryQueue` (no socket, no timer).
        client.query("SELECT 1").catch(() => undefined);
        const state = client as unknown as Record<string, unknown>;
        expect(state._queryQueue).toHaveLength(1);
        expect(isConnectionIdle(client)).toBe(false);
    });

    it.each([
        ["an active (sent, unanswered) query", { _activeQuery: {}, _queryQueue: [], _sentQueryQueue: [] }, false],
        ["a queued query", { _activeQuery: null, _queryQueue: [{}], _sentQueryQueue: [] }, false],
        ["a pipelined sent query", { _activeQuery: null, _queryQueue: [], _sentQueryQueue: [{}] }, false],
        ["nothing pending (null)", { _activeQuery: null, _queryQueue: [], _sentQueryQueue: [] }, true],
        ["nothing pending (undefined after the queue drained)", { _activeQuery: undefined, _queryQueue: [], _sentQueryQueue: [] }, true],
    ])("should report the connection idle=%# when it has %s", (_label, state, idle) => {
        expect(isConnectionIdle(state)).toBe(idle);
    });

    it.each([
        ["no _activeQuery field", { _queryQueue: [{}], _sentQueryQueue: [] }],
        ["a non-array _queryQueue", { _activeQuery: {}, _queryQueue: "x", _sentQueryQueue: [] }],
        ["no _sentQueryQueue field", { _activeQuery: {}, _queryQueue: [] }],
        ["not an object", undefined],
    ])("should keep the connection (pre-fix behaviour) when its shape is unrecognised: %s", (_label, state) => {
        expect(isConnectionIdle(state)).toBe(true);
    });

    it("should be the pool validate of every createKnex pool", async () => {
        const knex = createKnex({
            url: "postgres://care:care@127.0.0.1:1/care_unit",
            poolMax: 1,
            statementTimeoutMs: 2000,
            applicationName: "care-api-probe",
        });
        try {
            const config = (knex.client as { config: { pool: { validate: unknown } } }).config;
            expect(config.pool.validate).toBe(isConnectionIdle);
        } finally {
            await knex.destroy();
        }
    });
});
