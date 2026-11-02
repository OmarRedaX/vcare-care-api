import { IsBoolean, IsEnum, IsOptional, IsString, ValidateIf } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { CodePointLength, NoControlCharacters } from "../../../lib/validation/string-decorators";
import { ToBoolean } from "../../../lib/validation/transforms";
import {
    HELP_ARTICLE_BODY_MAX_LENGTH,
    HELP_ARTICLE_BODY_MIN_LENGTH,
    HELP_ARTICLE_TITLE_MAX_LENGTH,
    HELP_ARTICLE_TITLE_MIN_LENGTH,
} from "../constants";
import { HelpArticleAudience, HelpArticleCategory } from "../enums";
import type { HelpArticleChanges, HelpArticleCreateInput } from "../types";

export class ListHelpArticlesQueryDto extends PaginationQueryDto {
    @IsOptional()
    @IsEnum(HelpArticleCategory)
    category?: HelpArticleCategory;

    /** Validated for every role, applied only for admins (HA-D10). */
    @IsOptional()
    @IsEnum(HelpArticleAudience)
    audience?: HelpArticleAudience;

    /** Validated for every role, applied only for admins (HA-D10). */
    @IsOptional()
    @ToBoolean()
    @IsBoolean()
    isPublished?: boolean;
}

export class CreateHelpArticleDto {
    @IsString()
    @CodePointLength(HELP_ARTICLE_TITLE_MIN_LENGTH, HELP_ARTICLE_TITLE_MAX_LENGTH)
    @NoControlCharacters("all")
    title!: string;

    /** Markdown: newlines and tabs are valid; only NUL is refused (Postgres cannot store it). Never trimmed. */
    @IsString()
    @CodePointLength(HELP_ARTICLE_BODY_MIN_LENGTH, HELP_ARTICLE_BODY_MAX_LENGTH)
    @NoControlCharacters("nul")
    body!: string;

    @IsEnum(HelpArticleCategory)
    category!: HelpArticleCategory;

    @IsEnum(HelpArticleAudience)
    audience!: HelpArticleAudience;

    @IsBoolean()
    isPublished!: boolean;

    toInput(): HelpArticleCreateInput {
        return { title: this.title, body: this.body, category: this.category, audience: this.audience, isPublished: this.isPublished };
    }
}

export class UpdateHelpArticleDto {
    @ValidateIf((_object, value) => value !== undefined)
    @IsString()
    @CodePointLength(HELP_ARTICLE_TITLE_MIN_LENGTH, HELP_ARTICLE_TITLE_MAX_LENGTH)
    @NoControlCharacters("all")
    title?: string;

    @ValidateIf((_object, value) => value !== undefined)
    @IsString()
    @CodePointLength(HELP_ARTICLE_BODY_MIN_LENGTH, HELP_ARTICLE_BODY_MAX_LENGTH)
    @NoControlCharacters("nul")
    body?: string;

    @ValidateIf((_object, value) => value !== undefined)
    @IsEnum(HelpArticleCategory)
    category?: HelpArticleCategory;

    @ValidateIf((_object, value) => value !== undefined)
    @IsEnum(HelpArticleAudience)
    audience?: HelpArticleAudience;

    @ValidateIf((_object, value) => value !== undefined)
    @IsBoolean()
    isPublished?: boolean;

    /** An empty PATCH has no defined member, even though class fields may exist as undefined. */
    isEmpty(): boolean {
        return this.title === undefined && this.body === undefined && this.category === undefined &&
            this.audience === undefined && this.isPublished === undefined;
    }

    toChanges(): HelpArticleChanges {
        const changes: HelpArticleChanges = {};
        if (this.title !== undefined) changes.title = this.title;
        if (this.body !== undefined) changes.body = this.body;
        if (this.category !== undefined) changes.category = this.category;
        if (this.audience !== undefined) changes.audience = this.audience;
        if (this.isPublished !== undefined) changes.isPublished = this.isPublished;
        return changes;
    }
}
