import type { Knex } from "knex";

/**
 * The three read indexes of GET /api/audit-logs (audit spec 2.1), deferred by access decision D1 until the read exists.
 * On the partitioned parent: built on every existing partition (incl. audit_logs_default) and inherited by future ones.
 * Non-concurrent (impossible on a partitioned parent): lock_timeout bounds the SHARE-lock stall on the insert path.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`SET LOCAL lock_timeout = '3s';`);
    // GET /api/audit-logs?entityType=&entityId= newest first (equality prefix, then the sort pair).
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type_entity_id_created_at
        ON audit_logs (entity_type, entity_id, created_at DESC, id DESC);`);
    // GET /api/audit-logs?actorUserId= newest first.
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id_created_at
        ON audit_logs (actor_user_id, created_at DESC, id DESC);`);
    // GET /api/audit-logs unfiltered, or action / time-range filtered, newest first (also the fallback for any filter combination).
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at_id
        ON audit_logs (created_at DESC, id DESC);`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_audit_logs_created_at_id;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_audit_logs_actor_user_id_created_at;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_audit_logs_entity_type_entity_id_created_at;`);
}
