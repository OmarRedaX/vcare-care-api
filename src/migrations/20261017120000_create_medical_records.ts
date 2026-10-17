import type { Knex } from "knex";

/**
 * medical_records: the clinical record of one completed consultation (records spec 2.1). Soft delete only; locked 24 h after
 * creation. The lock is a CHECK (locked_at = created_at + 24 h, both from the transaction NOW()) plus a BEFORE UPDATE
 * trigger that refuses every later update, a soft delete included. The app role holds no DELETE and no TRUNCATE.
 * The diagnosis-code regex escapes its question mark in the template: knex.raw would otherwise read a bare one as a binding.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE medical_records (
        id BIGSERIAL PRIMARY KEY,
        consultation_id BIGINT NOT NULL,
        patient_user_id BIGINT NOT NULL,
        doctor_user_id BIGINT NOT NULL,
        chief_complaint TEXT NOT NULL,
        examination_notes TEXT,
        diagnosis_text TEXT,
        diagnosis_code VARCHAR(16),
        treatment_plan TEXT,
        follow_up_in_days INT,
        locked_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_medical_records_consultation_id FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE RESTRICT,
        CONSTRAINT chk_medical_records_lock CHECK (locked_at = created_at + interval '24 hours'),
        CONSTRAINT chk_medical_records_follow_up CHECK (follow_up_in_days IS NULL OR follow_up_in_days BETWEEN 1 AND 365),
        CONSTRAINT chk_medical_records_diagnosis_code CHECK (diagnosis_code IS NULL OR diagnosis_code ~ '^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})\\?$')
    );`);
    await knex.raw(`COMMENT ON TABLE medical_records IS 'Clinical record of one completed consultation; soft delete only; locked 24 h after creation';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.patient_user_id IS 'Identity user id (copied from the consultation)';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.doctor_user_id IS 'Identity user id (copied from the consultation)';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.chief_complaint IS 'Clinical; never logged';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.examination_notes IS 'Clinical; never logged';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.diagnosis_text IS 'Clinical; never logged';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.diagnosis_code IS 'Clinical; never logged';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.treatment_plan IS 'Clinical; never logged';`);
    await knex.raw(`COMMENT ON COLUMN medical_records.locked_at IS 'created_at + 24 h, set from database time';`);

    // Domain rule 13: one live record per consultation. Serves (1) the create gate duplicate check
    //   SELECT id FROM medical_records WHERE consultation_id = $1 AND deleted_at IS NULL
    // (2) the hasRecord batch  SELECT consultation_id FROM medical_records WHERE consultation_id = ANY($1) AND deleted_at IS NULL
    // (3) the concurrent-create guarantee (23505 -> 409 Conflict); also the index of fk_medical_records_consultation_id.
    await knex.raw(`CREATE UNIQUE INDEX uq_medical_records_consultation_id ON medical_records (consultation_id) WHERE deleted_at IS NULL;`);
    // Patient timeline GET /api/patients/{patientUserId}/records, keyset newest first:
    //   WHERE patient_user_id = $1 AND deleted_at IS NULL [AND (created_at, id) < ($t, $id)] ORDER BY created_at DESC, id DESC LIMIT $n + 1
    await knex.raw(`CREATE INDEX idx_medical_records_patient_user_id_created_at_id ON medical_records (patient_user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;`);

    // The 24 h lock, in the database (clinical-records.md): any UPDATE once locked_at <= NOW() is refused. The CONSTRAINT option lets the
    // service recognize the refusal by error.constraint (checkViolationConstraint) instead of parsing a message.
    await knex.raw(`CREATE OR REPLACE FUNCTION forbid_update_after_lock() RETURNS trigger AS $$
        BEGIN
            IF OLD.locked_at <= NOW() THEN
                RAISE EXCEPTION 'record % is locked', OLD.id
                    USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_medical_records_forbid_update_after_lock';
            END IF;
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql;`);
    await knex.raw(`CREATE TRIGGER trg_medical_records_forbid_update_after_lock
        BEFORE UPDATE ON medical_records FOR EACH ROW EXECUTE FUNCTION forbid_update_after_lock();`);

    // ADR 0018: explicit grants, no DELETE, no TRUNCATE.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON medical_records TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE medical_records_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    // Dropping the table drops its trigger; the amendments and follow-up FK migrations roll back first.
    await knex.raw(`DROP TABLE IF EXISTS medical_records;`);
    await knex.raw(`DROP FUNCTION IF EXISTS forbid_update_after_lock();`);
}
