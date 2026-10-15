import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE notification_outbox (
        id BIGSERIAL PRIMARY KEY,
        kind VARCHAR(32) NOT NULL,
        consultation_id BIGINT,
        recipient_user_id BIGINT NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(16) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        last_error_code VARCHAR(32),
        request_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        CONSTRAINT fk_notification_outbox_consultation_id FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE RESTRICT,
        CONSTRAINT chk_notification_outbox_kind CHECK (kind IN ('booking_confirmed','reminder_24h','reminder_1h','rescheduled','cancelled','schedule_blocked','doctor_joined')),
        CONSTRAINT chk_notification_outbox_status CHECK (status IN ('pending','sent','dead','skipped')),
        CONSTRAINT chk_notification_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
    );`);
    await knex.raw(`COMMENT ON TABLE notification_outbox IS 'Transactional outbox for emails (ADR 0011). This slice only inserts; delivery, claim and purge belong to the notification worker unit.';`);
    await knex.raw(`COMMENT ON COLUMN notification_outbox.recipient_user_id IS 'Identity user id; email resolved at send time, never stored';`);
    await knex.raw(`COMMENT ON COLUMN notification_outbox.payload IS 'ids and non-clinical render params only';`);
    // fk_notification_outbox_consultation_id: FK index + support lookup by consultation:
    //   SELECT ... FROM notification_outbox WHERE consultation_id = $1
    // The claim index (status = 'pending') and the purge index (status = 'sent') arrive with the delivery unit and its UPDATE/DELETE grants.
    await knex.raw(`CREATE INDEX idx_notification_outbox_consultation_id ON notification_outbox (consultation_id) WHERE consultation_id IS NOT NULL;`);
    await knex.raw(`GRANT SELECT, INSERT ON notification_outbox TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE notification_outbox_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS notification_outbox;`);
}
