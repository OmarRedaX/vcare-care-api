import "reflect-metadata";
import type { Knex } from "knex";
import { Specialty } from "../../../../src/app/specialties/entity/specialties.entity";
import { ListSpecialtiesQueryDto } from "../../../../src/app/specialties/dto/specialties.request.dto";
import { SpecialtyNameTaken, SpecialtySlugTaken } from "../../../../src/app/specialties/errors";
import type * as RepoModule from "../../../../src/app/specialties/repository/specialties.repo";
import { SpecialtiesService } from "../../../../src/app/specialties/service/specialties.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import { AppError } from "../../../../src/lib/error/AppError";
import { NotFound } from "../../../../src/lib/error/errors";
import { decodeCursor, encodeCursor } from "../../../../src/lib/http/pagination/cursor";
import type { AuthContext } from "../../../../src/lib/types/types";

// The repository is this unit's collaborator: its exported functions are replaced on the real module object, which the
// service reads at call time (jest.mock hoisting is not applied by this ts-jest setup).
const repo = jest.requireActual<typeof RepoModule>("../../../../src/app/specialties/repository/specialties.repo");
const repoMock = {
    findSpecialtiesByIds: jest.spyOn(repo, "findSpecialtiesByIds"),
    listSpecialties: jest.spyOn(repo, "listSpecialties"),
    findSpecialtyByIdForUpdate: jest.spyOn(repo, "findSpecialtyByIdForUpdate"),
    insertSpecialty: jest.spyOn(repo, "insertSpecialty"),
    updateSpecialty: jest.spyOn(repo, "updateSpecialty"),
};

const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const doctor: AuthContext = { userId: 202, role: "doctor", status: "pending", emailVerified: true };

const row = (overrides: Partial<Specialty> = {}): Specialty =>
    new Specialty({
        id: 5,
        name: "Synthetic One",
        slug: "synthetic-one",
        description: "text",
        isActive: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    });

function setup() {
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (t: Knex.Transaction) => Promise<unknown>) => callback(trx));
    const db = { transaction } as unknown as Knex;
    const record = jest.fn(() => Promise.resolve());
    const audit = { record } as unknown as AuditRecorder;
    return { service: new SpecialtiesService(db, audit), db, trx, transaction, record };
}

const query = (init: Partial<ListSpecialtiesQueryDto> = {}): ListSpecialtiesQueryDto =>
    Object.assign(new ListSpecialtiesQueryDto(), init);

const pgError = (code: string, constraint?: string): Error => Object.assign(new Error("pg"), { code, constraint });

