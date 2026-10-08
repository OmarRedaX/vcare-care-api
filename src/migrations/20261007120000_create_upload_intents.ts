import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE upload_intents (
        id BIGSERIAL PRIMARY KEY,
        kind VARCHAR(32) NOT NULL,
        target_id BIGINT NOT NULL,
        owner_user_id BIGINT NOT NULL, -- Identity user id; no FK
        document_type VARCHAR(16),
        description VARCHAR(500),
        quarantine_key VARCHAR(512) NOT NULL,
        max_bytes INT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        result_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_upload_intents_quarantine_key UNIQUE (quarantine_key),
        CONSTRAINT chk_upload_intents_kind CHECK (kind IN ('verification_document','record_attachment')),
        CONSTRAINT chk_upload_intents_document_type CHECK ((kind='verification_document' AND document_type IN ('license','id','degree') AND description IS NULL) OR (kind='record_attachment' AND document_type IS NULL)),
        CONSTRAINT chk_upload_intents_max_bytes CHECK (max_bytes BETWEEN 1 AND 10485760),
        CONSTRAINT chk_upload_intents_result CHECK (result_id IS NULL OR consumed_at IS NOT NULL)
    );`);
    // Purge: open expired intents ORDER BY expires_at LIMIT 500.
    await knex.raw(`CREATE INDEX idx_upload_intents_expires_at_open ON upload_intents (expires_at) WHERE consumed_at IS NULL;`);
    // Purge: rows older than seven days.
    await knex.raw(`CREATE INDEX idx_upload_intents_created_at ON upload_intents (created_at);`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON upload_intents TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE upload_intents_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_upload_intents_created_at;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_upload_intents_expires_at_open;`);
    await knex.raw(`DROP TABLE IF EXISTS upload_intents;`);
}
