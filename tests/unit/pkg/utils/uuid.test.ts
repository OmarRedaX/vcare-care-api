import { isUuid } from "../../../../src/pkg/utils/uuid";

describe("pkg/utils/uuid", () => {
    it.each(["00000000-0000-1000-8000-000000000000", "00000000-0000-7000-8000-000000000000", "ABCDEF00-0000-4000-8000-000000000000"])(
        "should accept %p when it is a UUID of any version or case",
        (value) => {
            expect(isUuid(value)).toBe(true);
        },
    );

    it.each(["", "0000000-0000-1000-8000-000000000000", "00000000-0000-1000-8000-00000000000g", " 00000000-0000-1000-8000-000000000000"])(
        "should reject %p when it is not exactly a UUID",
        (value) => {
            expect(isUuid(value)).toBe(false);
        },
    );
});
