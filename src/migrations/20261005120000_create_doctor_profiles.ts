import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE doctor_profiles (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        headline VARCHAR(160) NOT NULL,
        bio TEXT,
        years_experience INT NOT NULL,
        consultation_fee INT NOT NULL,
        currency CHAR(3) NOT NULL,
        default_slot_minutes INT NOT NULL,
        timezone VARCHAR(64) NOT NULL,
        is_accepting_patients BOOLEAN NOT NULL,
        verification_status VARCHAR(16) NOT NULL,
        submitted_at TIMESTAMPTZ,
        reviewed_by BIGINT,
        review_note TEXT,
        decided_at TIMESTAMPTZ,
        identity_sync_status VARCHAR(16) NOT NULL,
        suspended_at TIMESTAMPTZ,
        suspended_by BIGINT,
        suspension_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT chk_doctor_profiles_verification_status CHECK (verification_status IN ('draft','submitted','approved','rejected')),
        CONSTRAINT chk_doctor_profiles_identity_sync_status CHECK (identity_sync_status IN ('not_required','pending','synced','failed')),
        CONSTRAINT chk_doctor_profiles_years_experience CHECK (years_experience BETWEEN 0 AND 70),
        CONSTRAINT chk_doctor_profiles_fee CHECK (consultation_fee >= 0),
        CONSTRAINT chk_doctor_profiles_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_doctor_profiles_default_slot CHECK (default_slot_minutes BETWEEN 5 AND 240),
        CONSTRAINT chk_doctor_profiles_headline_length CHECK (char_length(headline) >= 5),
        CONSTRAINT chk_doctor_profiles_bio_length CHECK (bio IS NULL OR char_length(bio) <= 4000),
        CONSTRAINT chk_doctor_profiles_suspension CHECK ((suspended_at IS NULL AND suspension_reason IS NULL) OR (suspended_at IS NOT NULL AND suspension_reason IS NOT NULL)),
        CONSTRAINT chk_doctor_profiles_decision CHECK (verification_status NOT IN ('approved','rejected') OR decided_at IS NOT NULL)
    );`);
    await knex.raw(`COMMENT ON TABLE doctor_profiles IS 'One live profile per Identity doctor account. Soft delete only.';`);
    await knex.raw(`COMMENT ON COLUMN doctor_profiles.user_id IS 'Identity user id';`);
    await knex.raw(`COMMENT ON COLUMN doctor_profiles.reviewed_by IS 'Identity user id';`);
    await knex.raw(`COMMENT ON COLUMN doctor_profiles.suspended_by IS 'Identity user id';`);
    // Every self-profile read and the local suspension check use user_id with deleted_at IS NULL.
    await knex.raw(`CREATE UNIQUE INDEX uq_doctor_profiles_user_id ON doctor_profiles (user_id) WHERE deleted_at IS NULL;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON doctor_profiles TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE doctor_profiles_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS doctor_profiles;`);
}
