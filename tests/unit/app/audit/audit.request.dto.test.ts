import "reflect-metadata";
import { ListAuditLogsQueryDto } from "../../../../src/app/audit/dto/audit.request.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateQuery } from "../../../../src/lib/validation/validate";

async function failure(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
    } catch (error) {
        return error as AppError;
    }
    throw new Error("expected ValidationFailed");
}

const fieldsOf = (error: AppError): string[] => error.details.map((detail) => detail.field);

describe("ListAuditLogsQueryDto", () => {
    it("should accept an empty query and default the limit to 20", async () => {
        const query = await validateQuery(ListAuditLogsQueryDto, {});
        expect(query.limit).toBe(20);
        expect(query.actorUserId).toBeUndefined();
    });

    it("should accept every filter together and parse the integers", async () => {
        const query = await validateQuery(ListAuditLogsQueryDto, {
            actorUserId: "303", action: "doctor.approved", entityType: "doctor_profile", entityId: "21",
            from: "2026-04-01T00:00:00Z", to: "2026-04-15T12:00:00+02:00", limit: "50", cursor: "opaque.value",
        });
        expect(query).toMatchObject({ actorUserId: 303, action: "doctor.approved", entityType: "doctor_profile", entityId: 21, limit: 50, cursor: "opaque.value" });
        expect(query.from).toBe("2026-04-01T00:00:00Z");
        expect(query.to).toBe("2026-04-15T12:00:00+02:00");
    });

    it.each(["foo", "requestId", "metadata.x", "metadata", "offset", "page", "q"])("should reject the unknown key %s with is not allowed", async (key) => {
        const error = await failure(validateQuery(ListAuditLogsQueryDto, { [key]: "1" }));
        expect(error.code).toBe("ValidationFailed");
        expect(error.details).toEqual([{ field: key, issue: "is not allowed" }]);
    });

    it.each(["from", "to"])("should return a detail naming %s and no echoed value when it is not an ISO date-time with an offset", async (field) => {
        const error = await failure(validateQuery(ListAuditLogsQueryDto, { [field]: "2026-04-15T12:00:00" }));
        expect(error.details).toEqual([{ field, issue: "must be an ISO-8601 date-time with a UTC offset" }]);
        expect(JSON.stringify(error)).not.toContain("2026-04-15");
    });

    it.each(["2026-04-15", "2026-04-15T12:00:00 02:00", "2026-04-15T12:00:00+0200", "1776254400"])("should reject the date %p", async (value) => {
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { from: value })))).toEqual(["from"]);
    });

    it("should reject a from or to longer than 40 characters", async () => {
        const long = `2026-04-15T12:00:00.${"1".repeat(30)}Z`;
        expect(long.length).toBeGreaterThan(40);
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { from: long })))).toContain("from");
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { to: long })))).toContain("to");
    });

    it.each([["0"], ["101"], ["-1"], ["1.5"], ["abc"], ["1e1"], ["05"], [" 5"], [""]])("should reject limit %p", async (raw) => {
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { limit: raw })))).toContain("limit");
    });

    it.each([["1", 1], ["100", 100]])("should accept limit %p", async (raw, expected) => {
        expect((await validateQuery(ListAuditLogsQueryDto, { limit: raw })).limit).toBe(expected);
    });

    it.each([["0"], ["-1"], ["007"], ["1e3"], ["1.5"], ["+1"], [" 1"], ["abc"], ["9007199254740992"], [""]])("should reject actorUserId %p", async (raw) => {
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { actorUserId: raw })))).toEqual(["actorUserId"]);
    });

    it("should accept the largest safe actorUserId", async () => {
        expect((await validateQuery(ListAuditLogsQueryDto, { actorUserId: "9007199254740991" })).actorUserId).toBe(Number.MAX_SAFE_INTEGER);
    });

    it.each([["0"], ["-1"], ["007"], ["1e3"], ["abc"]])("should reject entityId %p", async (raw) => {
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { entityId: raw, entityType: "consultation" })))).toEqual(["entityId"]);
    });

    it.each(["action", "entityType"])("should reject an empty, 65-character or NUL-containing %s and accept 64 characters", async (field) => {
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { [field]: "" })))).toEqual([field]);
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { [field]: "a".repeat(65) })))).toEqual([field]);
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { [field]: "a\u0000b" })))).toEqual([field]);
        const ok = await validateQuery(ListAuditLogsQueryDto, { [field]: "a".repeat(64) });
        expect((ok as unknown as Record<string, string>)[field]).toHaveLength(64);
    });

    it.each([["action"], ["entityType"], ["actorUserId"], ["entityId"], ["from"], ["to"], ["limit"], ["cursor"]])(
        "should reject a duplicated %s (parsed as an array)",
        async (field) => {
            expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { [field]: ["1", "2"] })))).toContain(field);
        },
    );

    it("should reject a cursor over 1024 characters", async () => {
        expect(fieldsOf(await failure(validateQuery(ListAuditLogsQueryDto, { cursor: "a".repeat(1025) })))).toEqual(["cursor"]);
        await expect(validateQuery(ListAuditLogsQueryDto, { cursor: "a".repeat(1024) })).resolves.toBeDefined();
    });

    it("should treat percent and quote characters in action as plain strings", async () => {
        const query = await validateQuery(ListAuditLogsQueryDto, { action: "a%_'b" });
        expect(query.action).toBe("a%_'b");
    });

    it("should return details sorted by field", async () => {
        const error = await failure(validateQuery(ListAuditLogsQueryDto, { to: "x", from: "y", limit: "0" }));
        expect(fieldsOf(error)).toEqual(["from", "limit", "to"]);
    });
});
