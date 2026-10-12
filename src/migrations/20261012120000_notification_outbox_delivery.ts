import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`ALTER TABLE notification_outbox DROP CONSTRAINT chk_notification_outbox_kind;`);
    await knex.raw(`ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_kind CHECK (kind IN
        ('booking_confirmed','reminder_24h','reminder_1h','rescheduled','cancelled','schedule_blocked','doctor_joined','doctor_suspended'));`);
    await knex.raw(`ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL));`);
    await knex.raw(`ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_attempts CHECK (attempts >= 0);`);

    // Claim: WHERE status = 'pending' AND next_attempt_at <= $now ORDER BY next_attempt_at, id LIMIT $n FOR UPDATE SKIP LOCKED;
    //   lag: SELECT MIN(next_attempt_at) FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= $now
    await knex.raw(`CREATE INDEX idx_notification_outbox_pending_next_attempt_at_id ON notification_outbox (next_attempt_at, id) WHERE status = 'pending';`);
    // Purge: DELETE ... WHERE id IN (SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < $cutoff
    //   ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED)
    await knex.raw(`CREATE INDEX idx_notification_outbox_sent_at ON notification_outbox (sent_at) WHERE status = 'sent';`);

    // Delivery writes only the state columns; payload, kind, recipient, consultation and request_id stay immutable to the app role.
    await knex.raw(`GRANT UPDATE (status, attempts, next_attempt_at, last_error_code, sent_at) ON notification_outbox TO vcare_app;`);
    // Purge of sent rows only (the code never deletes another status).
    await knex.raw(`GRANT DELETE ON notification_outbox TO vcare_app;`);
    await knex.raw(`COMMENT ON TABLE notification_outbox IS 'Transactional outbox for emails (ADR 0011). Inserted with the business write; delivered, retried and purged by care-worker.';`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`REVOKE DELETE ON notification_outbox FROM vcare_app;`);
    await knex.raw(`REVOKE UPDATE (status, attempts, next_attempt_at, last_error_code, sent_at) ON notification_outbox FROM vcare_app;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_notification_outbox_sent_at;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_notification_outbox_pending_next_attempt_at_id;`);
    await knex.raw(`ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS chk_notification_outbox_attempts;`);
    await knex.raw(`ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS chk_notification_outbox_sent_shape;`);
    // Operational rows; required before the narrower CHECK can return.
    await knex.raw(`DELETE FROM notification_outbox WHERE kind = 'doctor_suspended';`);
    await knex.raw(`ALTER TABLE notification_outbox DROP CONSTRAINT chk_notification_outbox_kind;`);
    await knex.raw(`ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_kind CHECK (kind IN
        ('booking_confirmed','reminder_24h','reminder_1h','rescheduled','cancelled','schedule_blocked','doctor_joined'));`);
    await knex.raw(`COMMENT ON TABLE notification_outbox IS 'Transactional outbox for emails (ADR 0011). This slice only inserts; delivery, claim and purge belong to the notification worker unit.';`);
}
