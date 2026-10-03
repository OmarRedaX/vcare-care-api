import type { Knex } from "knex";

/**
 * audit_logs: column-level INSERT for vcare_app (review 2026-10-03, L2; ADR 0018 addendum).
 *
 * The table-level INSERT let the app role set `id` and `created_at`: back-dated or future-dated audit history, a row
 * parked in audit_logs_default that blocks a future month, or a duplicate id that breaks the (sortValue, id) cursor.
 * AuditRecorder never writes those columns (their defaults fill them), so the app role now holds
 *   INSERT (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata) + SELECT
 * on the parent, audit_logs_default, and every existing monthly partition. Revoking the table-level INSERT also revokes
 * any column-level INSERT (PostgreSQL), so the column grant follows it. USAGE on audit_logs_id_seq stays (nextval in
 * the id default runs with the inserter's rights). SELECT is untouched.
 *
 * audit_logs_ensure_partitions is replaced with the same body; only its per-partition GRANT gains the column list.
 * CREATE OR REPLACE keeps the owner and the EXECUTE grants.
 */
const AUDIT_INSERT_COLUMNS = "actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata";

/** Re-grants INSERT on the parent and every partition: `grant` is a format() template taking the table name. */
function regrantInsert(grant: string): string {
    return `
        DO $do$
        DECLARE
            v_table text;
        BEGIN
            FOR v_table IN
                SELECT 'audit_logs'::text
                UNION ALL
                SELECT c.relname::text FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
                WHERE i.inhparent = 'public.audit_logs'::regclass
            LOOP
                EXECUTE format('REVOKE INSERT ON public.%I FROM vcare_app', v_table);
                EXECUTE format('${grant}', v_table);
            END LOOP;
        END
        $do$;
    `;
}

/** The function of 20261002120200 with `grant` (a format() template) as its per-partition GRANT. */
function ensurePartitionsFunction(grant: string): string {
    return `
        CREATE OR REPLACE FUNCTION audit_logs_ensure_partitions(p_months_ahead integer)
        RETURNS TABLE (partition_name text, created boolean)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        SET lock_timeout = '2s'
        AS $fn$
        DECLARE
            v_first_month timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
            v_from        timestamp;
        BEGIN
            IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 12 THEN
                RAISE EXCEPTION 'p_months_ahead must be between 0 and 12' USING ERRCODE = '22023';
            END IF;
            FOR i IN 0..p_months_ahead LOOP
                v_from := v_first_month + make_interval(months => i);
                partition_name := 'audit_logs_y' || to_char(v_from, 'YYYY') || 'm' || to_char(v_from, 'MM');
                created := to_regclass('public.' || partition_name) IS NULL;
                IF created THEN
                    -- Bounds are timestamptz literals with an offset: the range never depends on the session time zone.
                    EXECUTE format(
                        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
                        partition_name,
                        v_from AT TIME ZONE 'UTC',
                        (v_from + interval '1 month') AT TIME ZONE 'UTC');
                    EXECUTE format('${grant}', partition_name);
                END IF;
                RETURN NEXT;
            END LOOP;
        END
        $fn$;
    `;
}

export async function up(knex: Knex): Promise<void> {
    await knex.raw(regrantInsert(`GRANT INSERT (${AUDIT_INSERT_COLUMNS}) ON public.%I TO vcare_app`));
    await knex.raw(ensurePartitionsFunction(`GRANT SELECT, INSERT (${AUDIT_INSERT_COLUMNS}) ON public.%I TO vcare_app`));
}

/** Back to the table-level INSERT of 20261002120100 / 20261002120200. */
export async function down(knex: Knex): Promise<void> {
    await knex.raw(ensurePartitionsFunction("GRANT INSERT, SELECT ON public.%I TO vcare_app"));
    await knex.raw(regrantInsert("GRANT INSERT ON public.%I TO vcare_app"));
}
