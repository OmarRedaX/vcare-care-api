import { closeDb } from "../helpers/db";
import { db } from "../../src/lib/knex/knex";

jest.setTimeout(30_000);

describe("pg type parsers (real Postgres)", () => {
    afterAll(async () => { await closeDb(); });

    it("should return array_agg of bigint ids as numbers, not strings (#17)", async () => {
        const result = await db.raw<{ rows: Array<{ ids: unknown; single: unknown; empty: unknown }> }>(
            "SELECT array_agg(g::bigint ORDER BY g) AS ids, max(g::bigint) AS single, ARRAY[]::bigint[] AS empty FROM generate_series(1, 3) AS g",
        );
        expect(result.rows[0]).toEqual({ ids: [1, 2, 3], single: 3, empty: [] });
    });
});
