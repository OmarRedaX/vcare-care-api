import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE patient_profiles (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        date_of_birth DATE,
        gender VARCHAR(16),
        blood_type VARCHAR(8),
        allergies TEXT[] NOT NULL DEFAULT '{}',
        chronic_conditions TEXT[] NOT NULL DEFAULT '{}',
        timezone VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT chk_patient_profiles_gender CHECK (gender IS NULL OR gender IN ('female','male','other','undisclosed')),
        CONSTRAINT chk_patient_profiles_blood_type CHECK (blood_type IS NULL OR blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
        CONSTRAINT chk_patient_profiles_allergies_len CHECK (cardinality(allergies) <= 50),
        CONSTRAINT chk_patient_profiles_conditions_len CHECK (cardinality(chronic_conditions) <= 50)
    );`);
    await knex.raw(`COMMENT ON TABLE patient_profiles IS 'Clinical patient profile (demographics, allergies, chronic conditions, timezone). One live row per Identity user. Soft delete only; no route sets deleted_at.';`);
    await knex.raw(`COMMENT ON COLUMN patient_profiles.user_id IS 'Identity user id';`);
    await knex.raw(`COMMENT ON COLUMN patient_profiles.date_of_birth IS 'Clinical/PII; never logged';`);
    await knex.raw(`COMMENT ON COLUMN patient_profiles.allergies IS 'Clinical; never logged';`);
    await knex.raw(`COMMENT ON COLUMN patient_profiles.chronic_conditions IS 'Clinical; never logged';`);
    // GET/PATCH /patients/me (and the later GET /patients/:patientUserId): SELECT ... WHERE user_id = $1 AND deleted_at IS NULL [FOR UPDATE].
    // Partial unique index = the one-live-profile guarantee that resolves the concurrent first PATCH (23505).
    await knex.raw(`CREATE UNIQUE INDEX uq_patient_profiles_user_id ON patient_profiles (user_id) WHERE deleted_at IS NULL;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON patient_profiles TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE patient_profiles_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS patient_profiles;`);
}
