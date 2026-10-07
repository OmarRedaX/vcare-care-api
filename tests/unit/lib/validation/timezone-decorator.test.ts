import "reflect-metadata";
import { IsIanaTimezone, canonicalIanaTimezone } from "../../../../src/lib/validation/timezone-decorator";
import { validateBody } from "../../../../src/lib/validation/validate";

class ZoneBody { @IsIanaTimezone() timezone!: string; }

describe("IsIanaTimezone", () => {
    it.each(["Africa/Cairo", "UTC"])("should accept %s when the zone is valid", async (timezone) => {
        expect((await validateBody(ZoneBody, { timezone })).timezone).toBe(timezone);
    });
    it.each(["Foo/Bar", "", "x".repeat(65), 5, null])("should reject %p when the zone is invalid", async (timezone) => {
        await expect(validateBody(ZoneBody, { timezone })).rejects.toMatchObject({ code: "ValidationFailed" });
    });
    it.each(["africa/cairo", "AFRICA/CAIRO"])("should canonicalize %s to Africa/Cairo", (timezone) => {
        expect(canonicalIanaTimezone(timezone)).toBe("Africa/Cairo");
    });
});
