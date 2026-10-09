import "reflect-metadata";
import { IsCalendarDate } from "../../../../src/lib/validation/date-decorator";
import { validateBody } from "../../../../src/lib/validation/validate";

class DateBody { @IsCalendarDate() date!: string; }

describe("IsCalendarDate", () => {
    it.each(["2027-02-28", "2028-02-29", "2027-12-31"])("should accept %s when it is a real calendar date", async (date) => {
        expect((await validateBody(DateBody, { date })).date).toBe(date);
    });

    it.each(["0000-01-01", "0000-12-31", "2027-02-30", "2027-13-01", "27-01-01", "2027-1-1", "2027-02-29", "2027-01-01T00:00:00Z", "", " 2027-01-01"])(
        "should reject %p when it is not a real YYYY-MM-DD date", async (date) => {
            await expect(validateBody(DateBody, { date })).rejects.toMatchObject({
                code: "ValidationFailed", details: [{ field: "date", issue: "must be a valid calendar date" }],
            });
        });

    it.each([20270101, null, undefined, true, {}, ["2027-01-01"]])("should reject the non-string %p", async (date) => {
        await expect(validateBody(DateBody, { date })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should not echo the rejected value in the error", async () => {
        const error = await validateBody(DateBody, { date: "2027-02-30" }).catch((caught: unknown) => caught);
        expect(JSON.stringify(error)).not.toContain("2027-02-30");
    });
});
