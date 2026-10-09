import "reflect-metadata";
import { IsString } from "class-validator";
import { IsIsoDateTimeWithOffset } from "../../../../src/lib/validation/date-decorator";
import { validateBody } from "../../../../src/lib/validation/validate";

class InstantBody {
    @IsString() @IsIsoDateTimeWithOffset() from!: string;
}

describe("IsIsoDateTimeWithOffset", () => {
    it.each(["2026-04-15T12:00:00Z", "2026-04-15T14:00:00+02:00", "2026-04-15T12:00:00.123456-08:00"])(
        "should accept %s when it is an ISO-8601 date-time with an offset",
        async (from) => {
            expect((await validateBody(InstantBody, { from })).from).toBe(from);
        },
    );

    it.each(["2026-04-15", "2026-04-15T12:00:00", "2026-04-15T12:00:00+0100", "2026-04-15t12:00:00z", "2026-04-15 12:00:00Z", "2026-04-15T12:00:60Z", ""])(
        "should reject %p with the field name and the fixed message",
        async (from) => {
            await expect(validateBody(InstantBody, { from })).rejects.toMatchObject({
                code: "ValidationFailed",
                details: [{ field: "from", issue: "must be an ISO-8601 date-time with a UTC offset" }],
            });
        },
    );

    it.each([1776254400000, null, undefined, true, {}, ["2026-04-15T12:00:00Z"]])("should reject the non-string %p", async (from) => {
        await expect(validateBody(InstantBody, { from })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should not echo the rejected value in the error", async () => {
        const error = await validateBody(InstantBody, { from: "2026-02-30T00:00:00Z" }).catch((caught: unknown) => caught);
        expect(JSON.stringify(error)).not.toContain("2026-02-30");
    });
});