describe("SpecialtiesService", () => {
    describe("findByIds", () => {
        it("should return existing rows including inactive specialties", async () => {
            const { service, db } = setup();
            const rows = [row({ id: 1 }), row({ id: 2, isActive: false })];
            repoMock.findSpecialtiesByIds.mockResolvedValue(rows);
            expect(await service.findByIds([1, 2], db)).toEqual(rows);
            expect(repoMock.findSpecialtiesByIds).toHaveBeenCalledWith([1, 2], db);
        });

        it("should return no rows when ids are unknown", async () => {
            const { service } = setup();
            repoMock.findSpecialtiesByIds.mockResolvedValue([]);
            expect(await service.findByIds([999])).toEqual([]);
        });
    });
    describe("list", () => {
        it.each([
            ["admin", admin, true],
            ["patient", patient, false],
            ["doctor", doctor, false],
        ])("should honour includeInactive only for admins when the caller is %s (S-R6)", async (_label, viewer, expected) => {
            const { service, db } = setup();
            repoMock.listSpecialties.mockResolvedValue([]);
            await service.list(viewer, query({ includeInactive: true }));
            expect(repoMock.listSpecialties).toHaveBeenCalledWith({ includeInactive: expected, after: null, fetch: 21 }, db);
        });

        it("should not include inactive rows for an admin when includeInactive is false", async () => {
            const { service } = setup();
            repoMock.listSpecialties.mockResolvedValue([]);
            await service.list(admin, query({ includeInactive: false }));
            expect(repoMock.listSpecialties.mock.calls[0]?.[0].includeInactive).toBe(false);
        });

        it("should fetch limit + 1 and build the cursor from (name, id) (S-R8)", async () => {
            const { service } = setup();
            const rows = [row({ id: 1, name: "A1" }), row({ id: 2, name: "A2" }), row({ id: 3, name: "A3" })];
            repoMock.listSpecialties.mockResolvedValue(rows);
            const page = await service.list(patient, query({ limit: 2 }));
            expect(repoMock.listSpecialties.mock.calls[0]?.[0].fetch).toBe(3);
            expect(page.items.map((s) => s.id)).toEqual([1, 2]);
            expect(page.meta).toMatchObject({ hasMore: true, count: 2 });
            expect(decodeCursor(page.meta.nextCursor ?? "")).toEqual({ sortValue: "A2", id: 2 });
        });

        it("should report hasMore false and a null cursor when the page is the last", async () => {
            const { service } = setup();
            repoMock.listSpecialties.mockResolvedValue([row()]);
            const page = await service.list(patient, query({ limit: 2 }));
            expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
        });

        it("should pass the decoded cursor position to the repository", async () => {
            const { service } = setup();
            repoMock.listSpecialties.mockResolvedValue([]);
            await service.list(patient, query({ cursor: encodeCursor("Cardio", 9) }));
            expect(repoMock.listSpecialties.mock.calls[0]?.[0].after).toEqual({ sortValue: "Cardio", id: 9 });
        });

        it.each([
            ["a numeric sortValue", encodeCursor(5, 1)],
            ["a sortValue longer than 100 characters", encodeCursor("x".repeat(101), 1)],
            ["garbage", "!!!not-a-cursor"],
        ])("should throw ValidationFailed for a cursor with %s", async (_label, cursor) => {
            const { service } = setup();
            await expect(service.list(patient, query({ cursor }))).rejects.toMatchObject({
                code: "ValidationFailed",
                status: 400,
                details: [{ field: "cursor", issue: "is invalid" }],
            });
            expect(repoMock.listSpecialties).not.toHaveBeenCalled();
        });
    });

    describe("create", () => {
        const input = { name: "Synthetic One", slug: "synthetic-one", description: null };

        it("should insert then audit inside one transaction with action specialty.created and empty metadata (S-R9)", async () => {
            const { service, trx, transaction, record } = setup();
            repoMock.insertSpecialty.mockResolvedValue(row({ id: 77 }));
            const created = await service.create(admin, input);
            expect(created.id).toBe(77);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(repoMock.insertSpecialty).toHaveBeenCalledWith(input, trx);
            expect(record).toHaveBeenCalledWith(trx, {
                actor: { kind: "user", userId: 303, role: "admin" },
                action: "specialty.created",
                entityType: "specialty",
                entityId: 77,
                metadata: {},
            });
        });

        it.each([
            ["uq_specialties_name", SpecialtyNameTaken],
            ["uq_specialties_slug", SpecialtySlugTaken],
        ])("should map 23505 on %s to the module Conflict (S-R1)", async (constraint, expected) => {
            const { service } = setup();
            repoMock.insertSpecialty.mockRejectedValue(pgError("23505", constraint));
            await expect(service.create(admin, input)).rejects.toBe(expected);
        });

        it("should rethrow a 23505 on another constraint unchanged", async () => {
            const { service } = setup();
            const error = pgError("23505", "uq_other");
            repoMock.insertSpecialty.mockRejectedValue(error);
            await expect(service.create(admin, input)).rejects.toBe(error);
        });

        it("should rethrow a non-pg error and an AppError unchanged", async () => {
            const { service } = setup();
            const plain = new Error("boom");
            repoMock.insertSpecialty.mockRejectedValueOnce(plain);
            await expect(service.create(admin, input)).rejects.toBe(plain);
            const app = new AppError("Forbidden", 403, "x");
            repoMock.insertSpecialty.mockRejectedValueOnce(app);
            await expect(service.create(admin, input)).rejects.toBe(app);
        });

        it("should reject (so Knex rolls back) when the audit throws (S-R10)", async () => {
            const { service, record } = setup();
            repoMock.insertSpecialty.mockResolvedValue(row());
            const failure = new Error("audit down");
            record.mockRejectedValue(failure);
            await expect(service.create(admin, input)).rejects.toBe(failure);
        });
    });

    describe("update", () => {
        it("should throw NotFound and write nothing when the row is absent", async () => {
            const { service, record } = setup();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(undefined);
            await expect(service.update(admin, 9, { name: "X1" })).rejects.toBe(NotFound);
            expect(repoMock.updateSpecialty).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
        });

        it("should return the current row with no update and no audit when nothing changed (S-R11)", async () => {
            const { service, record } = setup();
            const current = row();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(current);
            const result = await service.update(admin, 5, {
                name: current.name,
                slug: current.slug,
                description: current.description,
                isActive: current.isActive,
            });
            expect(result).toBe(current);
            expect(repoMock.updateSpecialty).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
        });

        it("should audit only the changed names, sorted, when some values are equal (S-R11)", async () => {
            const { service, trx, record } = setup();
            const current = row();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(current);
            repoMock.updateSpecialty.mockResolvedValue(row({ name: "Renamed", isActive: false }));
            await service.update(admin, 5, { name: "Renamed", slug: current.slug, isActive: false });
            expect(repoMock.updateSpecialty).toHaveBeenCalledWith(5, { name: "Renamed", is_active: false }, trx);
            expect(record).toHaveBeenCalledWith(trx, {
                actor: { kind: "user", userId: 303, role: "admin" },
                action: "specialty.updated",
                entityType: "specialty",
                entityId: 5,
                metadata: { changedFields: "isActive,name" },
            });
        });

        it("should sort a three-field change alphabetically and never put values in metadata", async () => {
            const { service, record } = setup();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(row());
            repoMock.updateSpecialty.mockResolvedValue(row());
            await service.update(admin, 5, { slug: "new-slug", description: null, isActive: false });
            expect(record.mock.calls[0]).toBeDefined();
            const entry = (record.mock.calls as unknown as Array<[unknown, { metadata: Record<string, unknown> }]>)[0]?.[1];
            expect(entry?.metadata).toEqual({ changedFields: "description,isActive,slug" });
        });

        it("should treat description null vs null as unchanged and null vs text as changed", async () => {
            const { service, record } = setup();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(row({ description: null }));
            await service.update(admin, 5, { description: null });
            expect(repoMock.updateSpecialty).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();

            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(row({ description: "text" }));
            repoMock.updateSpecialty.mockResolvedValue(row({ description: null }));
            await service.update(admin, 5, { description: null });
            expect(repoMock.updateSpecialty.mock.calls[0]?.[1]).toEqual({ description: null });
            expect(record).toHaveBeenCalledTimes(1);
        });

        it.each([
            ["uq_specialties_name", SpecialtyNameTaken],
            ["uq_specialties_slug", SpecialtySlugTaken],
        ])("should map 23505 on %s like create and write no audit row", async (constraint, expected) => {
            const { service, record } = setup();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(row());
            repoMock.updateSpecialty.mockRejectedValue(pgError("23505", constraint));
            await expect(service.update(admin, 5, { name: "Other" })).rejects.toBe(expected);
            expect(record).not.toHaveBeenCalled();
        });

        it("should reject when the audit throws so the update rolls back (S-R10)", async () => {
            const { service, record } = setup();
            repoMock.findSpecialtyByIdForUpdate.mockResolvedValue(row());
            repoMock.updateSpecialty.mockResolvedValue(row());
            const failure = new Error("audit down");
            record.mockRejectedValue(failure);
            await expect(service.update(admin, 5, { name: "Other" })).rejects.toBe(failure);
        });
    });
});
