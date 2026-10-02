import type { Knex } from "knex";

/**
 * audit_logs: the append-only audit trail (CLAUDE.md → Privacy and logging), range-partitioned by month on
 * created_at (ADR 0009). Append-only is a GRANT, not a habit: vcare_app holds INSERT and SELECT only — no UPDATE,
 * DELETE, or TRUNCATE on the parent or any partition (ADR 0018).
 *
 * Indexes: only the primary key. The read indexes for GET /audit-logs ship with the `audit` module's migration
 * (access spec §14.1, decision D1). No FKs exist (entity_id is polymorphic, actor_user_id is an Identity id).
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE audit_logs (
            id              BIGSERIAL,
            actor_user_id   BIGINT,                 -- Identity user id (no FK); NULL for service and system actors
            actor_role      VARCHAR(16) NOT NULL,
            action          VARCHAR(64) NOT NULL,   -- <entity>.<verb>, e.g. specialty.created, record.read
            entity_type     VARCHAR(64) NOT NULL,   -- snake_case, e.g. medical_record
            entity_id       BIGINT NOT NULL,        -- polymorphic by entity_type: no FK
            request_id      UUID,                   -- the request's X-Request-Id; NULL for worker actors without one
            metadata        JSONB NOT NULL,         -- ids, statuses, reasons only; never clinical text or PII
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT pk_audit_logs PRIMARY KEY (id, created_at),
            CONSTRAINT chk_audit_logs_actor_role
                CHECK (actor_role IN ('patient', 'doctor', 'admin', 'service', 'system')),
            CONSTRAINT chk_audit_logs_actor_user_id
                CHECK ((actor_role IN ('patient', 'doctor', 'admin')) = (actor_user_id IS NOT NULL)),
            CONSTRAINT chk_audit_logs_entity_id_positive CHECK (entity_id > 0),
            CONSTRAINT chk_audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
            CONSTRAINT chk_audit_logs_metadata_size CHECK (octet_length(metadata::text) <= 4096)
        ) PARTITION BY RANGE (created_at);
    `);

    await knex.raw(`
        COMMENT ON TABLE audit_logs IS 'Append-only (INSERT/SELECT for vcare_app). Monthly partitions audit_logs_yYYYYmMM; retention >= 6 years by detach + archive, never DELETE (ADR 0009).';
    `);
    await knex.raw(`
        COMMENT ON COLUMN audit_logs.actor_user_id IS 'Identity user id (no cross-database FK); NULL for service and system actors.';
    `);

    // Catches rows outside every monthly partition; must stay empty (AuditPartitionMissing alerts otherwise).
    await knex.raw(`CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;`);

    await knex.raw(`GRANT INSERT, SELECT ON audit_logs TO vcare_app;`);
    // SELECT: the worker's non-empty check reads the default partition directly.
    await knex.raw(`GRANT INSERT, SELECT ON audit_logs_default TO vcare_app;`);
    // nextval() for BIGSERIAL: belongs to the INSERT grant, not a table privilege.
    await knex.raw(`GRANT USAGE ON SEQUENCE audit_logs_id_seq TO vcare_app;`);
}

/** Dev/test only: production never rolls back a table with audit history (expand/migrate/contract). */
export async function down(knex: Knex): Promise<void> {
    // Drops every partition and their grants with it.
    await knex.raw(`DROP TABLE IF EXISTS audit_logs;`);
}
