import "reflect-metadata";
import type { Knex } from "knex";
import { ListHelpArticlesQueryDto } from "../../../../src/app/help-articles/dto/help-articles.request.dto";
import { HelpArticle, HelpArticleSummary } from "../../../../src/app/help-articles/entity/help-articles.entity";
import { HelpArticleAudience, HelpArticleCategory } from "../../../../src/app/help-articles/enums";
import { HelpArticleTitleTaken } from "../../../../src/app/help-articles/errors";
import type * as RepoModule from "../../../../src/app/help-articles/repository/help-articles.repo";
import { HelpArticlesService } from "../../../../src/app/help-articles/service/help-articles.service";
import type { HelpArticleListEntry } from "../../../../src/app/help-articles/types";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import { AppError } from "../../../../src/lib/error/AppError";
import { NotFound } from "../../../../src/lib/error/errors";
import { decodeCursor, encodeCursor } from "../../../../src/lib/http/pagination/cursor";
import type { AuthContext } from "../../../../src/lib/types/types";

// The repository is this unit's collaborator: its exported functions are replaced on the real module object, which the
// service reads at call time (jest.mock hoisting is not applied by this ts-jest setup).
const repo = jest.requireActual<typeof RepoModule>("../../../../src/app/help-articles/repository/help-articles.repo");
const repoMock = {
    listHelpArticles: jest.spyOn(repo, "listHelpArticles"),
    findVisibleHelpArticle: jest.spyOn(repo, "findVisibleHelpArticle"),
    findLiveHelpArticleForUpdate: jest.spyOn(repo, "findLiveHelpArticleForUpdate"),
    insertHelpArticle: jest.spyOn(repo, "insertHelpArticle"),
    updateHelpArticle: jest.spyOn(repo, "updateHelpArticle"),
    softDeleteHelpArticle: jest.spyOn(repo, "softDeleteHelpArticle"),
};

const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const doctor: AuthContext = { userId: 202, role: "doctor", status: "pending", emailVerified: true };

const TS = "2026-10-29T10:00:00.123456Z";

const article = (overrides: Partial<HelpArticle> = {}): HelpArticle =>
    new HelpArticle({
        id: 5,
        title: "Synthetic Article 001",
        body: "SYNTHETIC-HELP-BODY-7731",
        category: HelpArticleCategory.HowItWorks,
        audience: HelpArticleAudience.Patient,
        isPublished: false,
        publishedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    });

const entry = (id: number): HelpArticleListEntry => ({
    summary: new HelpArticleSummary({
        id,
        title: `Synthetic Article ${id}`,
        category: HelpArticleCategory.HowItWorks,
        audience: HelpArticleAudience.Patient,
        isPublished: true,
        publishedAt: new Date(TS),
        updatedAt: new Date(TS),
    }),
    sortCursor: `2026-10-29T10:00:00.${String(id).padStart(6, "0")}Z`,
});

function setup() {
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (t: Knex.Transaction) => Promise<unknown>) => callback(trx));
    const db = { transaction } as unknown as Knex;
    const record = jest.fn(() => Promise.resolve());
    const audit = { record } as unknown as AuditRecorder;
    return { service: new HelpArticlesService(db, audit), db, trx, transaction, record };
}

const query = (init: Partial<ListHelpArticlesQueryDto> = {}): ListHelpArticlesQueryDto => Object.assign(new ListHelpArticlesQueryDto(), init);
const pgError = (code: string, constraint?: string): Error => Object.assign(new Error("pg"), { code, constraint });
const auditEntry = (record: jest.Mock): { metadata: Record<string, unknown>; [key: string]: unknown } =>
    (record.mock.calls as unknown as Array<[unknown, { metadata: Record<string, unknown> }]>)[0]?.[1] as never;

const input = { title: "Synthetic Article 001", body: "SYNTHETIC-HELP-BODY-7731", category: HelpArticleCategory.HowItWorks, audience: HelpArticleAudience.Patient, isPublished: true };

