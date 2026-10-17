import type { Knex } from "knex";

/**
 * medical_record_amendments: the append-only corrections of a locked record (records spec 2.2). Append-only is a GRANT: SELECT and a
 * column-level INSERT, so the app can never set id or created_at and holds no UPDATE, DELETE or TRUNCATE (ADR 0018).
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE medical_record_amendments (
        id BIGSERIAL PRIMARY KEY,
        medical_record_id BIGINT NOT NULL,
        author_user_id BIGINT NOT NULL,
        chief_complaint TEXT,
        examination_notes TEXT,
        diagnosis_text TEXT,
        diagnosis_code VARCHAR(16),
        treatment_plan TEXT,
        follow_up_in_days INT,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_medical_record_amendments_medical_record_id FOREIGN KEY (medical_record_id) REFERENCES medical_records(id) ON DELETE RESTRICT,
        CONSTRAINT chk_medical_record_amendments_nonempty CHECK (
            chief_complaint IS NOT NULL OR examination_notes IS NOT NULL OR diagnosis_text IS NOT NULL
         OR diagnosis_code IS NOT NULL OR treatment_plan IS NOT NULL OR follow_up_in_days IS NOT NULL),
        CONSTRAINT chk_medical_record_amendments_follow_up CHECK (follow_up_in_days IS NULL OR follow_up_in_days BETWEEN 1 AND 365),
        CONSTRAINT chk_medical_record_amendments_diagnosis_code CHECK (diagnosis_code IS NULL OR diagnosis_code ~ '^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})\\?$')
    );`);
    await knex.raw(`COMMENT ON TABLE medical_record_amendments IS 'Append-only corrections of a locked medical record; the original row is never touched';`);
    await knex.raw(`COMMENT ON COLUMN medical_record_amendments.author_user_id IS 'Identity user id';`);
    for (const column of ["chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code", "treatment_plan", "reason"]) {
        await knex.raw(`COMMENT ON COLUMN medical_record_amendments.${column} IS 'Clinical; never logged';`);
    }

    // The record view and the timeline load the amendments of a whole page in ONE query:
    //   SELECT ... FROM medical_record_amendments WHERE medical_record_id = ANY($1) ORDER BY created_at, id
    // (also the index of fk_medical_record_amendments_medical_record_id)
    await knex.raw(`CREATE INDEX idx_medical_record_amendments_medical_record_id_created_at ON medical_record_amendments (medical_record_id, created_at, id);`);

    await knex.raw(`GRANT SELECT ON medical_record_amendments TO vcare_app;`);
    await knex.raw(`GRANT INSERT (medical_record_id, author_user_id, chief_complaint, examination_notes, diagnosis_text, diagnosis_code, treatment_plan, follow_up_in_days, reason)
        ON medical_record_amendments TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE medical_record_amendments_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS medical_record_amendments;`);
}
