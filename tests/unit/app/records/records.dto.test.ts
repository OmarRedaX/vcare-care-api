import "reflect-metadata";
import { MedicalRecordCreateDto, MedicalRecordPatchDto, TimelineQueryDto } from "../../../../src/app/records/dto/records.request.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";
import { CHIEF, DX_TEXT, NOTES, PLAN, REASON } from "./records.fixtures";

async function fields(run: () => Promise<unknown>): Promise<string[]> {
    try { await run(); } catch (error) { return (error as AppError).details.map((detail) => detail.field); }
    throw new Error("expected validation to fail");
}
const create = (body: unknown) => validateBody(MedicalRecordCreateDto, body);
const patch = (body: unknown) => validateBody(MedicalRecordPatchDto, body);
/** Three code points but six UTF-16 units: proves the length is counted in code points. */
const EMOJI3 = "\u{1F600}\u{1F600}\u{1F600}";

describe("MedicalRecordCreateDto", () => {
    it("should accept the minimal body and map it to the service input without the members that were not sent", async () => {
        const dto = await create({ chiefComplaint: CHIEF });
        expect(dto.toInput()).toEqual({ chiefComplaint: CHIEF });
        expect(Object.keys(dto.toInput())).toEqual(["chiefComplaint"]);
    });

    it("should accept every member and carry them all to the service input", async () => {
        const body = { chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisText: DX_TEXT, diagnosisCode: "A00.1", treatmentPlan: PLAN, followUpInDays: 14 };
        expect((await create(body)).toInput()).toEqual(body);
    });

    it("should require chiefComplaint", async () => {
        expect(await fields(() => create({}))).toEqual(["chiefComplaint"]);
        expect(await fields(() => create({ examinationNotes: NOTES }))).toEqual(["chiefComplaint"]);
    });

    it.each([
        ["two code points", "ab", false], ["three code points", "abc", true], ["three emoji (six UTF-16 units)", EMOJI3, true], ["two emoji", "\u{1F600}\u{1F600}", false],
        ["2000 code points", "a".repeat(2000), true], ["2001 code points", "a".repeat(2001), false], ["2000 emoji", "\u{1F600}".repeat(2000), true],
        ["whitespace only", "     ", false], ["empty", "", false], ["a NUL character", "abc\u0000def", false], ["newlines inside", "line one\nline two", true],
        ["a number", 123, false], ["null", null, false],
    ])("should judge chiefComplaint with %s", async (_label, value, ok) => {
        const run = () => create({ chiefComplaint: value });
        if (ok) await expect(run()).resolves.toBeDefined(); else expect(await fields(run)).toEqual(["chiefComplaint"]);
    });

    it.each([
        ["examinationNotes", 10_000, 10_001], ["diagnosisText", 2000, 2001], ["treatmentPlan", 10_000, 10_001],
    ])("should bound %s between one and its maximum code points and reject blank, NUL and null", async (name, max, over) => {
        await expect(create({ chiefComplaint: CHIEF, [name]: "x" })).resolves.toBeDefined();
        await expect(create({ chiefComplaint: CHIEF, [name]: "x".repeat(max) })).resolves.toBeDefined();
        await expect(create({ chiefComplaint: CHIEF, [name]: "line one\nline two" })).resolves.toBeDefined();
        for (const bad of ["x".repeat(over), "", "   ", "a\u0000b", null, 5]) expect(await fields(() => create({ chiefComplaint: CHIEF, [name]: bad }))).toEqual([name]);
    });

    it.each(["A00", "A00.1", "J45.9", "Z99.89", "A00.12AB", "B12.ZZZZ"])("should accept diagnosisCode %s", async (code) => {
        await expect(create({ chiefComplaint: CHIEF, diagnosisCode: code })).resolves.toBeDefined();
    });

    it.each(["a00", "A0", "A001", "A00.", "A00.12345", "AA0.1", "1A0", "A00.1a", " A00", "A00 ", "A00\n", "", "A00,1", "A00.1.2"])("should reject diagnosisCode %j", async (code) => {
        expect(await fields(() => create({ chiefComplaint: CHIEF, diagnosisCode: code }))).toEqual(["diagnosisCode"]);
    });

    it.each([[0, false], [1, true], [365, true], [366, false], [-1, false], [1.5, false], ["7", false], [null, false], [true, false]])(
        "should treat followUpInDays %j as valid=%s", async (value, ok) => {
            const run = () => create({ chiefComplaint: CHIEF, followUpInDays: value });
            if (ok) await expect(run()).resolves.toBeDefined(); else expect(await fields(run)).toEqual(["followUpInDays"]);
        });

    it.each(["patientUserId", "doctorUserId", "consultationId", "id", "lockedAt", "attachments", "reason", "amendments"])("should reject the unknown member %s as not allowed", async (name) => {
        const err = await create({ chiefComplaint: CHIEF, [name]: 1 }).then(() => undefined, (error: AppError) => error);
        expect(err?.code).toBe("ValidationFailed");
        expect(err?.details).toEqual([{ field: name, issue: "is not allowed" }]);
    });

    it.each([[null], [[]], ["text"], [5]])("should reject a body that is not a JSON object (%j)", async (body) => {
        expect(await fields(() => create(body))).toEqual(["body"]);
    });

    it("should never echo a rejected value in the error", async () => {
        const err = await create({ chiefComplaint: `${CHIEF}\u0000`, diagnosisCode: PLAN }).then(() => undefined, (error: AppError) => error);
        expect(JSON.stringify(err?.details)).not.toContain("SYNTHETIC");
    });
});

