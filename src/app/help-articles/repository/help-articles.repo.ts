import type { Knex } from "knex";
import { timestampCursorSelect } from "../../../lib/http/pagination/timestamp-cursor";
import { db } from "../../../lib/knex/knex";
import { HelpArticle, HelpArticleSummary } from "../entity/help-articles.entity";
import type {
    HelpArticleColumnChanges,
    HelpArticleCreateInput,
    HelpArticleListEntry,
    HelpArticleRow,
    HelpArticleSummaryRow,
    HelpArticleVisibility,
    ListHelpArticlesParams,
} from "../types";

/** Every read below filters `deleted_at IS NULL`: a deleted article is invisible to everyone (HA-D4). `created_by`/`updated_by` never leave the table. */
export const HELP_ARTICLE_COLUMNS = ["id", "title", "body", "category", "audience", "is_published", "published_at", "created_at", "updated_at"] as const;
export const HELP_ARTICLE_SUMMARY_COLUMNS = ["id", "title", "category", "audience", "is_published", "published_at", "updated_at"] as const;

function toEntity(row: HelpArticleRow): HelpArticle {
    return new HelpArticle({
        id: row.id,
        title: row.title,
        body: row.body,
        category: row.category,
        audience: row.audience,
        isPublished: row.is_published,
        publishedAt: row.published_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

function toSummary(row: HelpArticleSummaryRow): HelpArticleSummary {
    return new HelpArticleSummary({
        id: row.id,
        title: row.title,
        category: row.category,
        audience: row.audience,
        isPublished: row.is_published,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
    });
}

/**
 * The keyset page query, exported so an EXPLAIN test inspects exactly what runs.
 * Reader: published, live, own audience, `published_at DESC, id DESC` (idx_help_articles_audience_published_at_id).
 * Admin: every live article, `updated_at DESC, id DESC` (idx_help_articles_updated_at_id).
 */
export function listHelpArticlesQuery(
    params: ListHelpArticlesParams,
    conn: Knex = db,
): Knex.QueryBuilder<HelpArticleSummaryRow, HelpArticleSummaryRow[]> {
    const { scope, after } = params;
    const sortColumn = scope.kind === "reader" ? "published_at" : "updated_at";
    const query = conn<HelpArticleSummaryRow>("help_articles")
        .select<HelpArticleSummaryRow[]>(...HELP_ARTICLE_SUMMARY_COLUMNS, timestampCursorSelect(conn, sortColumn, "sort_cursor"))
        .whereNull("deleted_at");
    if (scope.kind === "reader") {
        query.where("audience", scope.audience).where("is_published", true);
    } else {
        if (scope.audience !== undefined) query.where("audience", scope.audience);
        if (scope.isPublished !== undefined) query.where("is_published", scope.isPublished);
    }
    if (scope.category !== undefined) query.where("category", scope.category);
    if (after !== null) {
        query.whereRaw(`(${sortColumn}, id) < (?::timestamptz, ?::bigint)`, [after.sortValue, after.id]);
    }
    return query.orderBy(sortColumn, "desc").orderBy("id", "desc").limit(params.fetch);
}

export async function listHelpArticles(params: ListHelpArticlesParams, conn: Knex = db): Promise<HelpArticleListEntry[]> {
    const rows: HelpArticleSummaryRow[] = await listHelpArticlesQuery(params, conn);
    return rows.map((row) => ({ summary: toSummary(row), sortCursor: row.sort_cursor }));
}

/** One statement carrying the visibility predicate; no row means absent, deleted, or not visible to this viewer. */
export async function findVisibleHelpArticle(id: number, visibility: HelpArticleVisibility, conn: Knex = db): Promise<HelpArticle | undefined> {
    const query = conn<HelpArticleRow>("help_articles")
        .select(...HELP_ARTICLE_COLUMNS)
        .where("id", id)
        .whereNull("deleted_at");
    if (visibility.kind === "reader") {
        query.where("audience", visibility.audience).where("is_published", true);
    }
    const row: HelpArticleRow | undefined = await query.first();
    return row === undefined ? undefined : toEntity(row);
}

export async function findLiveHelpArticleForUpdate(id: number, conn: Knex.Transaction): Promise<HelpArticle | undefined> {
    const row: HelpArticleRow | undefined = await conn<HelpArticleRow>("help_articles")
        .select(...HELP_ARTICLE_COLUMNS)
        .where("id", id)
        .whereNull("deleted_at")
        .forUpdate()
        .first();
    return row === undefined ? undefined : toEntity(row);
}

/** `published_at` is stamped by the statement (`now()`) only when the article is created published. */
export async function insertHelpArticle(input: HelpArticleCreateInput, actorUserId: number, conn: Knex.Transaction): Promise<HelpArticle> {
    const rows: HelpArticleRow[] = await conn("help_articles")
        .insert({
            title: input.title,
            body: input.body,
            category: input.category,
            audience: input.audience,
            is_published: input.isPublished,
            published_at: input.isPublished ? conn.fn.now() : null,
            created_by: actorUserId,
            updated_by: actorUserId,
        })
        .returning([...HELP_ARTICLE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("help_article_insert_returned_no_row");
    return toEntity(row);
}

/**
 * Updates the changed columns. A change to `is_published = true` also stamps `published_at = COALESCE(published_at, now())`: the first
 * publish stamps it and a later re-publish keeps the original (O2). Unpublishing leaves `published_at` alone.
 */
export async function updateHelpArticle(
    id: number,
    changes: HelpArticleColumnChanges,
    actorUserId: number,
    conn: Knex.Transaction,
): Promise<HelpArticle> {
    const values: Record<string, unknown> = { ...changes, updated_by: actorUserId, updated_at: conn.fn.now() };
    if (changes.is_published === true) {
        values.published_at = conn.raw("COALESCE(published_at, CURRENT_TIMESTAMP)");
    }
    const rows: HelpArticleRow[] = await conn("help_articles")
        .where("id", id)
        .whereNull("deleted_at")
        .update(values)
        .returning([...HELP_ARTICLE_COLUMNS]);
    const row = rows[0];
    if (row === undefined) throw new Error("help_article_update_returned_no_row");
    return toEntity(row);
}

export async function softDeleteHelpArticle(id: number, actorUserId: number, conn: Knex.Transaction): Promise<void> {
    await conn("help_articles")
        .where("id", id)
        .whereNull("deleted_at")
        .update({ deleted_at: conn.fn.now(), updated_at: conn.fn.now(), updated_by: actorUserId });
}
