// Rules covered: AV-R4 (busy = every status the exclusion constraint holds: all but cancelled and no_show).
import knex from "knex";
import { listBusyIntervalsQuery } from "../../../../src/app/consultations/repository/busy-intervals.repo";

const dry = knex({ client: "pg" });
afterAll(async () => { await dry.destroy(); });

describe("busy interval statement", () => {
    it("should hold booked, waiting, in_progress and completed busy and release only cancelled and no_show when listing busy rows", () => {
        const { sql, bindings } = listBusyIntervalsQuery([7], 1_000_000, 2_000_000, dry).toSQL();
        expect(sql).toContain('"status" in (?, ?, ?, ?)');
        expect(bindings).toEqual(expect.arrayContaining(["booked", "waiting", "in_progress", "completed"]));
        expect(bindings).not.toContain("cancelled");
        expect(bindings).not.toContain("no_show");
        expect(sql).toContain('"deleted_at" is null');
    });
});
