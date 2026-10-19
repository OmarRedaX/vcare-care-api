import type { Knex } from "knex";

/**
 * upload_intents.description now carries the clinical free text of a record attachment (record-attachments spec 3.2). Comment only:
 * kind = 'record_attachment' and a non-null description are already allowed by chk_upload_intents_kind and
 * chk_upload_intents_document_type, and the purge indexes (idx_upload_intents_expires_at_open, idx_upload_intents_created_at) already serve it.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`COMMENT ON COLUMN upload_intents.description IS 'Clinical free text (record attachment description); never logged; purged with the row after 7 days';`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`COMMENT ON COLUMN upload_intents.description IS NULL;`);
}
