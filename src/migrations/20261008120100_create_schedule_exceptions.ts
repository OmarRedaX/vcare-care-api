import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE schedule_exceptions (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        date DATE NOT NULL,
        type VARCHAR(16) NOT NULL,
        start_time TIME,
        end_time TIME,
        reason VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_schedule_exceptions_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT chk_schedule_exceptions_type CHECK (type IN ('day_off', 'custom_hours')),
        CONSTRAINT chk_schedule_exceptions_shape CHECK (
            (type = 'day_off' AND start_time IS NULL AND end_time IS NULL)
            OR (type = 'custom_hours' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)),
        CONSTRAINT chk_schedule_exceptions_whole_minutes CHECK (
            (start_time IS NULL OR EXTRACT(SECOND FROM start_time) = 0) AND (end_time IS NULL OR EXTRACT(SECOND FROM end_time) = 0))
    );`);
    await knex.raw(`COMMENT ON TABLE schedule_exceptions IS 'Per-date overrides in the doctor timezone: day_off removes the date, custom_hours replaces that weekday hours. Soft delete only.';`);
    await knex.raw(`COMMENT ON COLUMN schedule_exceptions.date IS 'Doctor-local date';`);
    await knex.raw(`COMMENT ON COLUMN schedule_exceptions.reason IS 'Free text: never logged, never audited';`);
    // One live exception per doctor-local date; also the FK index. Serves:
    //   POST /doctors/me/exceptions (23505 on a taken date -> 409 Conflict),
    //   GET  /doctors/me/exceptions: WHERE doctor_profile_id = $1 AND deleted_at IS NULL AND date >= $from [AND date <= $to]
    //        AND (date, id) > ($cursorDate, $cursorId) ORDER BY date, id LIMIT $n + 1,
    //   and the future slot-computation query WHERE doctor_profile_id = $1 AND date BETWEEN $from - 1 AND $to + 1.
    await knex.raw(`CREATE UNIQUE INDEX uq_schedule_exceptions_doctor_profile_id_date ON schedule_exceptions (doctor_profile_id, date) WHERE deleted_at IS NULL;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON schedule_exceptions TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE schedule_exceptions_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS schedule_exceptions;`);
}
