export const HELP_ARTICLE_TITLE_MIN_LENGTH = 3;
export const HELP_ARTICLE_TITLE_MAX_LENGTH = 200;
export const HELP_ARTICLE_BODY_MIN_LENGTH = 1;
export const HELP_ARTICLE_BODY_MAX_LENGTH = 50_000;

export const HELP_ARTICLES_READ_USER_LIMIT = 120;
export const HELP_ARTICLES_WRITE_USER_LIMIT = 20;
export const HELP_ARTICLES_RATE_WINDOW_MS = 60_000;
export const HELP_ARTICLES_READ_RATE_NAME = "help-articles-read-user";
export const HELP_ARTICLES_WRITE_RATE_NAME = "help-articles-write";

export const HELP_ARTICLE_ENTITY_TYPE = "help_article";
export const HELP_ARTICLE_TITLE_CONSTRAINT = "uq_help_articles_audience_title";

/** Sort kind carried inside a list cursor: readers page by `published_at`, admins by `updated_at`. */
export const CURSOR_KIND_PUBLISHED = "published";
export const CURSOR_KIND_UPDATED = "updated";
