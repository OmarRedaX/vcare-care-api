import type { Knex } from "knex";
import { HelpArticleAudience, HelpArticleCategory } from "../../src/app/help-articles/enums";
import { listHelpArticlesQuery } from "../../src/app/help-articles/repository/help-articles.repo";
import type { HelpArticleListScope } from "../../src/app/help-articles/types";
import { createKnex, db } from "../../src/lib/knex/knex";
import * as helpArticlesMigration from "../../src/migrations/20261029120000_create_help_articles";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { padded } from "../helpers/help-articles-harness";

jest.setTimeout(60_000);

const baseRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: "Synthetic Article 001",
    body: "SYNTHETIC-HELP-BODY-7731",
    category: "how-it-works",
    audience: "patient",
    is_published: true,
    published_at: new Date("2026-01-01T00:00:00Z"),
    created_by: 303,
    updated_by: 303,
    ...overrides,
});

describe("help_articles schema (integration: real Postgres, owner for assertions, care_app for the app role)", () => {
    let migrator: Knex;

    beforeAll(() => {
        migrator = createKnex({ url: process.env.MIGRATION_DATABASE_URL ?? "", poolMax: 1, statementTimeoutMs: null, applicationName: "care-migrate" });
    });

    beforeEach(async () => {
        await truncateAll();
    });

    afterAll(async () => {
        await truncateAll();
        await migrator.destroy();
        await closeDb();
    });

    describe("grants (HA-R23)", () => {
        it("should grant vcare_app exactly SELECT, INSERT, UPDATE and sequence USAGE and neither DELETE nor TRUNCATE", async () => {
            const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
                `SELECT has_table_privilege('vcare_app', 'help_articles', 'SELECT') AS sel,
                        has_table_privilege('vcare_app', 'help_articles', 'INSERT') AS ins,
                        has_table_privilege('vcare_app', 'help_articles', 'UPDATE') AS upd,
                        has_table_privilege('vcare_app', 'help_articles', 'DELETE') AS del,
                        has_table_privilege('vcare_app', 'help_articles', 'TRUNCATE') AS trunc,
                        has_table_privilege('vcare_app', 'help_articles', 'REFERENCES') AS refs,
                        has_table_privilege('vcare_app', 'help_articles', 'TRIGGER') AS trig,
                        has_sequence_privilege('vcare_app', 'help_articles_id_seq', 'USAGE') AS seq`,
            );
            expect(result.rows[0]).toEqual({ sel: true, ins: true, upd: true, del: false, trunc: false, refs: false, trig: false, seq: true });
        });

        it("should reject DELETE and TRUNCATE for care_app with 42501 and keep the row", async () => {
            await ownerDb("help_articles").insert(baseRow());
            await expect(db.raw("DELETE FROM help_articles")).rejects.toMatchObject({ code: "42501" });
            await expect(db.raw("TRUNCATE help_articles")).rejects.toMatchObject({ code: "42501" });
            expect(await ownerDb("help_articles").count("* as n")).toEqual([{ n: 1 }]);
        });

        it("should allow SELECT, INSERT and a soft-delete UPDATE for care_app", async () => {
            const [row] = await db("help_articles").insert(baseRow()).returning("id");
            await expect(db("help_articles").where({ id: row.id }).update({ deleted_at: new Date() })).resolves.toBe(1);
            const read = await db.raw<{ rows: Array<{ deleted_at: Date | null }> }>("SELECT deleted_at FROM help_articles WHERE id = ?", [row.id]);
            expect(read.rows[0]?.deleted_at).not.toBeNull();
        });
    });

    describe("named checks (HA-D11, HA-R2)", () => {
        it.each([
            ["a 2-character title", { title: "ab" }, "chk_help_articles_title_length"],
            ["an empty body", { body: "" }, "chk_help_articles_body_length"],
            ["a 50001-character body", { body: "a".repeat(50_001) }, "chk_help_articles_body_length"],
            ["a published article without published_at", { is_published: true, published_at: null }, "chk_help_articles_published"],
            ["a category outside the enum", { category: "other" }, "chk_help_articles_category"],
            ["an audience outside the enum", { audience: "admin" }, "chk_help_articles_audience"],
        ])("should reject %s with 23514 on the named constraint", async (_label, overrides, constraint) => {
            await expect(ownerDb("help_articles").insert(baseRow(overrides))).rejects.toMatchObject({ code: "23514", constraint });
        });

        it("should reject a 201-character title with 22001", async () => {
            await expect(ownerDb("help_articles").insert(baseRow({ title: "a".repeat(201) }))).rejects.toMatchObject({ code: "22001" });
        });

        it("should accept the boundaries counted in code points: 3-character title, 1-character body, 200 astral title, 50000 astral body", async () => {
            await expect(ownerDb("help_articles").insert(baseRow({ title: "abc", body: "x" }))).resolves.toBeDefined();
            await expect(ownerDb("help_articles").insert(baseRow({ title: "😀".repeat(200), body: "😀".repeat(50_000) }))).resolves.toBeDefined();
        });

        it("should allow an unpublished article to keep a published_at (unpublish keeps the first publish time)", async () => {
            await expect(ownerDb("help_articles").insert(baseRow({ is_published: false }))).resolves.toBeDefined();
            await expect(ownerDb("help_articles").insert(baseRow({ title: "Synthetic Draft", is_published: false, published_at: null }))).resolves.toBeDefined();
        });

        it.each([["is_published"], ["title"], ["body"], ["category"], ["audience"], ["created_by"], ["updated_by"]])(
            "should reject an INSERT that omits %s with 23502 because the column has no default",
            async (column) => {
                const row = baseRow();
                delete row[column];
                await expect(ownerDb("help_articles").insert(row)).rejects.toMatchObject({ code: "23502" });
            },
        );
    });

    describe("unique live title per audience (HA-R3, HA-D5)", () => {
        it("should raise 23505 on uq_help_articles_audience_title for a live duplicate and allow other audiences, other case and a deleted twin", async () => {
            await ownerDb("help_articles").insert(baseRow());
            await expect(ownerDb("help_articles").insert(baseRow())).rejects.toMatchObject({ code: "23505", constraint: "uq_help_articles_audience_title" });
            await expect(ownerDb("help_articles").insert(baseRow({ audience: "doctor" }))).resolves.toBeDefined();
            await expect(ownerDb("help_articles").insert(baseRow({ title: "synthetic article 001" }))).resolves.toBeDefined();
            await expect(ownerDb("help_articles").insert(baseRow({ title: "Synthetic Article 001 " }))).resolves.toBeDefined();
            await expect(ownerDb("help_articles").insert(baseRow({ deleted_at: new Date() }))).resolves.toBeDefined();
        });

        it("should free the title once the live row is soft deleted and block it again for a second live row", async () => {
            const [row] = await ownerDb("help_articles").insert(baseRow()).returning("id");
            await ownerDb("help_articles").where({ id: row.id }).update({ deleted_at: new Date() });
            await expect(ownerDb("help_articles").insert(baseRow())).resolves.toBeDefined();
            await expect(ownerDb("help_articles").insert(baseRow())).rejects.toMatchObject({ code: "23505" });
        });
    });

    describe("table shape", () => {
        it("should store every timestamp as timestamptz and have no foreign key to another table", async () => {
            const columns = await ownerDb.raw<{ rows: Array<{ column_name: string; data_type: string }> }>(
                `SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_name = 'help_articles' AND column_name IN ('published_at', 'created_at', 'updated_at', 'deleted_at') ORDER BY column_name`,
            );
            expect(columns.rows.map((row) => row.data_type)).toEqual(Array(4).fill("timestamp with time zone"));
            const fks = await ownerDb.raw<{ rows: Array<{ conname: string }> }>(
                "SELECT conname FROM pg_constraint WHERE conrelid = 'public.help_articles'::regclass AND contype = 'f'",
            );
            expect(fks.rows).toEqual([]);
        });

        it("should expose the named constraints and the three partial indexes with their predicates", async () => {
            const constraints = await ownerDb.raw<{ rows: Array<{ name: string }> }>(
                "SELECT conname AS name FROM pg_constraint WHERE conrelid = 'public.help_articles'::regclass AND contype <> 'n' ORDER BY conname",
            );
            expect(constraints.rows.map((row) => row.name)).toEqual([
                "chk_help_articles_audience",
                "chk_help_articles_body_length",
                "chk_help_articles_category",
                "chk_help_articles_published",
                "chk_help_articles_title_length",
                "help_articles_pkey",
            ]);
            const indexes = await ownerDb.raw<{ rows: Array<{ indexname: string; indexdef: string }> }>(
                "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'help_articles' ORDER BY indexname",
            );
            const defs = Object.fromEntries(indexes.rows.map((row) => [row.indexname, row.indexdef]));
            expect(Object.keys(defs)).toEqual([
                "help_articles_pkey",
                "idx_help_articles_audience_published_at_id",
                "idx_help_articles_updated_at_id",
                "uq_help_articles_audience_title",
            ]);
            expect(defs["idx_help_articles_audience_published_at_id"]).toContain("(audience, published_at DESC, id DESC)");
            expect(defs["idx_help_articles_audience_published_at_id"]).toMatch(/WHERE \(?\(?is_published/);
            expect(defs["idx_help_articles_audience_published_at_id"]).toContain("deleted_at IS NULL");
            expect(defs["idx_help_articles_updated_at_id"]).toContain("(updated_at DESC, id DESC)");
            expect(defs["idx_help_articles_updated_at_id"]).toContain("WHERE (deleted_at IS NULL)");
            expect(defs["uq_help_articles_audience_title"]).toContain("CREATE UNIQUE INDEX");
            expect(defs["uq_help_articles_audience_title"]).toContain("(audience, title)");
            expect(defs["uq_help_articles_audience_title"]).toContain("WHERE (deleted_at IS NULL)");
        });

        it("should comment the table and mark the body as never logged", async () => {
            const table = await ownerDb.raw<{ rows: Array<{ d: string | null }> }>("SELECT obj_description('public.help_articles'::regclass) AS d");
            expect(table.rows[0]?.d).toContain("Not clinical data");
            const column = await ownerDb.raw<{ rows: Array<{ d: string | null }> }>(
                "SELECT col_description('public.help_articles'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.help_articles'::regclass AND attname = 'body')) AS d",
            );
            expect(column.rows[0]?.d).toContain("never logged");
        });
    });

    describe("list queries use the partial indexes (CLAUDE.md -> Performance rules: EXPLAIN the list queries)", () => {
        const AFTER = { sortValue: "2026-06-01T00:00:30.000000Z", id: 15 };

        beforeEach(async () => {
            await ownerDb("help_articles").insert(
                Array.from({ length: 60 }, (_v, i) =>
                    baseRow({
                        title: `Synthetic Article ${padded(i + 1)}`,
                        audience: i % 2 === 0 ? "patient" : "doctor",
                        category: i % 4 < 2 ? "how-it-works" : "platform-rules",
                        is_published: i % 5 !== 0,
                        published_at: new Date(Date.UTC(2026, 5, 1, 0, 0, i)),
                        updated_at: new Date(Date.UTC(2026, 5, 1, 0, 0, i)),
                    }),
                ),
            );
            await ownerDb.raw("ANALYZE help_articles");
        });

        async function planOf(query: Knex.QueryBuilder): Promise<string> {
            const built = query.toSQL();
            return db.transaction(async (trx) => {
                await trx.raw("SET LOCAL enable_seqscan = off");
                await trx.raw("SET LOCAL enable_bitmapscan = off"); // a bitmap scan would need a Sort; the test proves the ordered index path exists
                const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": unknown }> }>(`EXPLAIN (FORMAT JSON) ${built.sql}`, built.bindings as never[]);
                return JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
            });
        }

        const READER_SCOPES: Array<[string, HelpArticleListScope]> = [
            ["a reader without a category filter", { kind: "reader", audience: HelpArticleAudience.Patient }],
            ["a reader with a category filter", { kind: "reader", audience: HelpArticleAudience.Patient, category: HelpArticleCategory.PlatformRules }],
            ["a doctor reader", { kind: "reader", audience: HelpArticleAudience.Doctor }],
        ];
        const ADMIN_SCOPES: Array<[string, HelpArticleListScope]> = [
            ["an admin with no filter", { kind: "admin" }],
            ["an admin filtered by category", { kind: "admin", category: HelpArticleCategory.PlatformRules }],
            ["an admin filtered by audience and isPublished", { kind: "admin", audience: HelpArticleAudience.Patient, isPublished: false }],
        ];

        it.each(READER_SCOPES)("should scan idx_help_articles_audience_published_at_id with no Sort node for %s after a cursor", async (_label, scope) => {
            const plan = await planOf(listHelpArticlesQuery({ scope, after: AFTER, fetch: 21 }, db));
            expect(plan).toContain("idx_help_articles_audience_published_at_id");
            expect(plan).toMatch(/"Index Cond":"[^"]*ROW\(published_at, id\) < ROW\(/);
            expect(plan).not.toContain('"Node Type":"Sort"');
        });

        it.each(ADMIN_SCOPES)("should scan idx_help_articles_updated_at_id with no Sort node for %s after a cursor", async (_label, scope) => {
            const plan = await planOf(listHelpArticlesQuery({ scope, after: AFTER, fetch: 21 }, db));
            expect(plan).toContain("idx_help_articles_updated_at_id");
            expect(plan).toMatch(/"Index Cond":"[^"]*ROW\(updated_at, id\) < ROW\(/);
            expect(plan).not.toContain('"Node Type":"Sort"');
        });

        it("should use the same ordered scans for the first page without a cursor", async () => {
            const reader = await planOf(listHelpArticlesQuery({ scope: { kind: "reader", audience: HelpArticleAudience.Patient }, after: null, fetch: 21 }, db));
            expect(reader).toContain("idx_help_articles_audience_published_at_id");
            expect(reader).not.toContain('"Node Type":"Sort"');
            const admin = await planOf(listHelpArticlesQuery({ scope: { kind: "admin" }, after: null, fetch: 21 }, db));
            expect(admin).toContain("idx_help_articles_updated_at_id");
            expect(admin).not.toContain('"Node Type":"Sort"');
        });

        it("should not select body, created_by or updated_by in the list query", () => {
            const sql = listHelpArticlesQuery({ scope: { kind: "admin" }, after: null, fetch: 21 }, db).toSQL().sql;
            expect(sql).not.toMatch(/"body"|created_by|updated_by|\*/);
            expect(sql).toContain("deleted_at");
        });
    });

    describe("migration 20261029120000_create_help_articles up and down (HA-R23, O4)", () => {
        const present = async (): Promise<string | null> => {
            const result = await migrator.raw<{ rows: Array<{ tbl: string | null }> }>("SELECT to_regclass('public.help_articles')::text AS tbl");
            return result.rows[0]?.tbl ?? null;
        };

        it("should be recorded as run and leave the table empty after migrate latest (no seed rows)", async () => {
            const rows = await migrator("knex_migrations").select("name").where("name", "20261029120000_create_help_articles");
            expect(rows).toHaveLength(1);
            await truncateAll();
            expect(await ownerDb("help_articles").count("* as n")).toEqual([{ n: 0 }]);
        });

        it("should drop the table with its indexes and grants on down and recreate them identically on up", async () => {
            const definitions = async (): Promise<unknown> => {
                const result = await migrator.raw<{ rows: Array<{ indexname: string; indexdef: string }> }>(
                    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'help_articles' ORDER BY indexname",
                );
                return result.rows;
            };
            const before = await definitions();
            try {
                await helpArticlesMigration.down(migrator);
                expect(await present()).toBeNull();
                await helpArticlesMigration.down(migrator); // IF EXISTS: a second down is a no-op
            } finally {
                await helpArticlesMigration.up(migrator);
            }
            expect(await present()).toBe("help_articles");
            expect(await definitions()).toEqual(before);
            const grants = await migrator.raw<{ rows: Array<{ del: boolean; upd: boolean; seq: boolean }> }>(
                `SELECT has_table_privilege('vcare_app', 'help_articles', 'DELETE') AS del,
                        has_table_privilege('vcare_app', 'help_articles', 'UPDATE') AS upd,
                        has_sequence_privilege('vcare_app', 'help_articles_id_seq', 'USAGE') AS seq`,
            );
            expect(grants.rows[0]).toEqual({ del: false, upd: true, seq: true });
            // The app login can write to the recreated table (grants were re-applied).
            await expect(db("help_articles").insert(baseRow())).resolves.toBeDefined();
            expect(await ownerDb("help_articles").count("* as n")).toEqual([{ n: 1 }]);
        });
    });
});
