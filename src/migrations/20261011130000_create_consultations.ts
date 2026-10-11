import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE consultations (
        id BIGSERIAL PRIMARY KEY,
        doctor_user_id BIGINT NOT NULL,
        patient_user_id BIGINT NOT NULL,
        consultation_type_id BIGINT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(16) NOT NULL,
        complaint_text TEXT NOT NULL,
        patient_timezone VARCHAR(64) NOT NULL,
        price INT NOT NULL,
        currency CHAR(3) NOT NULL,
        room_id VARCHAR(128),
        joined_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancel_reason TEXT,
        cancelled_by VARCHAR(16),
        cancelled_by_user_id BIGINT,
        no_show_marked_at TIMESTAMPTZ,
        needs_admin_followup BOOLEAN NOT NULL DEFAULT FALSE,
        followup_reason VARCHAR(32),
        follow_up_of_record_id BIGINT,
        reminder_24h_sent_at TIMESTAMPTZ,
        reminder_1h_sent_at TIMESTAMPTZ,
        idempotency_key UUID NOT NULL,
        request_hash CHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT fk_consultations_consultation_type_id FOREIGN KEY (consultation_type_id) REFERENCES consultation_types(id) ON DELETE RESTRICT,
        CONSTRAINT chk_consultations_status CHECK (status IN ('booked','waiting','in_progress','completed','cancelled','no_show')),
        CONSTRAINT chk_consultations_time_order CHECK (ends_at > starts_at),
        CONSTRAINT chk_consultations_price CHECK (price >= 0),
        CONSTRAINT chk_consultations_cancelled_by CHECK (cancelled_by IS NULL OR cancelled_by IN ('patient','doctor','admin')),
        CONSTRAINT chk_consultations_cancel_shape CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
        CONSTRAINT chk_consultations_followup_reason CHECK (followup_reason IS NULL OR followup_reason IN ('doctor_suspended','schedule_blocked')),
        CONSTRAINT uq_consultations_idempotency UNIQUE (patient_user_id, idempotency_key)
    );`);
    await knex.raw(`COMMENT ON TABLE consultations IS 'A booked consultation and its lifecycle. Soft delete only; no route sets deleted_at. The exclusion constraint is the overlap guarantee.';`);
    await knex.raw(`COMMENT ON COLUMN consultations.doctor_user_id IS 'Identity user id';`);
    await knex.raw(`COMMENT ON COLUMN consultations.patient_user_id IS 'Identity user id';`);
    await knex.raw(`COMMENT ON COLUMN consultations.cancelled_by_user_id IS 'Identity user id';`);
    await knex.raw(`COMMENT ON COLUMN consultations.complaint_text IS 'Clinical/free text; never logged';`);
    await knex.raw(`COMMENT ON COLUMN consultations.cancel_reason IS 'Clinical/free text; never logged';`);
    await knex.raw(`COMMENT ON COLUMN consultations.follow_up_of_record_id IS 'FK to medical_records is added by the records migration (circular)';`);
    await knex.raw(`COMMENT ON COLUMN consultations.price IS 'Minor units; snapshot of the type price at booking';`);

    // CLAUDE.md -> Database rules: overlapping live consultations are impossible. SQLSTATE 23P01 -> 409 SlotUnavailable.
    // The GiST index behind it also serves candidate scans by (doctor_user_id, time range).
    await knex.raw(`ALTER TABLE consultations ADD CONSTRAINT excl_consultations_doctor_no_overlap
        EXCLUDE USING gist (doctor_user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
        WHERE (status NOT IN ('cancelled','no_show') AND deleted_at IS NULL);`);
    // uq_consultations_idempotency (table constraint above) serves the booking replay lookup:
    //   SELECT ... FROM consultations WHERE patient_user_id = $1 AND idempotency_key = $2
    // Patient list keyset, both directions: WHERE patient_user_id = $1 AND deleted_at IS NULL [scope time predicate]
    //   ORDER BY starts_at, id (or DESC) AND (starts_at, id) > ($t, $id) LIMIT $n + 1
    await knex.raw(`CREATE INDEX idx_consultations_patient_user_id_starts_at_id ON consultations (patient_user_id, starts_at, id) WHERE deleted_at IS NULL;`);
    // Doctor list keyset (same shape with doctor_user_id); ScheduleImpactProvider.findAffected
    //   (WHERE doctor_user_id = $1 AND status IN (...) AND ends_at > $now AND starts_at >= $lower ORDER BY id);
    //   the suspension flag UPDATE (WHERE doctor_user_id = $1 AND status IN (...) AND ends_at > $now); admin doctorUserId filter.
    await knex.raw(`CREATE INDEX idx_consultations_doctor_user_id_starts_at_id ON consultations (doctor_user_id, starts_at, id) WHERE deleted_at IS NULL;`);
    // Relationship check for GET /patients/:patientUserId:
    //   SELECT 1 FROM consultations WHERE doctor_user_id = $1 AND patient_user_id = $2 AND deleted_at IS NULL
    //   AND status IN ('booked','waiting','in_progress','completed') LIMIT 1
    await knex.raw(`CREATE INDEX idx_consultations_doctor_user_id_patient_user_id ON consultations (doctor_user_id, patient_user_id)
        WHERE deleted_at IS NULL AND status IN ('booked','waiting','in_progress','completed');`);
    // fk_consultations_consultation_type_id: FK index (the type row is joined by primary key on every list/get).
    await knex.raw(`CREATE INDEX idx_consultations_consultation_type_id ON consultations (consultation_type_id);`);
    // Admin follow-up queue: GET /consultations?needsAdminFollowup=true
    //   WHERE needs_admin_followup AND deleted_at IS NULL AND status IN ('booked','waiting','in_progress') ORDER BY starts_at, id
    await knex.raw(`CREATE INDEX idx_consultations_followup_starts_at_id ON consultations (starts_at, id)
        WHERE needs_admin_followup AND deleted_at IS NULL AND status IN ('booked','waiting','in_progress');`);
    // Admin list without a participant filter: WHERE deleted_at IS NULL [scope/status/from/to] ORDER BY starts_at, id LIMIT $n + 1
    await knex.raw(`CREATE INDEX idx_consultations_starts_at_id ON consultations (starts_at, id) WHERE deleted_at IS NULL;`);
    // FK-to-be of the records migration (fk_consultations_follow_up_of_record_id): the indexed lookup is
    //   SELECT ... FROM consultations WHERE follow_up_of_record_id = $1
    await knex.raw(`CREATE INDEX idx_consultations_follow_up_of_record_id ON consultations (follow_up_of_record_id) WHERE follow_up_of_record_id IS NOT NULL;`);

    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON consultations TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE consultations_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS consultations;`);
}
