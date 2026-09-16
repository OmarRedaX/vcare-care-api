import type { Knex } from "knex";

/** btree_gist: lets a GiST exclusion constraint combine doctor_user_id equality with tstzrange overlap
 *  (excl_consultations_doctor_no_overlap, added by the consultations module). */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);
}

export async function down(knex: Knex): Promise<void> {
    // No CASCADE: if a later object depends on the extension, rollback must fail loudly
    // (dependents are dropped by their own migrations' down() first).
    await knex.raw(`DROP EXTENSION IF EXISTS btree_gist;`);
}
