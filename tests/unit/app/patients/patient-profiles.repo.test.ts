import { BloodType, Gender } from "../../../../src/app/patients/enums";
import type { Knex } from "knex";
import { findProfileByUserId, findProfileByUserIdForUpdate, insertProfile, updateProfile } from "../../../../src/app/patients/repository/patient-profiles.repo";
import type { PatientProfileRow } from "../../../../src/app/patients/types";

const row: PatientProfileRow = { id: 7, user_id: 101, date_of_birth: "1990-05-17", gender: Gender.Female, blood_type: BloodType.OPositive,
    allergies: ["TEST-ALLERGEN-A"], chronic_conditions: [], timezone: "Africa/Cairo",
    created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-02T00:00:00Z") };

/** A recording query-builder double: every chained call is logged and the chain resolves to `rows`. */
function fakeConn(rows: PatientProfileRow[]) {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "where", "whereNull", "forUpdate", "limit", "insert", "update", "returning"]) {
        builder[name] = (...args: unknown[]) => { calls.push([name, args]); return builder; };
    }
    builder.then = (resolve: (value: unknown) => unknown) => resolve(rows);
    const conn = Object.assign(jest.fn(() => builder), {
        raw: (sql: string) => ({ raw: sql }),
        fn: { now: () => "NOW()" },
    });
    return { conn: conn as unknown as Knex.Transaction, calls, table: conn };
}
const names = (calls: Array<[string, unknown[]]>): string[] => calls.map(([name]) => name);

describe("patient-profiles repository", () => {
    it("should map a row to an entity with a text date of birth and no deleted_at", async () => {
        const { conn } = fakeConn([row]);
        const entity = await findProfileByUserId(101, conn);
        expect(entity).toMatchObject({ id: 7, userId: 101, dateOfBirth: "1990-05-17", gender: "female", bloodType: "O+",
            allergies: ["TEST-ALLERGEN-A"], chronicConditions: [], timezone: "Africa/Cairo", createdAt: row.created_at, updatedAt: row.updated_at });
        expect(entity).not.toHaveProperty("deletedAt");
        expect(entity).not.toHaveProperty("deleted_at");
    });

    it("should return undefined when no row matches", async () => {
        expect(await findProfileByUserId(101, fakeConn([]).conn)).toBeUndefined();
        expect(await findProfileByUserIdForUpdate(101, fakeConn([]).conn)).toBeUndefined();
    });

    it("should filter by user id and deleted_at on every read and lock only in the ForUpdate variant", async () => {
        const plain = fakeConn([row]);
        await findProfileByUserId(101, plain.conn);
        expect(plain.calls.find(([name]) => name === "where")?.[1]).toEqual(["user_id", 101]);
        expect(plain.calls.find(([name]) => name === "whereNull")?.[1]).toEqual(["deleted_at"]);
        expect(names(plain.calls)).not.toContain("forUpdate");
        const locked = fakeConn([row]);
        await findProfileByUserIdForUpdate(101, locked.conn);
        expect(names(locked.calls)).toEqual(expect.arrayContaining(["whereNull", "forUpdate"]));
    });

    it("should select explicit columns and format the date in SQL", async () => {
        const { conn, calls } = fakeConn([row]);
        await findProfileByUserId(101, conn);
        const columns = calls.find(([name]) => name === "select")?.[1][0] as Array<string | { raw: string }>;
        expect(columns).not.toContain("*");
        expect(columns.map((column) => (typeof column === "string" ? column : column.raw))).toEqual([
            "id", "user_id", "to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth", "gender", "blood_type",
            "allergies", "chronic_conditions", "timezone", "created_at", "updated_at"]);
    });

    it("should insert snake_case columns for the caller and return the mapped row", async () => {
        const { conn, calls } = fakeConn([row]);
        const entity = await insertProfile(101, { dateOfBirth: null, gender: null, bloodType: null, allergies: ["a"], chronicConditions: [], timezone: "UTC" }, conn);
        expect(calls.find(([name]) => name === "insert")?.[1][0]).toEqual({ user_id: 101, date_of_birth: null, gender: null, blood_type: null,
            allergies: ["a"], chronic_conditions: [], timezone: "UTC" });
        expect(entity.id).toBe(7);
    });

    it("should fail loudly when insert or update returns no row", async () => {
        await expect(insertProfile(101, { dateOfBirth: null, gender: null, bloodType: null, allergies: [], chronicConditions: [], timezone: "UTC" }, fakeConn([]).conn)).rejects.toThrow("patient_profile_insert_returned_no_row");
        await expect(updateProfile(7, { gender: Gender.Male }, fakeConn([]).conn)).rejects.toThrow("patient_profile_update_returned_no_row");
    });

    it("should update by live id with only the changed columns and a fresh updated_at", async () => {
        const { conn, calls } = fakeConn([row]);
        await updateProfile(7, { gender: Gender.Male }, conn);
        expect(calls.find(([name]) => name === "where")?.[1]).toEqual(["id", 7]);
        expect(calls.find(([name]) => name === "whereNull")?.[1]).toEqual(["deleted_at"]);
        expect(calls.find(([name]) => name === "update")?.[1][0]).toEqual({ gender: Gender.Male, updated_at: "NOW()" });
    });
});
