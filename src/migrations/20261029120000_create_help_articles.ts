import type { Knex } from "knex";

/**
 * help_articles: admin-authored Markdown help center content and the Phase-2 RAG corpus (help-articles spec 2.2, ADR 0027). Not clinical
 * data. Soft delete only: the app role gets SELECT, INSERT and UPDATE (plus the sequence) and no DELETE, no TRUNCATE (ADR 0018, explicit
 * grants). `created_by` / `updated_by` are Identity user ids with no FK. The function body is free of the question-mark character:
 * knex.raw would read a bare one as a binding.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE help_articles (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        category VARCHAR(32) NOT NULL,
        audience VARCHAR(16) NOT NULL,
        is_published BOOLEAN NOT NULL,
        published_at TIMESTAMPTZ,
        created_by BIGINT NOT NULL,
        updated_by BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT chk_help_articles_category CHECK (category IN ('how-it-works', 'preparing-for-consultation', 'cancellation-policy', 'platform-rules')),
        CONSTRAINT chk_help_articles_audience CHECK (audience IN ('patient', 'doctor')),
        CONSTRAINT chk_help_articles_published CHECK (NOT is_published OR published_at IS NOT NULL),
        CONSTRAINT chk_help_articles_title_length CHECK (char_length(title) >= 3),
        CONSTRAINT chk_help_articles_body_length CHECK (char_length(body) BETWEEN 1 AND 50000)
    );`);
    await knex.raw(`COMMENT ON TABLE help_articles IS 'Admin-authored help center articles (Markdown) and the Phase-2 RAG corpus. Soft delete only (vcare_app has no DELETE). Not clinical data.';`);
    await knex.raw(`COMMENT ON COLUMN help_articles.body IS 'Markdown, stored and returned verbatim; never logged';`);
    await knex.raw(`COMMENT ON COLUMN help_articles.published_at IS 'Set on the first publish and kept when the article is unpublished';`);
    await knex.raw(`COMMENT ON COLUMN help_articles.created_by IS 'Identity user id (admin); no FK';`);
    await knex.raw(`COMMENT ON COLUMN help_articles.updated_by IS 'Identity user id (admin); no FK';`);

    // Non-admin list GET /help-articles[?category=]:
    //   SELECT <summary columns> FROM help_articles WHERE audience = $1 AND is_published = true AND deleted_at IS NULL
    //   [AND category = $2] [AND (published_at, id) < ($3::timestamptz, $4::bigint)] ORDER BY published_at DESC, id DESC LIMIT $n
    await knex.raw(`CREATE INDEX idx_help_articles_audience_published_at_id ON help_articles (audience, published_at DESC, id DESC)
        WHERE is_published AND deleted_at IS NULL;`);

    // Admin list GET /help-articles[?audience=&category=&isPublished=]:
    //   SELECT <summary columns> FROM help_articles WHERE deleted_at IS NULL [AND ...filters...]
    //   [AND (updated_at, id) < ($1::timestamptz, $2::bigint)] ORDER BY updated_at DESC, id DESC LIMIT $n
    await knex.raw(`CREATE INDEX idx_help_articles_updated_at_id ON help_articles (updated_at DESC, id DESC) WHERE deleted_at IS NULL;`);

    // Unique live title per audience (POST and PATCH): a clash raises 23505 on this name, which the service maps to 409 Conflict.
    // A partial unique cannot be a table constraint, so it is a unique index; Postgres reports its name as error.constraint.
    await knex.raw(`CREATE UNIQUE INDEX uq_help_articles_audience_title ON help_articles (audience, title) WHERE deleted_at IS NULL;`);

    // ADR 0018: explicit grants, no DELETE and no TRUNCATE (soft delete only).
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON help_articles TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE help_articles_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    // Dropping the table drops its indexes and grants.
    await knex.raw(`DROP TABLE IF EXISTS help_articles;`);
}
