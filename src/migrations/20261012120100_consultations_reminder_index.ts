import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // Reminder scan (care-worker, every minute): WHERE status = 'booked' AND deleted_at IS NULL AND starts_at > $now AND starts_at <= $now + interval
    //   AND reminder_24h_sent_at IS NULL (or reminder_1h_sent_at IS NULL) ORDER BY starts_at, id LIMIT 200 FOR UPDATE OF c SKIP LOCKED
    await knex.raw(`CREATE INDEX idx_consultations_booked_starts_at ON consultations (starts_at) WHERE status = 'booked' AND deleted_at IS NULL;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_consultations_booked_starts_at;`);
}
