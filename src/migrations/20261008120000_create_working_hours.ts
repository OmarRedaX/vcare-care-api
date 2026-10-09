import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE working_hours (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        weekday SMALLINT NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_working_hours_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT chk_working_hours_weekday CHECK (weekday BETWEEN 1 AND 7),
        CONSTRAINT chk_working_hours_time_order CHECK (end_time > start_time),
        CONSTRAINT chk_working_hours_whole_minutes CHECK (EXTRACT(SECOND FROM start_time) = 0 AND EXTRACT(SECOND FROM end_time) = 0),
        CONSTRAINT excl_working_hours_no_overlap EXCLUDE USING gist (
            doctor_profile_id WITH =, weekday WITH =,
            int4range((EXTRACT(EPOCH FROM start_time))::int, (EXTRACT(EPOCH FROM end_time))::int, '[)') WITH &&
        ) WHERE (deleted_at IS NULL)
    );`);
    await knex.raw(`COMMENT ON TABLE working_hours IS 'Recurring weekly hours in the doctor timezone; several rows per weekday = split shifts. PUT soft-deletes the old set and inserts the new one (vcare_app has no DELETE).';`);
    await knex.raw(`COMMENT ON COLUMN working_hours.weekday IS 'ISO weekday, 1 = Monday ... 7 = Sunday, doctor-local';`);
    await knex.raw(`COMMENT ON COLUMN working_hours.end_time IS '24:00:00 = the next local midnight';`);
    // GET /doctors/me/working-hours and the PUT read of the current set:
    //   SELECT ... FROM working_hours WHERE doctor_profile_id = $1 AND deleted_at IS NULL ORDER BY weekday, start_time
    // The leading column doctor_profile_id also covers fk_working_hours_doctor_profile_id (parent rows are never deleted).
    await knex.raw(`CREATE INDEX idx_working_hours_doctor_profile_id ON working_hours (doctor_profile_id, weekday, start_time) WHERE deleted_at IS NULL;`);
    // UPDATE sets deleted_at; no DELETE, no TRUNCATE.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON working_hours TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE working_hours_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS working_hours;`);
}
