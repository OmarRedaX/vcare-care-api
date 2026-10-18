import type { Knex } from "knex";

/**
 * The deferred half of the circular reference consultations <-> medical_records (records spec 2.3). The covering index
 * idx_consultations_follow_up_of_record_id already exists; no row can violate the constraint (the column was unwritable until the
 * records unit). ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on consultations, so the lock wait is bounded.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`SET LOCAL lock_timeout = '5s';`);
    await knex.raw(`ALTER TABLE consultations ADD CONSTRAINT fk_consultations_follow_up_of_record_id
        FOREIGN KEY (follow_up_of_record_id) REFERENCES medical_records(id) ON DELETE RESTRICT;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`ALTER TABLE consultations DROP CONSTRAINT IF EXISTS fk_consultations_follow_up_of_record_id;`);
}
