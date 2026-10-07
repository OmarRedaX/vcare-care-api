import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE doctor_specialties (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        specialty_id BIGINT NOT NULL,
        is_primary BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_doctor_specialties_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT fk_doctor_specialties_specialty_id FOREIGN KEY (specialty_id) REFERENCES specialties(id) ON DELETE RESTRICT,
        CONSTRAINT uq_doctor_specialties_doctor_profile_id_specialty_id UNIQUE (doctor_profile_id, specialty_id)
    );`);
    // The unique index serves listSpecialtyLinks and covers the profile FK.
    // Covers the specialty FK's RESTRICT check and future search by specialty.
    await knex.raw(`CREATE INDEX idx_doctor_specialties_specialty_id_doctor_profile_id ON doctor_specialties (specialty_id, doctor_profile_id);`);
    await knex.raw(`CREATE UNIQUE INDEX uq_doctor_specialties_primary ON doctor_specialties (doctor_profile_id) WHERE is_primary;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON doctor_specialties TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE doctor_specialties_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS doctor_specialties;`);
}
