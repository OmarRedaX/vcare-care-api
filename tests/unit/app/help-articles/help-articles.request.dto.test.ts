import "reflect-metadata";
import { CreateHelpArticleDto, ListHelpArticlesQueryDto, UpdateHelpArticleDto } from "../../../../src/app/help-articles/dto/help-articles.request.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";

async function failure(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
    } catch (error) {
        return error as AppError;
    }
    throw new Error("expected ValidationFailed");
}

const validCreate = {
    title: "Synthetic Article 001",
    body: "# Synthetic heading\n\nSYNTHETIC-HELP-BODY-7731",
    category: "how-it-works",
    audience: "patient",
    isPublished: true,
};

describe("help-articles request DTOs", () => {
    describe("ListHelpArticlesQueryDto", () => {
        it("should declare Boolean design metadata so the compiled-build condition of #8 is exercised", () => {
            expect(Reflect.getMetadata("design:type", ListHelpArticlesQueryDto.prototype, "isPublished")).toBe(Boolean);
        });

        it("should default limit to 20 and leave the filters undefined when the query is empty", async () => {
            const query = await validateQuery(ListHelpArticlesQueryDto, {});
            expect(query.limit).toBe(20);
            expect(query.category).toBeUndefined();
            expect(query.audience).toBeUndefined();
            expect(query.isPublished).toBeUndefined();
        });

        it("should accept category, audience and isPublished true when all are valid", async () => {
            const query = await validateQuery(ListHelpArticlesQueryDto, { category: "platform-rules", audience: "doctor", isPublished: "true" });
            expect(query).toMatchObject({ category: "platform-rules", audience: "doctor", isPublished: true });
        });

        it("should map isPublished false to the boolean false when given the string false", async () => {
            const query = await validateQuery(ListHelpArticlesQueryDto, { isPublished: "false" });
            expect(query.isPublished).toBe(false);
        });

        it.each([["yes"], ["1"], ["TRUE"], [""], [["true", "false"]]])("should reject isPublished %p", async (raw) => {
            const error = await failure(validateQuery(ListHelpArticlesQueryDto, { isPublished: raw }));
            expect(error.code).toBe("ValidationFailed");
            expect(error.details.map((d) => d.field)).toContain("isPublished");
        });

        it.each([
            ["category", "other"],
            ["audience", "admin"],
            ["category", "HOW-IT-WORKS"],
        ])("should reject %s %p when it is outside the enum", async (field, raw) => {
            const error = await failure(validateQuery(ListHelpArticlesQueryDto, { [field]: raw }));
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it.each([["0"], ["101"], ["1.5"], ["1e1"], ["05"], [" 5"], ["abc"]])("should reject limit %p", async (raw) => {
            const error = await failure(validateQuery(ListHelpArticlesQueryDto, { limit: raw }));
            expect(error.details.map((d) => d.field)).toContain("limit");
        });

        it("should reject an unknown query member and a cursor longer than 1024 characters", async () => {
            const unknown = await failure(validateQuery(ListHelpArticlesQueryDto, { sort: "title" }));
            expect(unknown.details).toEqual([{ field: "sort", issue: "is not allowed" }]);
            const cursor = await failure(validateQuery(ListHelpArticlesQueryDto, { cursor: "a".repeat(1025) }));
            expect(cursor.details.map((d) => d.field)).toContain("cursor");
        });
    });

    describe("CreateHelpArticleDto (HA-R2)", () => {
        it("should accept a valid body and map it through toInput", async () => {
            const dto = await validateBody(CreateHelpArticleDto, validCreate);
            expect(dto.toInput()).toEqual(validCreate);
        });

        it("should accept a body with newlines, tabs and astral characters and keep it verbatim (HA-R1)", async () => {
            const body = "line1\n\tline2\r\n😀 <script>alert(1)</script>   ";
            const dto = await validateBody(CreateHelpArticleDto, { ...validCreate, body });
            expect(dto.toInput().body).toBe(body);
        });

        it("should not trim or fold a title that has surrounding spaces", async () => {
            const dto = await validateBody(CreateHelpArticleDto, { ...validCreate, title: "  x" });
            expect(dto.toInput().title).toBe("  x");
        });

        it("should accept the boundary lengths counted in code points", async () => {
            await expect(validateBody(CreateHelpArticleDto, { ...validCreate, title: "abc", body: "x" })).resolves.toBeDefined();
            await expect(validateBody(CreateHelpArticleDto, { ...validCreate, title: "😀".repeat(200), body: "😀".repeat(50_000) })).resolves.toBeDefined();
            await expect(validateBody(CreateHelpArticleDto, { ...validCreate, title: "a️".repeat(100) })).resolves.toBeDefined();
        });

        it.each([
            ["a title of 2 code points", { title: "ab" }, "title"],
            ["a title of 201 code points", { title: "a".repeat(201) }, "title"],
            ["a title with a newline", { title: "abc\ndef" }, "title"],
            ["a title with a tab", { title: "abc\tdef" }, "title"],
            ["a title with NUL", { title: "abc\u0000def" }, "title"],
            ["a title with a C1 control character", { title: "abc\u0085def" }, "title"],
            ["a numeric title", { title: 12345 }, "title"],
            ["an empty body", { body: "" }, "body"],
            ["a body of 50001 code points", { body: "a".repeat(50_001) }, "body"],
            ["a body with NUL", { body: "abc\u0000def" }, "body"],
            ["a category outside the enum", { category: "other" }, "category"],
            ["an audience outside the enum", { audience: "admin" }, "audience"],
            ["isPublished as a string", { isPublished: "true" }, "isPublished"],
            ["isPublished as a number", { isPublished: 1 }, "isPublished"],
            ["an id member", { id: 5 }, "id"],
            ["a publishedAt member", { publishedAt: "2026-01-01T00:00:00Z" }, "publishedAt"],
            ["a createdAt member", { createdAt: "2026-01-01T00:00:00Z" }, "createdAt"],
            ["a createdBy member", { createdBy: 303 }, "createdBy"],
        ])("should reject %s", async (_label, override, field) => {
            const error = await failure(validateBody(CreateHelpArticleDto, { ...validCreate, ...override }));
            expect(error.code).toBe("ValidationFailed");
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it.each([["title"], ["body"], ["category"], ["audience"], ["isPublished"]])("should reject a body missing %s", async (field) => {
            const body: Record<string, unknown> = { ...validCreate };
            delete body[field];
            const error = await failure(validateBody(CreateHelpArticleDto, body));
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it("should reject a non-object body", async () => {
            const error = await failure(validateBody(CreateHelpArticleDto, [1]));
            expect(error.details).toEqual([{ field: "body", issue: "must be a JSON object" }]);
        });

        it("should never echo a rejected value in the error details", async () => {
            const error = await failure(validateBody(CreateHelpArticleDto, { ...validCreate, title: "SYNTHETIC-REJECTED-TITLE\n" }));
            expect(JSON.stringify(error.details)).not.toContain("SYNTHETIC-REJECTED-TITLE");
        });
    });

    describe("UpdateHelpArticleDto (HA-R11)", () => {
        it("should report isEmpty and an empty toChanges for {}", async () => {
            const dto = await validateBody(UpdateHelpArticleDto, {});
            expect(dto.isEmpty()).toBe(true);
            expect(dto.toChanges()).toEqual({});
        });

        it("should report isEmpty for an object whose members are all undefined", () => {
            const dto = new UpdateHelpArticleDto();
            dto.title = undefined;
            dto.body = undefined;
            dto.isPublished = undefined;
            expect(dto.isEmpty()).toBe(true);
        });

        it.each([
            ["title"],
            ["body"],
            ["category"],
            ["audience"],
            ["isPublished"],
        ])("should reject a null %s", async (field) => {
            const error = await failure(validateBody(UpdateHelpArticleDto, { [field]: null }));
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it.each([
            ["a 2-code-point title", { title: "ab" }, "title"],
            ["a title with a newline", { title: "abc\ndef" }, "title"],
            ["an empty body", { body: "" }, "body"],
            ["a body with NUL", { body: "a\u0000b" }, "body"],
            ["a 50001-code-point body", { body: "a".repeat(50_001) }, "body"],
            ["a category outside the enum", { category: "nope" }, "category"],
            ["an audience outside the enum", { audience: "admin" }, "audience"],
            ["a string isPublished", { isPublished: "true" }, "isPublished"],
            ["a publishedAt member", { publishedAt: "2026-01-01T00:00:00Z" }, "publishedAt"],
            ["an id member", { id: 9 }, "id"],
        ])("should reject %s", async (_label, body, field) => {
            const error = await failure(validateBody(UpdateHelpArticleDto, body));
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it("should keep isPublished false and omit absent members from toChanges", async () => {
            const dto = await validateBody(UpdateHelpArticleDto, { isPublished: false, title: "Synthetic Renamed" });
            expect(dto.isEmpty()).toBe(false);
            expect(dto.toChanges()).toEqual({ title: "Synthetic Renamed", isPublished: false });
        });

        it("should keep a body that equals only whitespace because nothing is trimmed", async () => {
            const dto = await validateBody(UpdateHelpArticleDto, { body: "   " });
            expect(dto.toChanges()).toEqual({ body: "   " });
        });
    });
});
