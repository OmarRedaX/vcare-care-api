import type { Knex } from "knex";

/**
 * audit_logs_ensure_partitions(p_months_ahead): creates the monthly partitions for the current UTC month and the next
 * `p_months_ahead` months, granting INSERT/SELECT on each to vcare_app (ADR 0009, ADR 0018).
 *
 * Creating a partition requires owning the parent, and care-worker connects as care_app. Instead of handing the worker
 * the owner credential, this one narrow SECURITY DEFINER function (owned by the migration owner) takes only a bounded
 * integer: search_path pinned, every identifier schema-qualified and %I-quoted, EXECUTE revoked from PUBLIC and granted
 * to vcare_app only, lock_timeout 2 s so it never queues behind a long lock and stalls audit inserts.
 *
 * Creating a month while audit_logs_default holds a row inside its range fails (PostgreSQL validates the default
 * partition): the function raises, the worker reports audit_partition_missing, and the runbook moves the rows.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE FUNCTION audit_logs_ensure_partitions(p_months_ahead integer)
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
                    EXECUTE format('GRANT INSERT, SELECT ON public.%I TO vcare_app', partition_name);
                END IF;
                RETURN NEXT;
            END LOOP;
        END
        $fn$;
    `);

    await knex.raw(`REVOKE ALL ON FUNCTION audit_logs_ensure_partitions(integer) FROM PUBLIC;`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION audit_logs_ensure_partitions(integer) TO vcare_app;`);

    // Current UTC month + the next 2 (= the AUDIT_PARTITION_MONTHS_AHEAD default; migrations cannot read env —
    // the worker extends to the configured value on its first tick).
    await knex.raw(`SELECT partition_name, created FROM audit_logs_ensure_partitions(2);`);
}

export async function down(knex: Knex): Promise<void> {
    // Partitions stay; they go with the table (create_audit_logs down).
    await knex.raw(`DROP FUNCTION IF EXISTS audit_logs_ensure_partitions(integer);`);
}
