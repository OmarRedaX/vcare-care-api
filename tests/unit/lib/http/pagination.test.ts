import { AppError } from "../../../../src/lib/error/AppError";
import { decodeCursor, encodeCursor } from "../../../../src/lib/http/pagination/cursor";
import { buildPage, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, resolveLimit } from "../../../../src/lib/http/pagination/page";
import { PaginationQueryDto } from "../../../../src/lib/http/pagination/pagination.request.dto";
import { validateQuery } from "../../../../src/lib/validation/validate";

function expectInvalidCursor(cursor: string): void {
    let thrown: unknown;
    try {
        decodeCursor(cursor);
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.code).toBe("ValidationFailed");
    expect(appError.status).toBe(400);
    expect(appError.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("lib/http/pagination cursor", () => {
    it.each([
        ["2026-01-01T00:00:00.000Z", 42],
        [1234.5, 1],
        ["", Number.MAX_SAFE_INTEGER],
    ] as const)("should round-trip sortValue %p and id %p when encoding then decoding", (sortValue, id) => {
        const cursor = encodeCursor(sortValue, id);
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeCursor(cursor)).toEqual({ sortValue, id });
    });

    it.each(["%%%not-base64%%%", b64("just a string").slice(0, 5), "", Buffer.from("{not json").toString("base64url")])(
        "should throw ValidationFailed with field cursor when the cursor is not base64url JSON (%p)",
        (cursor) => {
            expectInvalidCursor(cursor);
        },
    );

    it.each([
        ["an object", { sortValue: "a", id: 1 }],
        ["a 1-element array", ["a"]],
        ["a 3-element array", ["a", 1, 2]],
        ["a boolean sort value", [true, 1]],
        ["a null sort value", [null, 1]],
    ])("should throw ValidationFailed when the cursor holds %s", (_label, value) => {
        expectInvalidCursor(b64(value));
    });

    it.each([
        ["zero", 0],
        ["negative", -3],
        ["fractional", 1.5],
        ["unsafe", Number.MAX_SAFE_INTEGER + 2],
        ["a string", "7"],
    ])("should throw when the id is not a positive safe integer (%s)", (_label, id) => {
        expectInvalidCursor(b64(["a", id]));
    });
});

describe("lib/http/pagination buildPage", () => {
    const rows = (count: number) => Array.from({ length: count }, (_value, index) => ({ id: index + 1, at: `t${index + 1}` }));
    const position = (row: { id: number; at: string }): [string, number] => [row.at, row.id];

    it("should return hasMore false and nextCursor null when rows are at most limit", () => {
        expect(buildPage(rows(3), 3, position)).toEqual({
            items: rows(3),
            meta: { nextCursor: null, hasMore: false, count: 3 },
        });
        expect(buildPage([], 3, position).meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
    });

    it("should return limit items and a cursor of the last item when rows exceed limit", () => {
        const page = buildPage(rows(4), 3, position);
        expect(page.items).toEqual(rows(3));
        expect(page.meta.hasMore).toBe(true);
        expect(page.meta.count).toBe(3);
        expect(decodeCursor(page.meta.nextCursor ?? "")).toEqual({ sortValue: "t3", id: 3 });
    });

    it("should default limit to 20 when absent", () => {
        expect(resolveLimit(undefined)).toBe(20);
        expect(DEFAULT_PAGE_LIMIT).toBe(20);
        expect(MAX_PAGE_LIMIT).toBe(100);
        expect(resolveLimit(5)).toBe(5);
    });
});

describe("lib/http/pagination PaginationQueryDto", () => {
    it("should default limit to 20 and convert a numeric limit when validating a query", async () => {
        await expect(validateQuery(PaginationQueryDto, {})).resolves.toMatchObject({ limit: 20 });
        await expect(validateQuery(PaginationQueryDto, { limit: "50", cursor: "abc" })).resolves.toMatchObject({
            limit: 50,
            cursor: "abc",
        });
    });

    it.each(["0", "101", "1.5", "abc"])("should reject limit %p when it is outside 1..100 or not an integer", async (limit) => {
        await expect(validateQuery(PaginationQueryDto, { limit })).rejects.toMatchObject({
            code: "ValidationFailed",
            details: [expect.objectContaining({ field: "limit" })],
        });
    });

    it("should reject a cursor longer than 512 characters", async () => {
        await expect(validateQuery(PaginationQueryDto, { cursor: "a".repeat(513) })).rejects.toMatchObject({
            details: [expect.objectContaining({ field: "cursor" })],
        });
    });

    it("should reject an unknown filter when it is not whitelisted", async () => {
        await expect(validateQuery(PaginationQueryDto, { sort: "name" })).rejects.toMatchObject({
            details: [{ field: "sort", issue: "is not allowed" }],
        });
    });
});
