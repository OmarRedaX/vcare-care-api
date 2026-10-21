import type { Knex } from "knex";

/**
 * record_attachments: a file attached to a medical record by its author (record-attachments spec 3.1). Soft delete only; the row
 * exists only after `complete` verified the stored object (ADR 0013). The 24 h lock for REMOVAL is enforced in the database by a
 * BEFORE UPDATE trigger that reads the parent record's locked_at on the deleted_at NULL -> NOT NULL transition; adding is allowed
 * after the lock (append-only) and never updates medical_records. The app role gets column-level grants (ADR 0018): it can read,
 * append six columns and set deleted_at; no DELETE, no TRUNCATE, no other UPDATE. Clinical table: no ON DELETE CASCADE.
 * The function body is free of the question-mark character: knex.raw would read a bare one as a binding.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE record_attachments (
        id BIGSERIAL PRIMARY KEY,
        medical_record_id BIGINT NOT NULL,
        uploaded_by_user_id BIGINT NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        file_type VARCHAR(32) NOT NULL,
        size_bytes INT NOT NULL,
        description VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_record_attachments_medical_record_id FOREIGN KEY (medical_record_id) REFERENCES medical_records(id) ON DELETE RESTRICT,
        CONSTRAINT uq_record_attachments_object_key UNIQUE (object_key),
        CONSTRAINT chk_record_attachments_file_type CHECK (file_type IN ('application/pdf', 'image/jpeg', 'image/png')),
        CONSTRAINT chk_record_attachments_size CHECK (size_bytes BETWEEN 1 AND 10485760),
        CONSTRAINT chk_record_attachments_description CHECK (description IS NULL OR btrim(description) <> '')
    );`);
    await knex.raw(`COMMENT ON TABLE record_attachments IS 'File attached to a medical record by its author; soft delete only, refused once the record is locked; the object is kept';`);
    await knex.raw(`COMMENT ON COLUMN record_attachments.uploaded_by_user_id IS 'Identity user id (always the record''s author)';`);
    await knex.raw(`COMMENT ON COLUMN record_attachments.object_key IS 'Storage key; never a URL; never logged';`);
    await knex.raw(`COMMENT ON COLUMN record_attachments.description IS 'Clinical free text; never logged';`);

    // Record view, timeline page and PATCH 200: the live attachments of a page of records in ONE query
    //   SELECT <summary columns> FROM record_attachments WHERE medical_record_id = ANY($1) AND deleted_at IS NULL ORDER BY id
    // the cap count   SELECT count(*) FROM record_attachments WHERE medical_record_id = $1 AND deleted_at IS NULL
    // and the leading-column index of fk_record_attachments_medical_record_id.
    await knex.raw(`CREATE INDEX idx_record_attachments_medical_record_id ON record_attachments (medical_record_id, id) WHERE deleted_at IS NULL;`);

    // The 24 h lock for removal, in the database: a soft delete (deleted_at going NULL -> NOT NULL) is refused once the PARENT record is
    // locked. Same clock as the service (the transaction's NOW()); CONSTRAINT lets the service recognize the refusal by error.constraint.
    await knex.raw(`CREATE OR REPLACE FUNCTION forbid_attachment_delete_after_lock() RETURNS trigger AS $$
        DECLARE
            parent_locked_at TIMESTAMPTZ;
        BEGIN
            IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
                SELECT locked_at INTO parent_locked_at FROM medical_records WHERE id = OLD.medical_record_id;
                IF parent_locked_at <= NOW() THEN
                    RAISE EXCEPTION 'record % is locked; attachment % cannot be removed', OLD.medical_record_id, OLD.id
                        USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_record_attachments_forbid_delete_after_lock';
                END IF;
            END IF;
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql;`);
    await knex.raw(`CREATE TRIGGER trg_record_attachments_forbid_delete_after_lock
        BEFORE UPDATE ON record_attachments FOR EACH ROW EXECUTE FUNCTION forbid_attachment_delete_after_lock();`);

    // ADR 0018, column level: the app role can read, append six columns, and set deleted_at. No DELETE, no TRUNCATE, no other UPDATE.
    await knex.raw(`GRANT SELECT ON record_attachments TO vcare_app;`);
    await knex.raw(`GRANT INSERT (medical_record_id, uploaded_by_user_id, object_key, file_type, size_bytes, description) ON record_attachments TO vcare_app;`);
    await knex.raw(`GRANT UPDATE (deleted_at) ON record_attachments TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE record_attachments_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    // Dropping the table drops its indexes and trigger; the function goes after it.
    await knex.raw(`DROP TABLE IF EXISTS record_attachments;`);
    await knex.raw(`DROP FUNCTION IF EXISTS forbid_attachment_delete_after_lock();`);
}