describe("MedicalRecordPatchDto", () => {
    it("should accept any single record member and report that it holds a record field", async () => {
        for (const body of [{ chiefComplaint: CHIEF }, { examinationNotes: NOTES }, { diagnosisText: DX_TEXT }, { diagnosisCode: "A00" }, { treatmentPlan: PLAN }, { followUpInDays: 3 }]) {
            const dto = await patch(body);
            expect(dto.hasRecordField()).toBe(true);
            expect(dto.toInput()).toEqual({ changes: body });
        }
    });

    it("should map the changes and the reason apart", async () => {
        const dto = await patch({ treatmentPlan: PLAN, reason: REASON });
        expect(dto.toInput()).toEqual({ changes: { treatmentPlan: PLAN }, reason: REASON });
    });

    it.each([[{}], [{ reason: REASON }]])("should validate %j yet report no record field (the controller rejects it)", async (body) => {
        const dto = await patch(body);
        expect(dto.hasRecordField()).toBe(false);
        expect(dto.toInput().changes).toEqual({});
    });

    it.each([
        ["two code points", "ab", false], ["three code points", "abc", true], ["1000 code points", "a".repeat(1000), true], ["1001 code points", "a".repeat(1001), false],
        ["three emoji", EMOJI3, true], ["whitespace only", "   ", false], ["a NUL character", "ab\u0000c", false], ["null", null, false], ["empty", "", false],
    ])("should judge a reason with %s", async (_label, value, ok) => {
        const run = () => patch({ followUpInDays: 3, reason: value });
        if (ok) await expect(run()).resolves.toBeDefined(); else expect(await fields(run)).toEqual(["reason"]);
    });

    it("should keep chiefComplaint optional but bounded 3..2000 on a patch", async () => {
        await expect(patch({ chiefComplaint: "abc" })).resolves.toBeDefined();
        expect(await fields(() => patch({ chiefComplaint: "ab" }))).toEqual(["chiefComplaint"]);
        expect(await fields(() => patch({ chiefComplaint: "a".repeat(2001) }))).toEqual(["chiefComplaint"]);
        expect(await fields(() => patch({ chiefComplaint: "   " }))).toEqual(["chiefComplaint"]);
    });

    it.each(["examinationNotes", "diagnosisText", "diagnosisCode", "treatmentPlan", "followUpInDays", "chiefComplaint"])(
        "should reject JSON null for %s so a field can never be cleared", async (name) => {
            expect(await fields(() => patch({ [name]: null, reason: REASON }))).toEqual([name]);
        });

    it.each(["patientUserId", "doctorUserId", "consultationId", "id", "lockedAt", "isLocked", "createdAt", "deletedAt", "amendments"])(
        "should reject the unknown member %s", async (name) => {
            expect(await fields(() => patch({ treatmentPlan: PLAN, [name]: 1 }))).toEqual([name]);
        });

    it("should apply the same code and range rules to diagnosisCode and followUpInDays as on create", async () => {
        expect(await fields(() => patch({ diagnosisCode: "a00" }))).toEqual(["diagnosisCode"]);
        expect(await fields(() => patch({ followUpInDays: 0 }))).toEqual(["followUpInDays"]);
        expect(await fields(() => patch({ followUpInDays: 366 }))).toEqual(["followUpInDays"]);
        await expect(patch({ followUpInDays: 365, diagnosisCode: "J45.9" })).resolves.toBeDefined();
    });
});

describe("TimelineQueryDto", () => {
    it("should default to no cursor and the default page size", async () => {
        const dto = await validateQuery(TimelineQueryDto, {});
        expect(dto.toQuery()).toEqual({ cursor: undefined, limit: 20 });
    });

    it("should convert a numeric string limit and pass the cursor through untouched", async () => {
        expect((await validateQuery(TimelineQueryDto, { limit: "5", cursor: "abc" })).toQuery()).toEqual({ cursor: "abc", limit: 5 });
    });

    it.each([["0"], ["101"], ["-1"], ["abc"], ["1.5"], [""]])("should reject limit %j", async (limit) => {
        expect(await fields(() => validateQuery(TimelineQueryDto, { limit }))).toEqual(["limit"]);
    });

    it("should accept the bounds 1 and 100", async () => {
        await expect(validateQuery(TimelineQueryDto, { limit: "1" })).resolves.toBeDefined();
        await expect(validateQuery(TimelineQueryDto, { limit: "100" })).resolves.toBeDefined();
    });

    it("should reject an oversized cursor and any unknown member", async () => {
        expect(await fields(() => validateQuery(TimelineQueryDto, { cursor: "a".repeat(1025) }))).toEqual(["cursor"]);
        expect(await fields(() => validateQuery(TimelineQueryDto, { sort: "asc" }))).toEqual(["sort"]);
        expect(await fields(() => validateQuery(TimelineQueryDto, { patientUserId: "5" }))).toEqual(["patientUserId"]);
    });
});
