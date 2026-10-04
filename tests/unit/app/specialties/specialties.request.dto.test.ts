import "reflect-metadata";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";
import {
    CreateSpecialtyDto,
    ListSpecialtiesQueryDto,
    UpdateSpecialtyDto,
} from "../../../../src/app/specialties/dto/specialties.request.dto";

async function failure(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
    } catch (error) {
        return error as AppError;
    }
    throw new Error("expected ValidationFailed");
}

const validCreate = { name: "Synthetic Specialty", slug: "synthetic-specialty" };

describe("specialties request DTOs", () => {
    describe("ListSpecialtiesQueryDto", () => {
        it("should default includeInactive to false and limit to 20 when absent", async () => {
            const query = await validateQuery(ListSpecialtiesQueryDto, {});
            expect(query.includeInactive).toBe(false);
            expect(query.limit).toBe(20);
        });

        it("should declare Boolean design metadata so the compiled-build condition of #8 is exercised", () => {
            expect(Reflect.getMetadata("design:type", ListSpecialtiesQueryDto.prototype, "includeInactive")).toBe(Boolean);
        });

        it.each([
            ["true", true],
            ["false", false],
        ])("should map includeInactive %p to %p", async (raw, expected) => {
            const query = await validateQuery(ListSpecialtiesQueryDto, { includeInactive: raw });
            expect(query.includeInactive).toBe(expected);
        });

        it.each([["yes"], ["1"], ["TRUE"], [""], [["true", "false"]]])(
            "should reject includeInactive %p",
            async (raw) => {
                const error = await failure(validateQuery(ListSpecialtiesQueryDto, { includeInactive: raw }));
                expect(error.code).toBe("ValidationFailed");
                expect(error.details.map((d) => d.field)).toContain("includeInactive");
            },
        );

        it.each([["0"], ["101"], ["1.5"], ["1e1"], ["05"], [" 5"], ["abc"]])("should reject limit %p", async (raw) => {
            const error = await failure(validateQuery(ListSpecialtiesQueryDto, { limit: raw }));
            expect(error.details.map((d) => d.field)).toContain("limit");
        });

        it("should reject an unknown query member", async () => {
            const error = await failure(validateQuery(ListSpecialtiesQueryDto, { sort: "name" }));
            expect(error.details).toEqual([{ field: "sort", issue: "is not allowed" }]);
        });

        it("should reject a cursor longer than 512 characters", async () => {
            const error = await failure(validateQuery(ListSpecialtiesQueryDto, { cursor: "a".repeat(513) }));
            expect(error.details.map((d) => d.field)).toContain("cursor");
        });
    });

    describe("CreateSpecialtyDto", () => {
        it("should accept a valid body and default description to null in toInput", async () => {
            const dto = await validateBody(CreateSpecialtyDto, validCreate);
            expect(dto.toInput()).toEqual({ name: "Synthetic Specialty", slug: "synthetic-specialty", description: null });
        });

        it("should keep a provided description and never trim or transform values", async () => {
            const dto = await validateBody(CreateSpecialtyDto, { name: "  Ab ", slug: "a1", description: "  text " });
            expect(dto.toInput()).toEqual({ name: "  Ab ", slug: "a1", description: "  text " });
        });

        it.each([
            ["name of 1 character", { ...validCreate, name: "A" }, "name"],
            ["name of 101 characters", { ...validCreate, name: "A".repeat(101) }, "name"],
            ["missing name", { slug: "x" }, "name"],
            ["slug with underscore and capital", { ...validCreate, slug: "Bad_Slug" }, "slug"],
            ["slug starting with a dash", { ...validCreate, slug: "-a" }, "slug"],
            ["slug with a double dash", { ...validCreate, slug: "a--b" }, "slug"],
            ["slug ending with a dash", { ...validCreate, slug: "a-" }, "slug"],
            ["slug of 101 characters", { ...validCreate, slug: "a".repeat(101) }, "slug"],
            ["description of 2001 characters", { ...validCreate, description: "d".repeat(2001) }, "description"],
            ["null description", { ...validCreate, description: null }, "description"],
            ["numeric name", { ...validCreate, name: 5 }, "name"],
            ["isActive member", { ...validCreate, isActive: true }, "isActive"],
            ["id member", { ...validCreate, id: 5 }, "id"],
        ])("should reject %s", async (_label, body, field) => {
            const error = await failure(validateBody(CreateSpecialtyDto, body));
            expect(error.code).toBe("ValidationFailed");
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it("should accept boundary lengths (name 2 and 100, slug 100, description 2000)", async () => {
            await expect(
                validateBody(CreateSpecialtyDto, { name: "Ab", slug: "a".repeat(100), description: "d".repeat(2000) }),
            ).resolves.toBeDefined();
            await expect(validateBody(CreateSpecialtyDto, { name: "A".repeat(100), slug: "a" })).resolves.toBeDefined();
        });

        it("should reject a non-object body", async () => {
            const error = await failure(validateBody(CreateSpecialtyDto, [1]));
            expect(error.details).toEqual([{ field: "body", issue: "must be a JSON object" }]);
        });
    });

    describe("UpdateSpecialtyDto", () => {
        it("should report isEmpty for {} and keep toChanges empty", async () => {
            const dto = await validateBody(UpdateSpecialtyDto, {});
            expect(dto.isEmpty()).toBe(true);
            expect(dto.toChanges()).toEqual({});
        });

        it("should report isEmpty for a body whose members are undefined", () => {
            const dto = new UpdateSpecialtyDto();
            dto.name = undefined;
            dto.slug = undefined;
            expect(dto.isEmpty()).toBe(true);
        });

        it.each([
            ["null name", { name: null }, "name"],
            ["null slug", { slug: null }, "slug"],
            ["null isActive", { isActive: null }, "isActive"],
            ['string "false" isActive', { isActive: "false" }, "isActive"],
            ["createdAt member", { createdAt: "2026-01-01T00:00:00Z" }, "createdAt"],
            ["bad slug", { slug: "Bad Slug" }, "slug"],
            ["1 char name", { name: "x" }, "name"],
            ["numeric description", { description: 4 }, "description"],
        ])("should reject %s", async (_label, body, field) => {
            const error = await failure(validateBody(UpdateSpecialtyDto, body));
            expect(error.details.map((d) => d.field)).toContain(field);
        });

        it("should accept description null and keep it in toChanges", async () => {
            const dto = await validateBody(UpdateSpecialtyDto, { description: null });
            expect(dto.isEmpty()).toBe(false);
            expect(dto.toChanges()).toEqual({ description: null });
        });

        it("should omit absent members from toChanges and keep isActive false", async () => {
            const dto = await validateBody(UpdateSpecialtyDto, { isActive: false, name: "New Name" });
            expect(dto.toChanges()).toEqual({ name: "New Name", isActive: false });
        });
    });
});
