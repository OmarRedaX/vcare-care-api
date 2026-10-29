import type { HelpArticleAudience, HelpArticleCategory } from "../enums";

export class HelpArticle {
    id!: number;
    title!: string;
    body!: string;
    category!: HelpArticleCategory;
    audience!: HelpArticleAudience;
    isPublished!: boolean;
    publishedAt!: Date | null;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<HelpArticle>) {
        Object.assign(this, data);
    }
}

/** A list item: it has no `body` member, so a list cannot leak the text by accident. */
export class HelpArticleSummary {
    id!: number;
    title!: string;
    category!: HelpArticleCategory;
    audience!: HelpArticleAudience;
    isPublished!: boolean;
    publishedAt!: Date | null;
    updatedAt!: Date;

    constructor(data: Partial<HelpArticleSummary>) {
        Object.assign(this, data);
    }
}
