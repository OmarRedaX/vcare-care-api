import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE verification_documents (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        type VARCHAR(16) NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        file_type VARCHAR(32) NOT NULL,
        size_bytes INT NOT NULL,
        status VARCHAR(16) NOT NULL,
        reviewed_by BIGINT, -- Identity user id; no FK
        review_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_verification_documents_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT uq_verification_documents_object_key UNIQUE (object_key),
        CONSTRAINT chk_verification_documents_type CHECK (type IN ('license','id','degree')),
        CONSTRAINT chk_verification_documents_file_type CHECK (file_type IN ('application/pdf','image/jpeg','image/png')),
        CONSTRAINT chk_verification_documents_size CHECK (size_bytes BETWEEN 1 AND 10485760),
        CONSTRAINT chk_verification_documents_status CHECK (status IN ('uploaded','accepted','rejected'))
    );`);
    // Application detail, submission precondition, and document-owner lookup; covers profile FK.
    await knex.raw(`CREATE INDEX idx_verification_documents_doctor_profile_id_type ON verification_documents (doctor_profile_id, type) WHERE deleted_at IS NULL;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON verification_documents TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE verification_documents_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS verification_documents;`);
}
