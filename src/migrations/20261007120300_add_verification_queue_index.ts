import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // GET /admin/applications?status=... ORDER BY submitted_at ASC, id ASC (keyset).
    await knex.raw(`CREATE INDEX idx_doctor_profiles_verification_status_submitted_at_id
        ON doctor_profiles (verification_status, submitted_at, id) WHERE deleted_at IS NULL;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_doctor_profiles_verification_status_submitted_at_id;`);
}
