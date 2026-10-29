import type { HelpArticle, HelpArticleSummary } from "../entity/help-articles.entity";
import type { HelpArticleAudience, HelpArticleCategory } from "../enums";

/** Not viewer-aware: help articles carry no clinical field, so every role receives the same shape. */
export class HelpArticleResponseDto {
    id!: number;
    title!: string;
    body!: string;
    category!: HelpArticleCategory;
    audience!: HelpArticleAudience;
    isPublished!: boolean;
    publishedAt!: string | null;
    createdAt!: string;
    updatedAt!: string;

    static from(entity: HelpArticle): HelpArticleResponseDto {
        const response = new HelpArticleResponseDto();
        response.id = entity.id;
        response.title = entity.title;
        response.body = entity.body;
        response.category = entity.category;
        response.audience = entity.audience;
        response.isPublished = entity.isPublished;
        response.publishedAt = entity.publishedAt === null ? null : entity.publishedAt.toISOString();
        response.createdAt = entity.createdAt.toISOString();
        response.updatedAt = entity.updatedAt.toISOString();
        return response;
    }
}

export class HelpArticleSummaryResponseDto {
    id!: number;
    title!: string;
    category!: HelpArticleCategory;
    audience!: HelpArticleAudience;
    isPublished!: boolean;
    publishedAt!: string | null;
    updatedAt!: string;

    static from(entity: HelpArticleSummary): HelpArticleSummaryResponseDto {
        const response = new HelpArticleSummaryResponseDto();
        response.id = entity.id;
        response.title = entity.title;
        response.category = entity.category;
        response.audience = entity.audience;
        response.isPublished = entity.isPublished;
        response.publishedAt = entity.publishedAt === null ? null : entity.publishedAt.toISOString();
        response.updatedAt = entity.updatedAt.toISOString();
        return response;
    }
}