describe("HelpArticlesService", () => {
    describe("list", () => {
        it.each([
            ["a patient", patient, HelpArticleAudience.Patient, HelpArticleAudience.Doctor],
            ["a doctor", doctor, HelpArticleAudience.Doctor, HelpArticleAudience.Patient],
        ])("should use the reader scope of the own audience and ignore audience and isPublished when the caller is %s (HA-R5, HA-R7)", async (_label, viewer, audience, otherAudience) => {
            const { service, db } = setup();
            repoMock.listHelpArticles.mockResolvedValue([]);
            await service.list(viewer, query({ audience: otherAudience, isPublished: false, category: HelpArticleCategory.PlatformRules }));
            expect(repoMock.listHelpArticles).toHaveBeenCalledWith(
                { scope: { kind: "reader", audience, category: "platform-rules" }, after: null, fetch: 21 },
                db,
            );
        });

        it("should use the admin scope with the admin's filters when the caller is an admin (HA-R6)", async () => {
            const { service, db } = setup();
            repoMock.listHelpArticles.mockResolvedValue([]);
            await service.list(admin, query({ audience: HelpArticleAudience.Doctor, isPublished: false, category: HelpArticleCategory.CancellationPolicy, limit: 5 }));
            expect(repoMock.listHelpArticles).toHaveBeenCalledWith(
                { scope: { kind: "admin", audience: "doctor", category: "cancellation-policy", isPublished: false }, after: null, fetch: 6 },
                db,
            );
        });

        it("should fetch limit + 1 and build a published-kind cursor from the last item for a reader (HA-R17)", async () => {
            const { service } = setup();
            repoMock.listHelpArticles.mockResolvedValue([entry(3), entry(2), entry(1)]);
            const page = await service.list(patient, query({ limit: 2 }));
            expect(repoMock.listHelpArticles.mock.calls[0]?.[0].fetch).toBe(3);
            expect(page.items.map((item) => item.id)).toEqual([3, 2]);
            expect(page.meta).toMatchObject({ hasMore: true, count: 2 });
            expect(decodeCursor(page.meta.nextCursor ?? "")).toEqual({ sortValue: "published:2026-10-29T10:00:00.000002Z", id: 2 });
        });

        it("should build an updated-kind cursor for an admin (HA-R17)", async () => {
            const { service } = setup();
            repoMock.listHelpArticles.mockResolvedValue([entry(3), entry(2), entry(1)]);
            const page = await service.list(admin, query({ limit: 2 }));
            expect(decodeCursor(page.meta.nextCursor ?? "")).toEqual({ sortValue: "updated:2026-10-29T10:00:00.000002Z", id: 2 });
        });

        it("should report hasMore false and a null cursor when the page is the last", async () => {
            const { service } = setup();
            repoMock.listHelpArticles.mockResolvedValue([entry(1)]);
            const page = await service.list(patient, query({ limit: 2 }));
            expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
        });

        it("should pass the bare timestamp of a published cursor to the repository for a reader", async () => {
            const { service } = setup();
            repoMock.listHelpArticles.mockResolvedValue([]);
            await service.list(patient, query({ cursor: encodeCursor(`published:${TS}`, 9) }));
            expect(repoMock.listHelpArticles.mock.calls[0]?.[0].after).toEqual({ sortValue: TS, id: 9 });
        });

        it("should pass the bare timestamp of an updated cursor to the repository for an admin", async () => {
            const { service } = setup();
            repoMock.listHelpArticles.mockResolvedValue([]);
            await service.list(admin, query({ cursor: encodeCursor(`updated:${TS}`, 4) }));
            expect(repoMock.listHelpArticles.mock.calls[0]?.[0].after).toEqual({ sortValue: TS, id: 4 });
        });

        it.each([
            ["an admin cursor given to a patient", patient, encodeCursor(`updated:${TS}`, 1)],
            ["a patient cursor given to an admin", admin, encodeCursor(`published:${TS}`, 1)],
            ["an admin cursor given to a doctor", doctor, encodeCursor(`updated:${TS}`, 1)],
            ["a cursor with no kind", patient, encodeCursor(TS, 1)],
            ["garbage", patient, "!!!not-a-cursor"],
        ])("should throw ValidationFailed on the cursor field for %s and not query (HA-R17)", async (_label, viewer, cursor) => {
            const { service } = setup();
            await expect(service.list(viewer, query({ cursor }))).rejects.toMatchObject({
                code: "ValidationFailed",
                status: 400,
                details: [{ field: "cursor", issue: "is invalid" }],
            });
            expect(repoMock.listHelpArticles).not.toHaveBeenCalled();
        });

        it("should write no audit row for a read (HA-R14)", async () => {
            const { service, record, transaction } = setup();
            repoMock.listHelpArticles.mockResolvedValue([entry(1)]);
            await service.list(patient, query());
            expect(record).not.toHaveBeenCalled();
            expect(transaction).not.toHaveBeenCalled();
        });
    });

    describe("get", () => {
        it.each([
            ["a patient", patient, { kind: "reader", audience: "patient" }],
            ["a doctor", doctor, { kind: "reader", audience: "doctor" }],
            ["an admin", admin, { kind: "admin" }],
        ])("should query the visibility of the role when the caller is %s (HA-R5, HA-R6)", async (_label, viewer, visibility) => {
            const { service, db } = setup();
            const found = article();
            repoMock.findVisibleHelpArticle.mockResolvedValue(found);
            expect(await service.get(viewer, 5)).toBe(found);
            expect(repoMock.findVisibleHelpArticle).toHaveBeenCalledWith(5, visibility, db);
        });

        it("should throw NotFound when the row is absent, deleted or not visible", async () => {
            const { service, record } = setup();
            repoMock.findVisibleHelpArticle.mockResolvedValue(undefined);
            await expect(service.get(patient, 5)).rejects.toBe(NotFound);
            expect(record).not.toHaveBeenCalled();
        });
    });

    describe("create", () => {
        it("should insert then audit inside one transaction with help_article.created and no title or body in metadata (HA-R12)", async () => {
            const { service, trx, transaction, record } = setup();
            repoMock.insertHelpArticle.mockResolvedValue(article({ id: 77, isPublished: true, publishedAt: new Date(TS) }));
            const created = await service.create(admin, input);
            expect(created.id).toBe(77);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(repoMock.insertHelpArticle).toHaveBeenCalledWith(input, 303, trx);
            expect(record).toHaveBeenCalledWith(trx, {
                actor: { kind: "user", userId: 303, role: "admin" },
                action: "help_article.created",
                entityType: "help_article",
                entityId: 77,
                metadata: { isPublishedBefore: null, isPublishedAfter: true },
            });
            expect(JSON.stringify(auditEntry(record))).not.toContain("SYNTHETIC-HELP-BODY-7731");
            expect(JSON.stringify(auditEntry(record))).not.toContain("Synthetic Article");
        });

        it("should record isPublishedAfter false for a draft", async () => {
            const { service, record } = setup();
            repoMock.insertHelpArticle.mockResolvedValue(article({ id: 78 }));
            await service.create(admin, { ...input, isPublished: false });
            expect(auditEntry(record).metadata).toEqual({ isPublishedBefore: null, isPublishedAfter: false });
        });

        it("should map 23505 on uq_help_articles_audience_title to HelpArticleTitleTaken (HA-R3)", async () => {
            const { service } = setup();
            repoMock.insertHelpArticle.mockRejectedValue(pgError("23505", "uq_help_articles_audience_title"));
            await expect(service.create(admin, input)).rejects.toBe(HelpArticleTitleTaken);
        });

        it("should expose Conflict with a title detail when the title is taken", () => {
            expect(HelpArticleTitleTaken).toMatchObject({
                code: "Conflict",
                status: 409,
                details: [{ field: "title", issue: "is already in use for this audience" }],
            });
        });

        it("should rethrow a 23505 on another constraint unchanged", async () => {
            const { service } = setup();
            const error = pgError("23505", "uq_other");
            repoMock.insertHelpArticle.mockRejectedValue(error);
            await expect(service.create(admin, input)).rejects.toBe(error);
        });

        it("should rethrow a non-pg error and an AppError unchanged", async () => {
            const { service } = setup();
            const plain = new Error("boom");
            repoMock.insertHelpArticle.mockRejectedValueOnce(plain);
            await expect(service.create(admin, input)).rejects.toBe(plain);
            const app = new AppError("Forbidden", 403, "x");
            repoMock.insertHelpArticle.mockRejectedValueOnce(app);
            await expect(service.create(admin, input)).rejects.toBe(app);
        });

        it("should reject so Knex rolls back when the audit throws (HA-R13)", async () => {
            const { service, record } = setup();
            repoMock.insertHelpArticle.mockResolvedValue(article());
            const failure = new Error("audit down");
            record.mockRejectedValue(failure);
            await expect(service.create(admin, input)).rejects.toBe(failure);
        });
    });

    describe("update", () => {
        it("should throw NotFound and write nothing when the row is absent or deleted (HA-R8)", async () => {
            const { service, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(undefined);
            await expect(service.update(admin, 9, { title: "Synthetic Renamed" })).rejects.toBe(NotFound);
            expect(repoMock.updateHelpArticle).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
        });

        it("should return the current row with no update and no audit when nothing changed (HA-R10)", async () => {
            const { service, record } = setup();
            const current = article({ isPublished: true, publishedAt: new Date(TS) });
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(current);
            const result = await service.update(admin, 5, {
                title: current.title,
                body: current.body,
                category: current.category,
                audience: current.audience,
                isPublished: true,
            });
            expect(result).toBe(current);
            expect(repoMock.updateHelpArticle).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
        });

        it("should audit only the changed names, sorted, with isPublishedBefore and After (HA-R10, HA-R12)", async () => {
            const { service, trx, record } = setup();
            const current = article();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(current);
            repoMock.updateHelpArticle.mockResolvedValue(article({ title: "Synthetic Renamed", isPublished: true, publishedAt: new Date(TS) }));
            await service.update(admin, 5, { title: "Synthetic Renamed", body: current.body, isPublished: true });
            expect(repoMock.updateHelpArticle).toHaveBeenCalledWith(5, { title: "Synthetic Renamed", is_published: true }, 303, trx);
            expect(record).toHaveBeenCalledWith(trx, {
                actor: { kind: "user", userId: 303, role: "admin" },
                action: "help_article.updated",
                entityType: "help_article",
                entityId: 5,
                metadata: { changedFields: "isPublished,title", isPublishedBefore: false, isPublishedAfter: true },
            });
        });

        it("should sort a five-field change alphabetically and never put values in the metadata", async () => {
            const { service, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article());
            repoMock.updateHelpArticle.mockResolvedValue(article());
            await service.update(admin, 5, {
                title: "Synthetic New Title",
                body: "SYNTHETIC-HELP-BODY-NEW",
                category: HelpArticleCategory.PlatformRules,
                audience: HelpArticleAudience.Doctor,
                isPublished: true,
            });
            const metadata = auditEntry(record).metadata;
            expect(metadata.changedFields).toBe("audience,body,category,isPublished,title");
            expect(JSON.stringify(metadata)).not.toContain("SYNTHETIC-HELP-BODY-NEW");
            expect(JSON.stringify(metadata)).not.toContain("Synthetic New Title");
        });

        it("should hand the repository the unpublish change without a publish stamp when isPublished goes true to false (HA-R4)", async () => {
            const { service, trx } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article({ isPublished: true, publishedAt: new Date(TS) }));
            repoMock.updateHelpArticle.mockResolvedValue(article());
            await service.update(admin, 5, { isPublished: false });
            expect(repoMock.updateHelpArticle).toHaveBeenCalledWith(5, { is_published: false }, 303, trx);
        });

        it("should hand the repository is_published true only when isPublished goes false to true so it can stamp published_at (HA-R4)", async () => {
            const { service, trx } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article({ isPublished: false, publishedAt: new Date(TS) }));
            repoMock.updateHelpArticle.mockResolvedValue(article({ isPublished: true, publishedAt: new Date(TS) }));
            await service.update(admin, 5, { isPublished: true });
            expect(repoMock.updateHelpArticle).toHaveBeenCalledWith(5, { is_published: true }, 303, trx);
        });

        it("should allow category and audience to change on a published article without touching isPublished (HA-R9)", async () => {
            const { service, trx, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article({ isPublished: true, publishedAt: new Date(TS) }));
            repoMock.updateHelpArticle.mockResolvedValue(article({ isPublished: true, category: HelpArticleCategory.PlatformRules, audience: HelpArticleAudience.Doctor }));
            await service.update(admin, 5, { category: HelpArticleCategory.PlatformRules, audience: HelpArticleAudience.Doctor, isPublished: true });
            expect(repoMock.updateHelpArticle).toHaveBeenCalledWith(5, { category: "platform-rules", audience: "doctor" }, 303, trx);
            expect(auditEntry(record).metadata).toEqual({ changedFields: "audience,category", isPublishedBefore: true, isPublishedAfter: true });
        });

        it("should not treat setting the own current title as a change so it can never 409 against itself (HA-R10)", async () => {
            const { service } = setup();
            const current = article();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(current);
            repoMock.updateHelpArticle.mockResolvedValue(current);
            await service.update(admin, 5, { title: current.title, body: "SYNTHETIC-HELP-BODY-CHANGED" });
            expect(repoMock.updateHelpArticle.mock.calls[0]?.[1]).toEqual({ body: "SYNTHETIC-HELP-BODY-CHANGED" });
        });

        it("should compare titles and bodies with exact equality so case or whitespace differences are changes", async () => {
            const { service } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article());
            repoMock.updateHelpArticle.mockResolvedValue(article());
            await service.update(admin, 5, { title: "synthetic article 001", body: "SYNTHETIC-HELP-BODY-7731 " });
            expect(repoMock.updateHelpArticle.mock.calls[0]?.[1]).toEqual({ title: "synthetic article 001", body: "SYNTHETIC-HELP-BODY-7731 " });
        });

        it("should map 23505 on the title constraint like create and write no audit row (HA-R3)", async () => {
            const { service, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article());
            repoMock.updateHelpArticle.mockRejectedValue(pgError("23505", "uq_help_articles_audience_title"));
            await expect(service.update(admin, 5, { title: "Synthetic Other" })).rejects.toBe(HelpArticleTitleTaken);
            expect(record).not.toHaveBeenCalled();
        });

        it("should rethrow a 23505 on another constraint unchanged", async () => {
            const { service } = setup();
            const error = pgError("23505", "uq_other");
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article());
            repoMock.updateHelpArticle.mockRejectedValue(error);
            await expect(service.update(admin, 5, { title: "Synthetic Other" })).rejects.toBe(error);
        });

        it("should reject so the update rolls back when the audit throws (HA-R13)", async () => {
            const { service, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article());
            repoMock.updateHelpArticle.mockResolvedValue(article());
            const failure = new Error("audit down");
            record.mockRejectedValue(failure);
            await expect(service.update(admin, 5, { title: "Synthetic Other" })).rejects.toBe(failure);
        });
    });

    describe("remove", () => {
        it("should throw NotFound for an absent or already deleted row and write nothing (HA-R8)", async () => {
            const { service, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(undefined);
            await expect(service.remove(admin, 5)).rejects.toBe(NotFound);
            expect(repoMock.softDeleteHelpArticle).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
        });

        it("should soft delete then audit help_article.deleted with isPublishedAfter null in one transaction (HA-R12)", async () => {
            const { service, trx, transaction, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article({ isPublished: true, publishedAt: new Date(TS) }));
            repoMock.softDeleteHelpArticle.mockResolvedValue(undefined);
            await service.remove(admin, 5);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(repoMock.softDeleteHelpArticle).toHaveBeenCalledWith(5, 303, trx);
            expect(record).toHaveBeenCalledWith(trx, {
                actor: { kind: "user", userId: 303, role: "admin" },
                action: "help_article.deleted",
                entityType: "help_article",
                entityId: 5,
                metadata: { isPublishedBefore: true, isPublishedAfter: null },
            });
        });

        it("should reject so the delete rolls back when the audit throws (HA-R13)", async () => {
            const { service, record } = setup();
            repoMock.findLiveHelpArticleForUpdate.mockResolvedValue(article());
            repoMock.softDeleteHelpArticle.mockResolvedValue(undefined);
            const failure = new Error("audit down");
            record.mockRejectedValue(failure);
            await expect(service.remove(admin, 5)).rejects.toBe(failure);
        });
    });
});
