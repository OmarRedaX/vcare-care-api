import type { StringCursorPosition } from "../../lib/http/pagination/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { HelpArticleSummary } from "./entity/help-articles.entity";
import type { HelpArticleAudience, HelpArticleCategory, HelpArticleField } from "./enums";

export interface HelpArticleRow {
    id: number;
    title: string;
    body: string;
    category: HelpArticleCategory;
    audience: HelpArticleAudience;
    is_published: boolean;
    published_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface HelpArticleSummaryRow {
    id: number;
    title: string;
    category: HelpArticleCategory;
    audience: HelpArticleAudience;
    is_published: boolean;
    published_at: Date | null;
    updated_at: Date;
    /** The sort column at microsecond precision (`timestampCursorSelect`); never travels through a JS Date. */
    sort_cursor: string;
}

/** One list row: the summary entity plus the sort column at microsecond precision (the service turns it into a cursor). */
export interface HelpArticleListEntry {
    summary: HelpArticleSummary;
    sortCursor: string;
}

export type HelpArticleListScope =
    | { kind: "reader"; audience: HelpArticleAudience; category?: HelpArticleCategory }
    | { kind: "admin"; audience?: HelpArticleAudience; category?: HelpArticleCategory; isPublished?: boolean };

export interface ListHelpArticlesParams {
    scope: HelpArticleListScope;
    /** `sortValue` is the bare microsecond timestamp (the kind prefix is already stripped). */
    after: StringCursorPosition | null;
    fetch: number;
}

export type HelpArticleVisibility = { kind: "reader"; audience: HelpArticleAudience } | { kind: "admin" };

export interface HelpArticleCreateInput {
    title: string;
    body: string;
    category: HelpArticleCategory;
    audience: HelpArticleAudience;
    isPublished: boolean;
}

export interface HelpArticleChanges {
    title?: string;
    body?: string;
    category?: HelpArticleCategory;
    audience?: HelpArticleAudience;
    isPublished?: boolean;
}

export interface HelpArticleColumnChanges {
    title?: string;
    body?: string;
    category?: HelpArticleCategory;
    audience?: HelpArticleAudience;
    is_published?: boolean;
}

export interface HelpArticleDiff {
    fields: HelpArticleField[];
    columns: HelpArticleColumnChanges;
}

export type HelpArticlesRoute = "list" | "get" | "create" | "update" | "remove";
export type HelpArticlesPolicies = Readonly<Record<HelpArticlesRoute, UserPolicy>>;
