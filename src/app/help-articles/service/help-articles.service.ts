import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { Forbidden, NotFound } from "../../../lib/error/errors";
import { decodeKindedTimestampCursor } from "../../../lib/http/pagination/cursor";
import { buildPage, resolveLimit } from "../../../lib/http/pagination/page";
import type { Page } from "../../../lib/http/pagination/types";
import { uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { AuthContext, Role } from "../../../lib/types/types";
import { CURSOR_KIND_PUBLISHED, CURSOR_KIND_UPDATED, HELP_ARTICLE_ENTITY_TYPE, HELP_ARTICLE_TITLE_CONSTRAINT } from "../constants";
import type { ListHelpArticlesQueryDto } from "../dto/help-articles.request.dto";
import type { HelpArticle, HelpArticleSummary } from "../entity/help-articles.entity";
import { HelpArticleAudience, HelpArticleAuditAction, HelpArticleField } from "../enums";
import { HelpArticleTitleTaken } from "../errors";
import {
    findLiveHelpArticleForUpdate,
    findVisibleHelpArticle,
    insertHelpArticle,
    listHelpArticles,
    softDeleteHelpArticle,
    updateHelpArticle,
} from "../repository/help-articles.repo";
import type { HelpArticleChanges, HelpArticleCreateInput, HelpArticleDiff, HelpArticleListScope, HelpArticleVisibility } from "../types";

@injectable()
export class HelpArticlesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
    ) {}

    async list(viewer: AuthContext, query: ListHelpArticlesQueryDto): Promise<Page<HelpArticleSummary>> {
        const limit = resolveLimit(query.limit);
        const isAdmin = viewer.role === "admin";
        // Readers page by publication time and always see their own audience's published articles; `audience` and
        // `isPublished` are admin filters and are ignored for everyone else (HA-D10).
        const kind = isAdmin ? CURSOR_KIND_UPDATED : CURSOR_KIND_PUBLISHED;
        const scope: HelpArticleListScope = isAdmin
            ? { kind: "admin", audience: query.audience, category: query.category, isPublished: query.isPublished }
            : { kind: "reader", audience: this.audienceOf(viewer.role), category: query.category };
        const after = query.cursor === undefined ? null : decodeKindedTimestampCursor(query.cursor, kind);
        const entries = await listHelpArticles({ scope, after, fetch: limit + 1 }, this.db);
        const page = buildPage(entries, limit, (entry) => [`${kind}:${entry.sortCursor}`, entry.summary.id]);
        return { items: page.items.map((entry) => entry.summary), meta: page.meta };
    }

    async get(viewer: AuthContext, id: number): Promise<HelpArticle> {
        const visibility: HelpArticleVisibility = viewer.role === "admin"
            ? { kind: "admin" }
            : { kind: "reader", audience: this.audienceOf(viewer.role) };
        const article = await findVisibleHelpArticle(id, visibility, this.db);
        if (article === undefined) throw NotFound;
        return article;
    }

    async create(actor: AuthContext, input: HelpArticleCreateInput): Promise<HelpArticle> {
        try {
            return await this.db.transaction(async (trx) => {
                const created = await insertHelpArticle(input, actor.userId, trx);
                await this.audit.record(trx, {
                    actor: actorFromAuth(actor),
                    action: HelpArticleAuditAction.Created,
                    entityType: HELP_ARTICLE_ENTITY_TYPE,
                    entityId: created.id,
                    metadata: { isPublishedBefore: null, isPublishedAfter: created.isPublished },
                });
                return created;
            });
        } catch (error) {
            throw this.toConflict(error);
        }
    }

    async update(actor: AuthContext, id: number, changes: HelpArticleChanges): Promise<HelpArticle> {
        try {
            return await this.db.transaction(async (trx) => {
                const current = await findLiveHelpArticleForUpdate(id, trx);
                if (current === undefined) throw NotFound;
                const diff = this.diff(current, changes);
                // A no-op is not a write: no UPDATE, no updated_at change, no audit row (HA-D9).
                if (diff.fields.length === 0) return current;
                const updated = await updateHelpArticle(id, diff.columns, actor.userId, trx);
                await this.audit.record(trx, {
                    actor: actorFromAuth(actor),
                    action: HelpArticleAuditAction.Updated,
                    entityType: HELP_ARTICLE_ENTITY_TYPE,
                    entityId: id,
                    metadata: {
                        changedFields: diff.fields.join(","),
                        isPublishedBefore: current.isPublished,
                        isPublishedAfter: updated.isPublished,
                    },
                });
                return updated;
            });
        } catch (error) {
            throw this.toConflict(error);
        }
    }

    async remove(actor: AuthContext, id: number): Promise<void> {
        await this.db.transaction(async (trx) => {
            const current = await findLiveHelpArticleForUpdate(id, trx);
            if (current === undefined) throw NotFound;
            await softDeleteHelpArticle(id, actor.userId, trx);
            await this.audit.record(trx, {
                actor: actorFromAuth(actor),
                action: HelpArticleAuditAction.Deleted,
                entityType: HELP_ARTICLE_ENTITY_TYPE,
                entityId: id,
                // null = no longer visible to anyone.
                metadata: { isPublishedBefore: current.isPublished, isPublishedAfter: null },
            });
        });
    }

    /** A patient reads patient articles and a doctor reads doctor articles (Care rule R5). Admins never reach this. */
    private audienceOf(role: Role): HelpArticleAudience {
        if (role === "patient") return HelpArticleAudience.Patient;
        if (role === "doctor") return HelpArticleAudience.Doctor;
        throw Forbidden;
    }

    /** A field counts as changed only when provided and different from the stored value (HA-D9). */
    private diff(current: HelpArticle, changes: HelpArticleChanges): HelpArticleDiff {
        const fields: HelpArticleField[] = [];
        const columns: HelpArticleDiff["columns"] = {};
        if (changes.title !== undefined && changes.title !== current.title) {
            fields.push(HelpArticleField.Title);
            columns.title = changes.title;
        }
        if (changes.body !== undefined && changes.body !== current.body) {
            fields.push(HelpArticleField.Body);
            columns.body = changes.body;
        }
        if (changes.category !== undefined && changes.category !== current.category) {
            fields.push(HelpArticleField.Category);
            columns.category = changes.category;
        }
        if (changes.audience !== undefined && changes.audience !== current.audience) {
            fields.push(HelpArticleField.Audience);
            columns.audience = changes.audience;
        }
        if (changes.isPublished !== undefined && changes.isPublished !== current.isPublished) {
            fields.push(HelpArticleField.IsPublished);
            columns.is_published = changes.isPublished;
        }
        fields.sort();
        return { fields, columns };
    }

    private toConflict(error: unknown): unknown {
        return uniqueViolationConstraint(error) === HELP_ARTICLE_TITLE_CONSTRAINT ? HelpArticleTitleTaken : error;
    }
}
