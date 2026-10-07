import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE doctor_languages (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        language_code CHAR(2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_doctor_languages_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT uq_doctor_languages_doctor_profile_id_language_code UNIQUE (doctor_profile_id, language_code),
        CONSTRAINT chk_doctor_languages_code CHECK (language_code ~ '^[a-z]{2}$')
    );`);
    // The unique index serves listLanguages and covers the profile FK.
    await knex.raw(`GRANT SELECT, INSERT, DELETE ON doctor_languages TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE doctor_languages_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS doctor_languages;`);
}
