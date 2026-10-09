import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE consultation_types (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        name VARCHAR(100) NOT NULL,
        duration_minutes INT NOT NULL,
        price INT NOT NULL,
        currency CHAR(3) NOT NULL,
        is_active BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_consultation_types_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT chk_consultation_types_duration CHECK (duration_minutes BETWEEN 5 AND 240),
        CONSTRAINT chk_consultation_types_price CHECK (price >= 0),
        CONSTRAINT chk_consultation_types_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_consultation_types_name_length CHECK (char_length(name) >= 2)
    );`);
    await knex.raw(`COMMENT ON TABLE consultation_types IS 'Duration + price a doctor offers. Deactivated (is_active), never removed in MVP; deleted_at exists for the soft-delete pattern but no route sets it.';`);
    await knex.raw(`COMMENT ON COLUMN consultation_types.price IS 'Minor units';`);
    // Unique live name per doctor (23505 -> 409 Conflict); the leading column covers fk_consultation_types_doctor_profile_id. Serves:
    //   GET /doctors/me/consultation-types: WHERE doctor_profile_id = $1 AND deleted_at IS NULL [AND is_active = $2] AND id > $cursor ORDER BY id LIMIT $n + 1
    //   (at most 20 live rows per doctor, so the id sort over the index range is trivial), and the cap count
    //   SELECT count(*) FROM consultation_types WHERE doctor_profile_id = $1 AND deleted_at IS NULL.
    await knex.raw(`CREATE UNIQUE INDEX uq_consultation_types_doctor_profile_id_name ON consultation_types (doctor_profile_id, name) WHERE deleted_at IS NULL;`);
    // Domain rule 6 "at least one active type" (isBookable):
    //   SELECT 1 FROM consultation_types WHERE doctor_profile_id = $1 AND is_active AND deleted_at IS NULL LIMIT 1
    await knex.raw(`CREATE INDEX idx_consultation_types_doctor_profile_id_active ON consultation_types (doctor_profile_id) WHERE is_active AND deleted_at IS NULL;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON consultation_types TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE consultation_types_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS consultation_types;`);
}
