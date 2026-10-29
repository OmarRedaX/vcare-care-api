import { randomUUID } from "node:crypto";
import request from "supertest";
import { hashBody } from "../../src/lib/idempotency/idempotency";
import { inProgressRecord } from "../../src/lib/idempotency/idempotency-store";
import { redis } from "../../src/lib/redis/redis";
import { expectErrorEnvelope, expectSuccessEnvelope, inlineLists, schemaBlock } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import { expectObservedStatusesDeclared, BODY_MARKER, LIST, useHelpArticlesHarness, validCreate } from "../helpers/help-articles-harness";
import type { ArticleBody } from "../helpers/help-articles-harness";

jest.setTimeout(60_000);

const BLOCK_CONSTRAINT = "chk_test_block_help";

describe("help-articles writes (integration: real wiring, real Postgres as care_app, real Redis)", () => {
    const h = useHelpArticlesHarness();

    /** Asserts exactly the contract `HelpArticle` shape. */
    function expectArticle(value: unknown): ArticleBody {
        const [required = []] = inlineLists(schemaBlock("HelpArticle"), "required");
        const body = value as ArticleBody;
        expect(Object.keys(body).sort()).toEqual([...required].sort());
        expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
        expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
        expect(body.publishedAt === null || new Date(body.publishedAt).toISOString() === body.publishedAt).toBe(true);
        return body;
    }

    /** Makes the audit insert of one action fail (the write must roll back with it); always dropped in `finally`. */
    async function withBlockedAudit(action: string, run: () => Promise<void>): Promise<void> {
        await ownerDb.raw(`ALTER TABLE audit_logs ADD CONSTRAINT ${BLOCK_CONSTRAINT} CHECK (action <> '${action}')`);
        try {
            await run();
        } finally {
            await ownerDb.raw(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS ${BLOCK_CONSTRAINT}`);
        }
    }

    describe("POST /api/help-articles", () => {
        it("should answer 201 with the contract HelpArticle and write one row and one audit row (HA-R4, HA-R12)", async () => {
            const requestId = randomUUID();
            const res = await h.post(validCreate(), "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(201);
            expect(res.headers["x-request-id"]).toBe(requestId);
            const body = expectArticle(expectSuccessEnvelope(res.body));
            expect(body).toMatchObject({ title: "Synthetic Article 001", category: "how-it-works", audience: "patient", isPublished: true });
            expect(body.publishedAt).not.toBeNull();
            const rows = await h.dbRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ id: body.id, created_by: 303, updated_by: 303, deleted_at: null, is_published: true });
            expect(rows[0]?.published_at?.toISOString()).toBe(body.publishedAt);
            expect(await h.auditRows()).toEqual([
                {
                    actor_user_id: 303,
                    actor_role: "admin",
                    action: "help_article.created",
                    entity_type: "help_article",
                    entity_id: body.id,
                    request_id: requestId,
                    metadata: { isPublishedBefore: null, isPublishedAfter: true },
                },
            ]);
        });

        it("should answer 201 with publishedAt null for a draft and audit isPublishedAfter false (HA-R4)", async () => {
            const res = await h.post(validCreate({ isPublished: false }), "admin");
            expect(res.status).toBe(201);
            expect(expectArticle(res.body.data)).toMatchObject({ isPublished: false, publishedAt: null });
            expect((await h.dbRows())[0]?.published_at).toBeNull();
            expect((await h.auditRows())[0]?.metadata).toEqual({ isPublishedBefore: null, isPublishedAfter: false });
        });

        it("should store and return the body byte for byte, including HTML, newlines, tabs, astral characters and trailing spaces (HA-R1)", async () => {
            const body = "# Heading\r\n\ttab <script>alert(1)</script>\n😀 **bold**   \n\n";
            const res = await h.post(validCreate({ body }), "admin");
            expect(res.status).toBe(201);
            expect(res.body.data.body).toBe(body);
            expect((await h.dbRows())[0]?.body).toBe(body);
            const read = await h.get(`${LIST}/${res.body.data.id}`, "patient");
            expect(read.body.data.body).toBe(body);
        });

        it("should not trim or fold the title", async () => {
            const res = await h.post(validCreate({ title: "  Padded Title " }), "admin");
            expect(res.status).toBe(201);
            expect(res.body.data.title).toBe("  Padded Title ");
        });

        it("should accept a 50000-character body and refuse a 50000-astral-character body at the 100 kb parser limit (HA-D13)", async () => {
            const fits = await h.post(validCreate({ body: "a".repeat(50_000) }), "admin");
            expect(fits.status).toBe(201);
            expect(fits.body.data.body).toHaveLength(50_000);
            const tooLarge = await h.post(validCreate({ title: "Synthetic Article 002", body: "😀".repeat(50_000) }), "admin");
            expect(tooLarge.status).toBe(400);
            expectErrorEnvelope(tooLarge.body, "ValidationFailed");
            expect(tooLarge.body.error.details).toEqual([{ field: "body", issue: "must not exceed 100kb" }]);
            expect(await h.dbRows()).toHaveLength(1);
        });

        it("should answer 409 Conflict with a title detail for a duplicate title in the same audience and leave the audit count unchanged (HA-R3, HA-R13)", async () => {
            await h.seed([{ title: "Synthetic Article 001" }]);
            const res = await h.post(validCreate(), "admin");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "Conflict");
            expect(res.body.error.details).toEqual([{ field: "title", issue: "is already in use for this audience" }]);
            expect(await h.dbRows()).toHaveLength(1);
            expect(await h.auditRows()).toEqual([]);
        });

        it("should answer 409 for a duplicate against an unpublished draft too", async () => {
            await h.seed([{ title: "Synthetic Article 001", isPublished: false }]);
            expect((await h.post(validCreate(), "admin")).status).toBe(409);
        });

        it("should allow the same title in the other audience and treat case and trailing space as different titles (HA-D5)", async () => {
            await h.seed([{ title: "Synthetic Article 001" }]);
            expect((await h.post(validCreate({ audience: "doctor" }), "admin")).status).toBe(201);
            expect((await h.post(validCreate({ title: "synthetic article 001" }), "admin")).status).toBe(201);
            expect((await h.post(validCreate({ title: "Synthetic Article 001 " }), "admin")).status).toBe(201);
            expect(await h.dbRows()).toHaveLength(4);
            expect(await h.auditRows()).toHaveLength(3);
        });

        it.each([
            ["a 2-character title", { title: "ab" }],
            ["a 201-character title", { title: "a".repeat(201) }],
            ["a title with a newline", { title: "abc\ndef" }],
            ["a title with NUL", { title: "abc\u0000def" }],
            ["an empty body", { body: "" }],
            ["a 50001-character body", { body: "a".repeat(50_001) }],
            ["a body with NUL", { body: "abc\u0000def" }],
            ["a category outside the enum", { category: "other" }],
            ["an audience outside the enum", { audience: "admin" }],
            ["a string isPublished", { isPublished: "true" }],
            ["an id member", { id: 9 }],
            ["a publishedAt member", { publishedAt: "2026-01-01T00:00:00Z" }],
            ["a createdBy member", { createdBy: 303 }],
            ["an unknown member", { extra: 1 }],
        ])("should answer 400 ValidationFailed for %s and write nothing (HA-R2)", async (_label, override) => {
            const res = await h.post(validCreate(override), "admin");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await h.dbRows()).toEqual([]);
            expect(await h.auditRows()).toEqual([]);
        });

        it.each([["title"], ["body"], ["category"], ["audience"], ["isPublished"]])("should answer 400 when %s is missing", async (field) => {
            const payload = validCreate();
            delete payload[field];
            const res = await h.post(payload, "admin");
            expect(res.status).toBe(400);
            expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
            expect(await h.dbRows()).toEqual([]);
        });

        it("should never echo a rejected value in the error details", async () => {
            const res = await h.post(validCreate({ title: "SYNTHETIC-REJECTED-TITLE\n" }), "admin");
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body)).not.toContain("SYNTHETIC-REJECTED-TITLE");
        });

        it("should answer 400 for a non-object body and for malformed JSON", async () => {
            const array = await h.post([1], "admin");
            expect(array.status).toBe(400);
            expectErrorEnvelope(array.body, "ValidationFailed");
            const malformed = await request(h.app).post(LIST).set("Authorization", `Bearer ${h.tokens.admin}`).set("Content-Type", "application/json").send("{not json");
            expect(malformed.status).toBe(400);
            expectErrorEnvelope(malformed.body, "ValidationFailed");
            expect(await h.dbRows()).toEqual([]);
        });

        it("should accept a title of 200 astral characters and refuse one of 201", async () => {
            expect((await h.post(validCreate({ title: "😀".repeat(200) }), "admin")).status).toBe(201);
            expect((await h.post(validCreate({ title: "😀".repeat(201) }), "admin")).status).toBe(400);
        });

        describe("Idempotency-Key (HA-R19)", () => {
            it("should replay the original 201 for the same key and body with one row and one audit row", async () => {
                const key = randomUUID();
                const first = await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                const second = await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                expect(first.status).toBe(201);
                expect(second.status).toBe(201);
                expect(second.body).toEqual(first.body);
                expect(second.body.data.id).toBe(first.body.data.id);
                expect(await h.dbRows()).toHaveLength(1);
                expect(await h.auditRows()).toHaveLength(1);
            });

            it("should answer 422 IdempotencyConflict for the same key with a different body", async () => {
                const key = randomUUID();
                await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                const res = await h.post(validCreate({ title: "Synthetic Different" }), "admin", { "Idempotency-Key": key });
                expect(res.status).toBe(422);
                expectErrorEnvelope(res.body, "IdempotencyConflict");
                expect(await h.dbRows()).toHaveLength(1);
            });

            it("should answer 400 for an Idempotency-Key that is not a UUID", async () => {
                const res = await h.post(validCreate(), "admin", { "Idempotency-Key": "not-a-uuid" });
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect(res.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "must be a UUID" }]);
                expect(await h.dbRows()).toEqual([]);
            });

            it("should accept the request without a key and answer 201 then 409 for the same body twice", async () => {
                expect((await h.post(validCreate(), "admin")).status).toBe(201);
                const second = await h.post(validCreate(), "admin");
                expect(second.status).toBe(409);
                expectErrorEnvelope(second.body, "Conflict");
            });

            it("should answer 409 Conflict with Retry-After 1 when the first request with the key is still in flight", async () => {
                const key = randomUUID();
                const lock = inProgressRecord(hashBody(validCreate()));
                await redis.set(`idem:POST /api/help-articles:user:303:${key}`, lock, "PX", 30_000);
                const res = await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                expect(res.status).toBe(409);
                expectErrorEnvelope(res.body, "Conflict");
                expect(res.headers["retry-after"]).toBe("1");
                expect(await h.dbRows()).toEqual([]);
            });

            it("should scope a key to its principal so another admin with the same key is not replayed", async () => {
                const key = randomUUID();
                const first = await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                expect(first.status).toBe(201);
                const other = await h.post(validCreate(), "admin2", { "Idempotency-Key": key });
                expect(other.status).toBe(409); // not a replay: the title is taken
                expectErrorEnvelope(other.body, "Conflict");
            });

            it("should not let a patient reuse an admin key to read a replay", async () => {
                const key = randomUUID();
                await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                const res = await h.post(validCreate(), "patient", { "Idempotency-Key": key });
                expect(res.status).toBe(403);
            });
        });

        describe("concurrency and rollback", () => {
            it("should answer exactly one 201 and one 409 for two parallel creates of one audience and title (HA-R22)", async () => {
                const [a, b] = await Promise.all([
                    h.post(validCreate(), "admin", { "Idempotency-Key": randomUUID() }),
                    h.post(validCreate({ body: "SYNTHETIC-OTHER-BODY" }), "admin2", { "Idempotency-Key": randomUUID() }),
                ]);
                expect([a.status, b.status].sort()).toEqual([201, 409]);
                expect(await h.dbRows()).toHaveLength(1);
                expect(await h.auditRows()).toHaveLength(1);
            });

            it("should answer two 201 for two parallel creates of one title in different audiences", async () => {
                const [a, b] = await Promise.all([h.post(validCreate(), "admin"), h.post(validCreate({ audience: "doctor" }), "admin2")]);
                expect([a.status, b.status]).toEqual([201, 201]);
                expect(await h.dbRows()).toHaveLength(2);
            });

            it("should answer 500 InternalError and leave no row when the audit insert fails, and create normally afterwards (HA-R13)", async () => {
                await withBlockedAudit("help_article.created", async () => {
                    const res = await h.post(validCreate(), "admin");
                    expect(res.status).toBe(500);
                    expectErrorEnvelope(res.body, "InternalError");
                    expect(JSON.stringify(res.body)).not.toContain(BLOCK_CONSTRAINT);
                });
                expect(await h.dbRows()).toEqual([]);
                expect(await h.auditRows()).toEqual([]);
                expect((await h.post(validCreate(), "admin")).status).toBe(201);
                expect(await h.auditRows()).toHaveLength(1);
            });

            it("should not keep an idempotent replay of a failed 500 so the same key can succeed once the fault clears", async () => {
                const key = randomUUID();
                await withBlockedAudit("help_article.created", async () => {
                    expect((await h.post(validCreate(), "admin", { "Idempotency-Key": key })).status).toBe(500);
                });
                const retry = await h.post(validCreate(), "admin", { "Idempotency-Key": key });
                expect(retry.status).toBe(201);
                expect(await h.dbRows()).toHaveLength(1);
            });
        });
    });

    describe("PATCH /api/help-articles/{id}", () => {
        it("should change only the provided members and bump updated_at and updated_by (HA-R9)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", category: "how-it-works", updatedAt: "2026-01-01T00:00:00.000000Z" }]);
            const before = (await h.dbRows())[0];
            const res = await h.patch(id, { title: "Synthetic Renamed" }, "admin2");
            expect(res.status).toBe(200);
            const body = expectArticle(expectSuccessEnvelope(res.body));
            expect(body).toMatchObject({ id, title: "Synthetic Renamed", category: "how-it-works", audience: "patient", isPublished: true });
            expect(body.body).toBe(before?.body);
            const after = (await h.dbRows())[0];
            expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? 0);
            expect(after).toMatchObject({ created_by: 303, updated_by: 304, deleted_at: null });
            expect(after?.created_at.getTime()).toBe(before?.created_at.getTime());
            expect(after?.published_at?.getTime()).toBe(before?.published_at?.getTime());
        });

        it("should audit changedFields sorted and the publish state with no title or body text (HA-R12)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const requestId = randomUUID();
            const res = await h.patch(id, { title: "SYNTHETIC-NEW-TITLE", body: "SYNTHETIC-NEW-BODY" }, "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(200);
            const audit = await h.auditRows();
            expect(audit).toEqual([
                {
                    actor_user_id: 303,
                    actor_role: "admin",
                    action: "help_article.updated",
                    entity_type: "help_article",
                    entity_id: id,
                    request_id: requestId,
                    metadata: { changedFields: "body,title", isPublishedBefore: true, isPublishedAfter: true },
                },
            ]);
            const text = JSON.stringify(audit);
            for (const secret of ["SYNTHETIC-NEW-TITLE", "SYNTHETIC-NEW-BODY", BODY_MARKER, "Synthetic Article 001"]) expect(text).not.toContain(secret);
        });

        it("should set publishedAt on the first publish, keep it on unpublish and keep the original on re-publish (HA-R4, O2)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", isPublished: false }]);
            expect((await h.dbRows())[0]?.published_at).toBeNull();

            const published = await h.patch(id, { isPublished: true }, "admin");
            expect(published.status).toBe(200);
            const firstStamp = published.body.data.publishedAt as string;
            expect(firstStamp).not.toBeNull();
            expect(published.body.data.isPublished).toBe(true);

            await new Promise((resolve) => setTimeout(resolve, 20));
            const unpublished = await h.patch(id, { isPublished: false }, "admin");
            expect(unpublished.status).toBe(200);
            expect(unpublished.body.data).toMatchObject({ isPublished: false, publishedAt: firstStamp });
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(404);

            await new Promise((resolve) => setTimeout(resolve, 20));
            const republished = await h.patch(id, { isPublished: true }, "admin");
            expect(republished.status).toBe(200);
            expect(republished.body.data).toMatchObject({ isPublished: true, publishedAt: firstStamp });
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(200);

            expect((await h.auditRows()).map((row) => row.metadata)).toEqual([
                { changedFields: "isPublished", isPublishedBefore: false, isPublishedAfter: true },
                { changedFields: "isPublished", isPublishedBefore: true, isPublishedAfter: false },
                { changedFields: "isPublished", isPublishedBefore: false, isPublishedAfter: true },
            ]);
        });

        it("should keep the original publishedAt of a seeded article that was published earlier when it is re-published (O2)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", isPublished: false, publishedAt: "2026-02-02T02:02:02.000000Z" }]);
            const res = await h.patch(id, { isPublished: true }, "admin");
            expect(res.body.data.publishedAt).toBe("2026-02-02T02:02:02.000Z");
        });

        it("should change category and audience of a published article in one call without unpublishing (HA-R9)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", category: "how-it-works", audience: "patient" }]);
            const before = (await h.dbRows())[0];
            const res = await h.patch(id, { category: "platform-rules", audience: "doctor" }, "admin");
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ category: "platform-rules", audience: "doctor", isPublished: true });
            expect(res.body.data.publishedAt).toBe(before?.published_at?.toISOString());
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(404);
            expect((await h.get(`${LIST}/${id}`, "doctor")).status).toBe(200);
            expect((await h.auditRows())[0]?.metadata).toEqual({ changedFields: "audience,category", isPublishedBefore: true, isPublishedAfter: true });
        });

        it("should answer 409 and leave the row and the audit table unchanged when the new title belongs to another live article (HA-R3, HA-R13)", async () => {
            const [one = 0] = await h.seed([{ title: "Synthetic One" }, { title: "Synthetic Two" }]);
            const before = await h.dbRows();
            const res = await h.patch(one, { title: "Synthetic Two" }, "admin");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "Conflict");
            expect(res.body.error.details).toEqual([{ field: "title", issue: "is already in use for this audience" }]);
            expect(await h.dbRows()).toEqual(before);
            expect(await h.auditRows()).toEqual([]);
        });

        it("should answer 409 when an audience change makes the title clash in the new audience, and 200 when it does not", async () => {
            const [patientOne = 0] = await h.seed([{ title: "Synthetic Same", audience: "patient" }, { title: "Synthetic Same", audience: "doctor" }, { title: "Synthetic Free", audience: "patient" }]);
            const clash = await h.patch(patientOne, { audience: "doctor" }, "admin");
            expect(clash.status).toBe(409);
            expectErrorEnvelope(clash.body, "Conflict");
            expect(await h.auditRows()).toEqual([]);
            const free = await h.patch((await h.dbRows()).find((row) => row.title === "Synthetic Free")?.id ?? 0, { audience: "doctor" }, "admin");
            expect(free.status).toBe(200);
        });

        it("should not clash with a deleted article of the same title", async () => {
            const [one = 0] = await h.seed([{ title: "Synthetic One" }, { title: "Synthetic Two", deleted: true }]);
            expect((await h.patch(one, { title: "Synthetic Two" }, "admin")).status).toBe(200);
        });

        it("should answer 200 and not 409 when the title is the article's own current title (HA-R10)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            expect((await h.patch(id, { title: "Synthetic Article 001" }, "admin")).status).toBe(200);
            const res = await h.patch(id, { title: "Synthetic Article 001", body: "SYNTHETIC-CHANGED" }, "admin");
            expect(res.status).toBe(200);
            expect(res.body.data.body).toBe("SYNTHETIC-CHANGED");
            expect((await h.auditRows())[0]?.metadata).toMatchObject({ changedFields: "body" });
        });

        it("should answer 200 with an identical body, an unchanged updated_at and no audit row for a no-op (HA-R10)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", category: "platform-rules", audience: "doctor" }]);
            const before = await h.get(`${LIST}/${id}`, "admin");
            const rowBefore = (await h.dbRows())[0];
            const res = await h.patch(id, { title: "Synthetic Article 001", body: rowBefore?.body, category: "platform-rules", audience: "doctor", isPublished: true }, "admin");
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual(before.body.data);
            const rowAfter = (await h.dbRows())[0];
            expect(rowAfter?.updated_at.getTime()).toBe(rowBefore?.updated_at.getTime());
            expect(rowAfter?.updated_by).toBe(rowBefore?.updated_by);
            expect(await h.auditRows()).toEqual([]);
        });

        it("should audit only the changed names when the PATCH is partly equal (HA-R10)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const res = await h.patch(id, { title: "Synthetic Article 001", isPublished: false }, "admin");
            expect(res.status).toBe(200);
            expect((await h.auditRows())[0]?.metadata).toEqual({ changedFields: "isPublished", isPublishedBefore: true, isPublishedAfter: false });
        });

        it("should store the new body verbatim", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const body = "  leading\r\n\ttab\n😀 <b>raw</b> ";
            const res = await h.patch(id, { body }, "admin");
            expect(res.body.data.body).toBe(body);
            expect((await h.dbRows())[0]?.body).toBe(body);
        });

        it("should describe the empty-body failure on the body field (HA-R11)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const res = await h.patch(id, {}, "admin");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "body", issue: "must contain at least one property" }]);
        });

        it.each([
            ["a null title", { title: null }],
            ["a null body", { body: null }],
            ["a null category", { category: null }],
            ["a null audience", { audience: null }],
            ["a null isPublished", { isPublished: null }],
            ["a string isPublished", { isPublished: "true" }],
            ["a publishedAt member", { publishedAt: "2026-01-01T00:00:00Z" }],
            ["an id member", { id: 9 }],
            ["a createdAt member", { createdAt: "2026-01-01T00:00:00Z" }],
            ["a 2-character title", { title: "ab" }],
            ["a title with a newline", { title: "abc\ndef" }],
            ["an empty body", { body: "" }],
            ["a body with NUL", { body: "a\u0000b" }],
            ["a category outside the enum", { category: "nope" }],
            ["an audience outside the enum", { audience: "admin" }],
        ])("should answer 400 ValidationFailed for %s and leave the row untouched (HA-R11)", async (_label, body) => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const before = await h.dbRows();
            const res = await h.patch(id, body, "admin");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await h.dbRows()).toEqual(before);
            expect(await h.auditRows()).toEqual([]);
        });

        it("should answer 404 for a deleted article and for an unknown id and write nothing (HA-R8)", async () => {
            const [deleted = 0] = await h.seed([{ title: "Synthetic Article 001", deleted: true }]);
            for (const id of [deleted, 424242]) {
                const res = await h.patch(id, { title: "Synthetic Renamed" }, "admin");
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
            }
            expect(await h.auditRows()).toEqual([]);
            expect((await h.dbRows())[0]?.title).toBe("Synthetic Article 001");
        });

        it("should ignore an Idempotency-Key header on PATCH because the contract declares none", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const key = randomUUID();
            expect((await h.patch(id, { title: "Synthetic First" }, "admin", { "Idempotency-Key": key })).status).toBe(200);
            expect((await h.patch(id, { title: "Synthetic Second" }, "admin", { "Idempotency-Key": key })).body.data.title).toBe("Synthetic Second");
        });

        it("should serialise two parallel renames to one title into one 200 and one 409", async () => {
            const [one = 0, two = 0] = await h.seed([{ title: "Synthetic One" }, { title: "Synthetic Two" }]);
            const [a, b] = await Promise.all([h.patch(one, { title: "Synthetic Target" }, "admin"), h.patch(two, { title: "Synthetic Target" }, "admin2")]);
            expect([a.status, b.status].sort()).toEqual([200, 409]);
            expect(await h.auditRows()).toHaveLength(1);
        });

        it("should audit once when two identical PATCHes race because the second finds nothing left to change (row lock)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const [a, b] = await Promise.all([h.patch(id, { body: "SYNTHETIC-RACED-BODY" }, "admin"), h.patch(id, { body: "SYNTHETIC-RACED-BODY" }, "admin2")]);
            expect([a.status, b.status]).toEqual([200, 200]);
            expect(await h.auditRows()).toHaveLength(1);
            expect((await h.dbRows())[0]?.body).toBe("SYNTHETIC-RACED-BODY");
        });

        it("should answer 500 and leave the row unchanged when the audit insert fails (HA-R13)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const before = await h.dbRows();
            await withBlockedAudit("help_article.updated", async () => {
                const res = await h.patch(id, { title: "Synthetic Renamed" }, "admin");
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
            });
            expect(await h.dbRows()).toEqual(before);
            expect(await h.auditRows()).toEqual([]);
        });
    });

    describe("DELETE /api/help-articles/{id}", () => {
        it("should answer 204 with no body, soft delete the row and write one audit row with isPublishedAfter null (HA-R8, HA-R12)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const requestId = randomUUID();
            const res = await h.del(id, "admin2", { "X-Request-Id": requestId });
            expect(res.status).toBe(204);
            expect(res.text).toBe("");
            expect(res.headers["x-request-id"]).toBe(requestId);
            const rows = await h.dbRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]?.deleted_at).not.toBeNull();
            expect(rows[0]).toMatchObject({ updated_by: 304, created_by: 303 });
            expect(await h.auditRows()).toEqual([
                {
                    actor_user_id: 304,
                    actor_role: "admin",
                    action: "help_article.deleted",
                    entity_type: "help_article",
                    entity_id: id,
                    request_id: requestId,
                    metadata: { isPublishedBefore: true, isPublishedAfter: null },
                },
            ]);
        });

        it("should audit isPublishedBefore false for a deleted draft", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", isPublished: false }]);
            expect((await h.del(id, "admin")).status).toBe(204);
            expect((await h.auditRows())[0]?.metadata).toEqual({ isPublishedBefore: false, isPublishedAfter: null });
        });

        it("should make the article 404 for the author admin and for every role afterwards (HA-R8, HA-D4)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            await h.del(id, "admin");
            for (const actor of ["admin", "admin2", "patient", "doctor", "doctorPending", "doctorRejected"] as const) {
                const res = await h.get(`${LIST}/${id}`, actor);
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
            }
            expect((await h.get(LIST, "admin")).body.data).toEqual([]);
            expect((await h.get(LIST, "patient")).body.data).toEqual([]);
        });

        it("should answer 404 for a second DELETE and write no second audit row", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            expect((await h.del(id, "admin")).status).toBe(204);
            const again = await h.del(id, "admin");
            expect(again.status).toBe(404);
            expectErrorEnvelope(again.body, "NotFound");
            expect(await h.auditRows()).toHaveLength(1);
        });

        it("should answer 404 for PATCH of a deleted article and for an unknown id", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            await h.del(id, "admin");
            expect((await h.patch(id, { title: "Synthetic Renamed" }, "admin")).status).toBe(404);
            expect((await h.del(424242, "admin")).status).toBe(404);
            expect(await h.auditRows()).toHaveLength(1);
        });

        it("should free the title for a new article after the delete (HA-R8)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            expect((await h.post(validCreate(), "admin")).status).toBe(409);
            await h.del(id, "admin");
            const created = await h.post(validCreate(), "admin");
            expect(created.status).toBe(201);
            expect(created.body.data.id).not.toBe(id);
            const rows = await h.dbRows();
            expect(rows).toHaveLength(2);
            expect(rows.filter((row) => row.deleted_at === null)).toHaveLength(1);
        });

        it("should answer 204 and 404 for two parallel DELETEs of one article and audit once", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const [a, b] = await Promise.all([h.del(id, "admin"), h.del(id, "admin2")]);
            expect([a.status, b.status].sort()).toEqual([204, 404]);
            expect(await h.auditRows()).toHaveLength(1);
        });

        it("should answer 500 and keep the article live when the audit insert fails (HA-R13)", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            await withBlockedAudit("help_article.deleted", async () => {
                const res = await h.del(id, "admin");
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
            });
            expect((await h.dbRows())[0]?.deleted_at).toBeNull();
            expect(await h.auditRows()).toEqual([]);
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(200);
        });
    });

    describe("responses carry no secrets", () => {
        it("should never include a password, token or hash in any write response", async () => {
            const created = await h.post(validCreate(), "admin");
            const patched = await h.patch(created.body.data.id, { title: "Synthetic Renamed" }, "admin");
            for (const res of [created, patched]) expect(JSON.stringify(res.body)).not.toMatch(/password|token|secret|hash/i);
        });
    });

    describe("contract conformance", () => {
        it("should have produced only statuses declared by the contract for each operation in this suite", () => {
            expectObservedStatusesDeclared(h, [
                ["POST /api/help-articles", "/api/help-articles", "post"],
                ["PATCH /api/help-articles/{id}", "/api/help-articles/{id}", "patch"],
                ["DELETE /api/help-articles/{id}", "/api/help-articles/{id}", "delete"],
            ]);
        });
    });
});
