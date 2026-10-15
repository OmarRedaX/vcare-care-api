import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // Stale-pending gauge (care-worker, every outbox tick): SELECT MIN(created_at) FROM notification_outbox WHERE status = 'pending'
    //   (counts rows in contacts or send backoff, which the claim index hides behind a future next_attempt_at)
    await knex.raw(`CREATE INDEX idx_notification_outbox_pending_created_at ON notification_outbox (created_at) WHERE status = 'pending';`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_notification_outbox_pending_created_at;`);
}
