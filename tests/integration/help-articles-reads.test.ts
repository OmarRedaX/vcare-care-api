import { encodeCursor } from "../../src/lib/http/pagination/cursor";
import { expectErrorEnvelope, expectPaginationMeta, expectSuccessEnvelope, inlineLists, schemaBlock } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import { expectObservedStatusesDeclared, BODY_MARKER, LIST, padded, useHelpArticlesHarness } from "../helpers/help-articles-harness";
import type { ActorName, ArticleBody, SummaryBody } from "../helpers/help-articles-harness";

jest.setTimeout(60_000);

const titles = (res: { body: { data: Array<{ title: string }> } }): string[] => res.body.data.map((a) => a.title);
const ids = (res: { body: { data: Array<{ id: number }> } }): number[] => res.body.data.map((a) => a.id);
const minute = (index: number): string => new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + index * 60_000).toISOString();

describe("help-articles reads (integration: real wiring, real Postgres as care_app, real Redis)", () => {
    const h = useHelpArticlesHarness();

    /** Asserts exactly the contract `HelpArticle` shape. */
    function expectArticle(value: unknown): ArticleBody {
        const [required = []] = inlineLists(schemaBlock("HelpArticle"), "required");
        const body = value as ArticleBody;
        expect(Object.keys(body).sort()).toEqual([...required].sort());
        expect(typeof body.id).toBe("number");
        expect(typeof body.title).toBe("string");
        expect(typeof body.body).toBe("string");
        expect(["how-it-works", "preparing-for-consultation", "cancellation-policy", "platform-rules"]).toContain(body.category);
        expect(["patient", "doctor"]).toContain(body.audience);
        expect(typeof body.isPublished).toBe("boolean");
        expect(body.publishedAt === null || new Date(body.publishedAt).toISOString() === body.publishedAt).toBe(true);
        expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
        expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
        return body;
    }

    /** Asserts exactly the contract `HelpArticleSummary` shape: no body, no createdAt. */
    function expectSummary(value: unknown): SummaryBody {
        const [required = []] = inlineLists(schemaBlock("HelpArticleSummary"), "required");
        const item = value as SummaryBody;
        expect(Object.keys(item).sort()).toEqual([...required].sort());
        expect(item).not.toHaveProperty("body");
        expect(item).not.toHaveProperty("createdAt");
        return item;
    }

    describe("visibility (HA-R5 to HA-R8)", () => {
        /** patient published, patient draft, doctor published, doctor deleted (spec 9.2) plus a patient deleted and an admin-visible doctor draft. */
        async function seedFour() {
            const [patientPublished = 0, patientDraft = 0, doctorPublished = 0, doctorDeleted = 0, patientDeleted = 0, doctorDraft = 0] = await h.seed([
                { title: "Synthetic Patient Published", audience: "patient" },
                { title: "Synthetic Patient Draft", audience: "patient", isPublished: false },
                { title: "Synthetic Doctor Published", audience: "doctor" },
                { title: "Synthetic Doctor Deleted", audience: "doctor", deleted: true },
                { title: "Synthetic Patient Deleted", audience: "patient", deleted: true },
                { title: "Synthetic Doctor Draft", audience: "doctor", isPublished: false },
            ]);
            return { patientPublished, patientDraft, doctorPublished, doctorDeleted, patientDeleted, doctorDraft };
        }

        it("should list only the published article of the patient audience and 404 the others with the body of an unknown id (HA-R5)", async () => {
            const seeded = await seedFour();
            const list = await h.get(LIST, "patient");
            expect(list.status).toBe(200);
            expect(titles(list)).toEqual(["Synthetic Patient Published"]);
            expect((await h.get(`${LIST}/${seeded.patientPublished}`, "patient")).status).toBe(200);

            const missing = await h.get(`${LIST}/999999`, "patient");
            const strip = (body: { error: { requestId: string } }): unknown => ({ ...body, error: { ...body.error, requestId: "x" } });
            for (const hidden of [seeded.patientDraft, seeded.doctorPublished, seeded.doctorDraft, seeded.doctorDeleted, seeded.patientDeleted]) {
                const res = await h.get(`${LIST}/${hidden}`, "patient");
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
                expect(strip(res.body)).toEqual(strip(missing.body));
            }
        });

        it.each([["doctor"], ["doctorPending"], ["doctorRejected"]] as Array<[ActorName]>)(
            "should list only the published doctor article for %s and 404 the others (HA-R5, HA-D14)",
            async (actor) => {
                const seeded = await seedFour();
                expect(titles(await h.get(LIST, actor))).toEqual(["Synthetic Doctor Published"]);
                expect((await h.get(`${LIST}/${seeded.doctorPublished}`, actor)).status).toBe(200);
                for (const hidden of [seeded.patientPublished, seeded.patientDraft, seeded.doctorDraft, seeded.doctorDeleted]) {
                    expect((await h.get(`${LIST}/${hidden}`, actor)).status).toBe(404);
                }
            },
        );

        it("should ignore audience and isPublished from a patient and a doctor because they are admin filters (HA-R7)", async () => {
            await seedFour();
            for (const query of ["audience=doctor&isPublished=false", "audience=doctor", "isPublished=false", "isPublished=true&audience=patient"]) {
                expect(titles(await h.get(`${LIST}?${query}`, "patient"))).toEqual(["Synthetic Patient Published"]);
                expect(titles(await h.get(`${LIST}?${query}`, "doctor"))).toEqual(["Synthetic Doctor Published"]);
            }
        });

        it("should apply the category filter for every role (HA-R7)", async () => {
            await h.seed([
                { title: "Synthetic Patient Rules", category: "platform-rules" },
                { title: "Synthetic Patient How", category: "how-it-works" },
                { title: "Synthetic Doctor Rules", audience: "doctor", category: "platform-rules" },
                { title: "Synthetic Doctor How", audience: "doctor", category: "how-it-works" },
                { title: "Synthetic Patient Draft Rules", category: "platform-rules", isPublished: false },
            ]);
            expect(titles(await h.get(`${LIST}?category=platform-rules`, "patient"))).toEqual(["Synthetic Patient Rules"]);
            expect(titles(await h.get(`${LIST}?category=platform-rules`, "doctor"))).toEqual(["Synthetic Doctor Rules"]);
            expect([...titles(await h.get(`${LIST}?category=platform-rules`, "admin"))].sort()).toEqual([
                "Synthetic Doctor Rules",
                "Synthetic Patient Draft Rules",
                "Synthetic Patient Rules",
            ]);
            expect(await h.get(`${LIST}?category=cancellation-policy`, "patient").then((r) => r.body.data)).toEqual([]);
        });

        it("should show an admin every live article of both audiences, drafts included, and never a deleted one (HA-R6)", async () => {
            await seedFour();
            const res = await h.get(LIST, "admin");
            expect([...titles(res)].sort()).toEqual(["Synthetic Doctor Draft", "Synthetic Doctor Published", "Synthetic Patient Draft", "Synthetic Patient Published"]);
        });

        it("should filter an admin list by audience, isPublished and category (HA-R6)", async () => {
            await h.seed([
                { title: "Synthetic P Pub How", audience: "patient", category: "how-it-works" },
                { title: "Synthetic P Draft Rules", audience: "patient", category: "platform-rules", isPublished: false },
                { title: "Synthetic D Pub Rules", audience: "doctor", category: "platform-rules" },
                { title: "Synthetic D Draft How", audience: "doctor", category: "how-it-works", isPublished: false },
            ]);
            const sorted = async (query: string): Promise<string[]> => [...titles(await h.get(`${LIST}?${query}`, "admin"))].sort();
            expect(await sorted("audience=doctor")).toEqual(["Synthetic D Draft How", "Synthetic D Pub Rules"]);
            expect(await sorted("audience=patient")).toEqual(["Synthetic P Draft Rules", "Synthetic P Pub How"]);
            expect(await sorted("isPublished=true")).toEqual(["Synthetic D Pub Rules", "Synthetic P Pub How"]);
            expect(await sorted("isPublished=false")).toEqual(["Synthetic D Draft How", "Synthetic P Draft Rules"]);
            expect(await sorted("category=platform-rules")).toEqual(["Synthetic D Pub Rules", "Synthetic P Draft Rules"]);
            expect(await sorted("audience=doctor&isPublished=false")).toEqual(["Synthetic D Draft How"]);
            expect(await sorted("audience=patient&category=how-it-works&isPublished=true")).toEqual(["Synthetic P Pub How"]);
            expect(await sorted("audience=patient&category=platform-rules&isPublished=true")).toEqual([]);
        });

        it("should return a draft by id to an admin with 200 and a deleted article with 404 (HA-R6, HA-R8, HA-D4)", async () => {
            const seeded = await seedFour();
            const draft = await h.get(`${LIST}/${seeded.patientDraft}`, "admin");
            expect(draft.status).toBe(200);
            expect(expectArticle(expectSuccessEnvelope(draft.body))).toMatchObject({ isPublished: false, publishedAt: null });
            expect((await h.get(`${LIST}/${seeded.doctorDraft}`, "admin")).status).toBe(200);
            for (const deleted of [seeded.doctorDeleted, seeded.patientDeleted]) {
                const res = await h.get(`${LIST}/${deleted}`, "admin");
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
            }
        });

        it("should drop an article from reader lists and make it 404 the moment it is unpublished or deleted", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(200);
            await ownerDb("help_articles").where({ id }).update({ is_published: false });
            expect((await h.get(`${LIST}/${id}`, "patient")).status).toBe(404);
            expect((await h.get(LIST, "patient")).body.data).toEqual([]);
            await ownerDb("help_articles").where({ id }).update({ is_published: true, deleted_at: new Date() });
            expect((await h.get(`${LIST}/${id}`, "admin")).status).toBe(404);
            expect((await h.get(LIST, "admin")).body.data).toEqual([]);
        });

        it("should return the same article shape to every role who can see it and the body verbatim (HA-R1)", async () => {
            const body = "# Heading\r\n\tindented\n😀 <script>alert(1)</script>  \n";
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001", body }]);
            const shapes: unknown[] = [];
            for (const actor of ["patient", "admin"] as const) {
                const res = await h.get(`${LIST}/${id}`, actor);
                expect(res.status).toBe(200);
                const article = expectArticle(expectSuccessEnvelope(res.body));
                expect(article.body).toBe(body);
                shapes.push(article);
            }
            expect(shapes[0]).toEqual(shapes[1]);
        });

        it("should not return created_by, updated_by or deleted_at in any read", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const text = JSON.stringify([(await h.get(LIST, "admin")).body, (await h.get(`${LIST}/${id}`, "admin")).body]);
            expect(text).not.toMatch(/created_?by|updated_?by|deleted_?at/i);
        });
    });

    describe("list item shape (HA-R18)", () => {
        it("should return HelpArticleSummary items with no body or createdAt and a PaginationMeta", async () => {
            await h.seed([{ title: "Synthetic Article 001" }, { title: "Synthetic Article 002", isPublished: false }]);
            for (const actor of ["patient", "admin"] as const) {
                const res = await h.get(LIST, actor);
                expect(res.status).toBe(200);
                expect(res.body.success).toBe(true);
                expect(Array.isArray(expectSuccessEnvelope(res.body))).toBe(true);
                for (const item of res.body.data) expectSummary(item);
                expectPaginationMeta(res.body.meta);
                expect(JSON.stringify(res.body)).not.toContain(BODY_MARKER);
            }
        });

        it("should return an empty page with the contract meta when there are no rows", async () => {
            const res = await h.get(LIST, "patient");
            expect(res.status).toBe(200);
            expect(expectSuccessEnvelope(res.body)).toEqual([]);
            expect(expectPaginationMeta(res.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        });
    });

    describe("query validation", () => {
        it.each([
            ["audience=admin"],
            ["audience=Doctor"],
            ["isPublished=yes"],
            ["isPublished=1"],
            ["isPublished=TRUE"],
            ["isPublished="],
            ["isPublished=true&isPublished=false"],
            ["category=other"],
            ["limit=0"],
            ["limit=101"],
            ["limit=1e1"],
            ["limit=05"],
            ["sort=title"],
            [`cursor=${"a".repeat(1025)}`],
        ])("should answer 400 ValidationFailed for %s for a patient, a doctor and an admin (junk is validated for every role, HA-R7)", async (query) => {
            for (const actor of ["patient", "doctor", "admin"] as const) {
                const res = await h.get(`${LIST}?${query}`, actor);
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
            }
        });

        it("should name the offending query member in the details", async () => {
            const res = await h.get(`${LIST}?isPublished=yes`, "patient");
            expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain("isPublished");
            expect(JSON.stringify(res.body)).not.toContain("yes");
        });

        it("should accept limit 1 and limit 100", async () => {
            await h.seedMany(3);
            expect((await h.get(`${LIST}?limit=1`, "patient")).body.data).toHaveLength(1);
            expect((await h.get(`${LIST}?limit=100`, "patient")).body.data).toHaveLength(3);
        });
    });

    describe("pagination (HA-R17)", () => {
        it("should reach page 2 and the last page on the default reader sort published_at DESC, id DESC without duplicates", async () => {
            // updated_at runs the opposite way so a reader list sorted by updated_at would fail the order check.
            await h.seed(
                Array.from({ length: 45 }, (_v, i) => ({ title: `Synthetic Article ${padded(i + 1)}`, publishedAt: minute(i), updatedAt: minute(100 - i) })),
            );
            const expected = Array.from({ length: 45 }, (_v, i) => `Synthetic Article ${padded(45 - i)}`);

            const first = await h.get(LIST, "patient");
            expect(first.status).toBe(200);
            expect(titles(first)).toEqual(expected.slice(0, 20));
            const meta1 = expectPaginationMeta(first.body.meta);
            expect(meta1).toMatchObject({ hasMore: true, count: 20 });
            expect(meta1.nextCursor).not.toBeNull();

            const second = await h.get(`${LIST}?cursor=${encodeURIComponent(meta1.nextCursor ?? "")}`, "patient");
            expect(second.status).toBe(200);
            expect(titles(second)).toEqual(expected.slice(20, 40));
            const meta2 = expectPaginationMeta(second.body.meta);
            expect(meta2).toMatchObject({ hasMore: true, count: 20 });

            const third = await h.get(`${LIST}?cursor=${encodeURIComponent(meta2.nextCursor ?? "")}`, "patient");
            expect(third.status).toBe(200);
            expect(titles(third)).toEqual(expected.slice(40));
            expect(expectPaginationMeta(third.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 5 });

            const all = [...ids(first), ...ids(second), ...ids(third)];
            expect(new Set(all).size).toBe(45);
            for (const page of [first, second, third]) for (const item of page.body.data) expectSummary(item);
        });

        it("should reach page 2 and the last page on the default admin sort updated_at DESC, id DESC without duplicates", async () => {
            // published_at runs the opposite way so an admin list sorted by published_at would fail the order check.
            await h.seed(
                Array.from({ length: 45 }, (_v, i) => ({
                    title: `Synthetic Article ${padded(i + 1)}`,
                    publishedAt: minute(100 - i),
                    updatedAt: minute(i),
                    isPublished: i % 5 !== 0,
                })),
            );
            const expected = Array.from({ length: 45 }, (_v, i) => `Synthetic Article ${padded(45 - i)}`);

            const first = await h.get(LIST, "admin");
            expect(titles(first)).toEqual(expected.slice(0, 20));
            const meta1 = expectPaginationMeta(first.body.meta);
            expect(meta1).toMatchObject({ hasMore: true, count: 20 });
            const second = await h.get(`${LIST}?cursor=${encodeURIComponent(meta1.nextCursor ?? "")}`, "admin");
            expect(titles(second)).toEqual(expected.slice(20, 40));
            const meta2 = expectPaginationMeta(second.body.meta);
            const third = await h.get(`${LIST}?cursor=${encodeURIComponent(meta2.nextCursor ?? "")}`, "admin");
            expect(titles(third)).toEqual(expected.slice(40));
            expect(expectPaginationMeta(third.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 5 });
            expect(new Set([...ids(first), ...ids(second), ...ids(third)]).size).toBe(45);
            // Drafts are part of the admin pages.
            expect([...first.body.data, ...second.body.data, ...third.body.data].some((a: SummaryBody) => !a.isPublished)).toBe(true);
        });

        it("should keep reader order stable when an article is edited and move it to the top of the admin list (HA-D1)", async () => {
            const [oldest = 0] = await h.seed(Array.from({ length: 3 }, (_v, i) => ({ title: `Synthetic Article ${padded(i + 1)}`, publishedAt: minute(i), updatedAt: minute(i) })));
            const before = titles(await h.get(LIST, "patient"));
            expect((await h.patch(oldest, { body: "SYNTHETIC-EDITED-BODY" }, "admin")).status).toBe(200);
            expect(titles(await h.get(LIST, "patient"))).toEqual(before);
            expect(titles(await h.get(LIST, "admin"))[0]).toBe("Synthetic Article 001");
        });

        it("should page 30 rows that share one millisecond and some identical instants without skipping or repeating one (microsecond cursor)", async () => {
            // Group of three rows share a microsecond exactly (id breaks the tie); groups differ by a few microseconds.
            const rows = Array.from({ length: 30 }, (_v, i) => ({
                title: `Synthetic Article ${padded(i + 1)}`,
                publishedAt: `2026-03-01T10:00:00.${String(100 + Math.floor(i / 3) * 3).padStart(6, "0")}Z`,
                updatedAt: `2026-03-01T10:00:00.${String(100 + Math.floor(i / 3) * 3).padStart(6, "0")}Z`,
            }));
            const seeded = await h.seed(rows);
            // Expected: published_at DESC, id DESC.
            const expected = [...seeded]
                .map((id, i) => ({ id, group: Math.floor(i / 3) }))
                .sort((a, b) => b.group - a.group || b.id - a.id)
                .map((row) => row.id);
            for (const actor of ["patient", "admin"] as const) {
                const seen: number[] = [];
                let cursor: string | null = null;
                for (let page = 0; page < 10; page += 1) {
                    const res = await h.get(`${LIST}?limit=7${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, actor);
                    expect(res.status).toBe(200);
                    seen.push(...ids(res));
                    cursor = res.body.meta.nextCursor as string | null;
                    if (cursor === null) break;
                }
                expect(seen).toEqual(expected);
                expect(new Set(seen).size).toBe(30);
            }
        });

        it("should report hasMore false with a null cursor when the rows exactly fill the limit and true when one more exists", async () => {
            await h.seedMany(3);
            expect(expectPaginationMeta((await h.get(`${LIST}?limit=3`, "patient")).body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 3 });
            expect(expectPaginationMeta((await h.get(`${LIST}?limit=2`, "patient")).body.meta)).toMatchObject({ hasMore: true, count: 2 });
            expect(expectPaginationMeta((await h.get(`${LIST}?limit=3`, "admin")).body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 3 });
        });

        it("should continue correctly when the cursor row is unpublished or deleted between pages (position, not grant)", async () => {
            await h.seed(Array.from({ length: 6 }, (_v, i) => ({ title: `Synthetic Article ${padded(i + 1)}`, publishedAt: minute(i), updatedAt: minute(i) })));
            const first = await h.get(`${LIST}?limit=3`, "patient");
            expect(titles(first)).toEqual(["Synthetic Article 006", "Synthetic Article 005", "Synthetic Article 004"]);
            await ownerDb("help_articles").where({ title: "Synthetic Article 004" }).update({ is_published: false });
            const second = await h.get(`${LIST}?limit=3&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`, "patient");
            expect(second.status).toBe(200);
            expect(titles(second)).toEqual(["Synthetic Article 003", "Synthetic Article 002", "Synthetic Article 001"]);

            const adminFirst = await h.get(`${LIST}?limit=3`, "admin");
            await ownerDb("help_articles").where({ title: "Synthetic Article 004" }).update({ deleted_at: new Date() });
            const adminSecond = await h.get(`${LIST}?limit=3&cursor=${encodeURIComponent(adminFirst.body.meta.nextCursor)}`, "admin");
            expect(adminSecond.status).toBe(200);
            expect(titles(adminSecond)).toEqual(["Synthetic Article 003", "Synthetic Article 002", "Synthetic Article 001"]);
        });

        it("should keep the caller's role filter on every page because a cursor is a position, not a grant", async () => {
            // Doctor articles are published at minutes 1, 3, 5; patient articles at 2, 4, 6.
            await h.seed([
                { title: "Synthetic Doctor 1", audience: "doctor", publishedAt: minute(1) },
                { title: "Synthetic Patient 2", publishedAt: minute(2) },
                { title: "Synthetic Doctor 3", audience: "doctor", publishedAt: minute(3) },
                { title: "Synthetic Patient 4", publishedAt: minute(4) },
                { title: "Synthetic Doctor 5", audience: "doctor", publishedAt: minute(5) },
                { title: "Synthetic Patient 6", publishedAt: minute(6) },
            ]);
            const patientPage = await h.get(`${LIST}?limit=2`, "patient");
            expect(titles(patientPage)).toEqual(["Synthetic Patient 6", "Synthetic Patient 4"]);
            // The patient's cursor sits at minute 4; a doctor using it still sees doctor articles older than that only.
            const doctorPage = await h.get(`${LIST}?limit=5&cursor=${encodeURIComponent(patientPage.body.meta.nextCursor)}`, "doctor");
            expect(doctorPage.status).toBe(200);
            expect(titles(doctorPage)).toEqual(["Synthetic Doctor 3", "Synthetic Doctor 1"]);
        });

        it("should answer 400 on the cursor for an admin cursor given to a patient and a patient cursor given to an admin", async () => {
            await h.seedMany(4);
            const adminCursor = (await h.get(`${LIST}?limit=1`, "admin")).body.meta.nextCursor as string;
            const patientCursor = (await h.get(`${LIST}?limit=1`, "patient")).body.meta.nextCursor as string;
            const asPatient = await h.get(`${LIST}?cursor=${encodeURIComponent(adminCursor)}`, "patient");
            const asDoctor = await h.get(`${LIST}?cursor=${encodeURIComponent(adminCursor)}`, "doctor");
            const asAdmin = await h.get(`${LIST}?cursor=${encodeURIComponent(patientCursor)}`, "admin");
            for (const res of [asPatient, asDoctor, asAdmin]) {
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
            }
        });

        it.each([
            ["a tampered cursor", "not-a-cursor!"],
            ["a numeric sort value", encodeCursor(5, 1)],
            ["a sort value with no kind prefix", encodeCursor("2026-10-29T10:00:00.123456Z", 1)],
            ["a millisecond-only timestamp", encodeCursor("published:2026-10-29T10:00:00.123Z", 1)],
            ["a nonexistent date", encodeCursor("published:2026-02-30T00:00:00.000000Z", 1)],
            ["year 0000 on a reader cursor (out of range for Postgres, never a 500)", encodeCursor("published:0000-01-01T00:00:00.000000Z", 1)],
            ["year 0000 on an admin cursor (out of range for Postgres, never a 500)", encodeCursor("updated:0000-01-01T00:00:00.000000Z", 1)],
            ["a NUL character", encodeCursor("published:2026-10-29T10:00:00.123456Z\u0000", 1)],
            ["an over-long sort value", encodeCursor(`published:2026-10-29T10:00:00.123456Z${"x".repeat(10)}`, 1)],
        ])("should answer 400 on the cursor field for %s and read nothing", async (_label, cursor) => {
            for (const actor of ["patient", "admin"] as const) {
                const res = await h.get(`${LIST}?cursor=${encodeURIComponent(cursor)}`, actor);
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
            }
            expect(await h.auditRows()).toEqual([]);
        });

        it("should return an empty last page for a valid cursor positioned before every row", async () => {
            await h.seedMany(2, { publishedAt: "2026-01-01T00:00:00.000000Z", updatedAt: "2026-01-01T00:00:00.000000Z" });
            const res = await h.get(`${LIST}?cursor=${encodeURIComponent(encodeCursor("published:2025-01-01T00:00:00.000000Z", 1))}`, "patient");
            expect(res.status).toBe(200);
            expect(expectPaginationMeta(res.body.meta)).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        });
    });

    describe("reads are not audited (HA-R14)", () => {
        it("should leave the help_article audit count unchanged after a list, a get and an admin get", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            await h.get(LIST, "patient");
            await h.get(`${LIST}/${id}`, "patient");
            await h.get(`${LIST}/${id}`, "admin");
            await h.get(LIST, "admin");
            await h.get(`${LIST}/999999`, "patient");
            expect(await h.auditRows()).toEqual([]);
            const all = await ownerDb.raw<{ rows: Array<{ count: number }> }>("SELECT count(*)::int AS count FROM audit_logs");
            expect(all.rows[0]?.count).toBe(0);
        });
    });

    describe("contract conformance", () => {
        it("should have produced only statuses declared by the contract for each operation in this suite", () => {
            expectObservedStatusesDeclared(h, [
                ["GET /api/help-articles", "/api/help-articles", "get"],
                ["GET /api/help-articles/{id}", "/api/help-articles/{id}", "get"],
            ]);
        });
    });
});
