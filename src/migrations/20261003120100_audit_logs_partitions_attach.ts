import type { Knex } from "knex";

/**
 * audit_logs_ensure_partitions: create a month as a standalone table, then ATTACH it (review 2026-10-03, L3; ADR 0018
 * addendum).
 *
 * `CREATE TABLE … PARTITION OF` takes ACCESS EXCLUSIVE on audit_logs. While any open request transaction holds ROW
 * EXCLUSIVE on it (it already wrote an audit row) the CREATE waits — and every new audit INSERT queues behind that
 * waiting lock request for up to the old 2 s lock_timeout, stalling booking, record, and suspension writes. Now:
 *   1. `CREATE TABLE public.<month> (LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` — only
 *      ACCESS SHARE on the parent;
 *   2. `ALTER TABLE public.audit_logs ATTACH PARTITION … FOR VALUES …` — SHARE UPDATE EXCLUSIVE on the parent, which
 *      does not conflict with INSERT (ROW EXCLUSIVE). It takes ACCESS EXCLUSIVE only on the new table and on
 *      audit_logs_default (scanned for rows in the new range — it must stay empty), and builds the PK index on the
 *      empty new table;
 *   3. the column-level grant of 20261003120000.
 * lock_timeout drops to 200 ms: the daily tick retries, so a contended attach gives up fast instead of waiting.
 * A DEFAULT row inside the new month's range still fails the ATTACH (23514): the worker reports
 * audit_partition_missing and the runbook moves the rows.
 */
const COLUMN_GRANT =
    "GRANT SELECT, INSERT (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata) ON public.%I TO vcare_app";

const CREATE_THEN_ATTACH = `
                    EXECUTE format(
                        'CREATE TABLE public.%I (LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
                        partition_name);
                    EXECUTE format(
                        'ALTER TABLE public.audit_logs ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
                        partition_name,
                        v_from AT TIME ZONE 'UTC',
                        (v_from + interval '1 month') AT TIME ZONE 'UTC');`;

const CREATE_PARTITION_OF = `
                    EXECUTE format(
                        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
                        partition_name,
                        v_from AT TIME ZONE 'UTC',
                        (v_from + interval '1 month') AT TIME ZONE 'UTC');`;

function ensurePartitionsFunction(lockTimeout: string, createStatements: string): string {
    return `
        CREATE OR REPLACE FUNCTION audit_logs_ensure_partitions(p_months_ahead integer)
        RETURNS TABLE (partition_name text, created boolean)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        SET lock_timeout = '${lockTimeout}'
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
                    ${createStatements}
                    EXECUTE format('${COLUMN_GRANT}', partition_name);
                END IF;
                RETURN NEXT;
            END LOOP;
        END
        $fn$;
    `;
}

export async function up(knex: Knex): Promise<void> {
    await knex.raw(ensurePartitionsFunction("200ms", CREATE_THEN_ATTACH));
}

/** Back to 20261003120000's function: PARTITION OF, lock_timeout 2 s, the same column-level grant. */
export async function down(knex: Knex): Promise<void> {
    await knex.raw(ensurePartitionsFunction("2s", CREATE_PARTITION_OF));
}
