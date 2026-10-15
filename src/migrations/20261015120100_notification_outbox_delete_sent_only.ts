import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // The purge deletes `sent` rows only; DELETE is granted table-wide, so the table itself refuses every other status (pending, dead, skipped).
    await knex.raw(`CREATE FUNCTION notification_outbox_delete_sent_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.status <> 'sent' THEN
                RAISE EXCEPTION 'notification_outbox rows can be deleted only when status = sent' USING ERRCODE = 'check_violation';
            END IF;
            RETURN OLD;
        END
        $$;`);
    await knex.raw(`CREATE TRIGGER trg_notification_outbox_delete_sent_only BEFORE DELETE ON notification_outbox
        FOR EACH ROW EXECUTE FUNCTION notification_outbox_delete_sent_only();`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_notification_outbox_delete_sent_only ON notification_outbox;`);
    await knex.raw(`DROP FUNCTION IF EXISTS notification_outbox_delete_sent_only();`);
}
