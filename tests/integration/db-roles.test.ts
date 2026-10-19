import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Knex } from "knex";
import { AuditRecorder } from "../../src/lib/audit/audit";
import { ensureAppLogin } from "../../src/lib/knex/app-login";
import { createKnex, db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";

jest.setTimeout(60_000);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_URL = process.env.DATABASE_URL ?? "";
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? "";

/** The app URL with another user/password (same host and database). */
function urlFor(user: string, password: string, base = APP_URL): string {
    const url = new URL(base);
    url.username = user;
    url.password = password;
    return url.toString();
}

/** A fresh, short-lived pool (new connections: grant and password changes take effect). */
async function withPool<T>(url: string, fn: (conn: Knex) => Promise<T>): Promise<T> {
    const conn = createKnex({ url, poolMax: 1, statementTimeoutMs: 5_000, applicationName: "care-test" });
    try {
        return await fn(conn);
    } finally {
        await conn.destroy();
    }
}

interface ChildResult {
    code: number | null;
    output: string;
}

function runMigrate(command: string, env: Record<string, string>): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/migrate.ts", command], {
            cwd: REPO_ROOT,
            env: { ...process.env, LOG_LEVEL: "info", ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`migrate ${command} did not exit; output: ${output}`));
        }, 45_000);
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
        child.on("error", reject);
    });
}

const jsonLines = (text: string): Array<Record<string, unknown>> =>
    text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("database roles (integration: owner care vs app login care_app, ADR 0018)", () => {
    const throwaway: string[] = [];

    beforeAll(async () => {
        await truncateAll();
    });

    afterAll(async () => {
        for (const role of throwaway) {
            await ownerDb.raw(`DROP ROLE IF EXISTS ${role}`);
        }
        await closeDb();
    });

    it("should connect the request pool as care_app, a plain login that is a member of vcare_app (A14)", async () => {
        const who = await db.raw<{ rows: Array<{ current_user: string; member: boolean }> }>(
            "SELECT current_user, pg_has_role(current_user, 'vcare_app', 'MEMBER') AS member",
        );
        expect(who.rows[0]).toEqual({ current_user: "care_app", member: true });

        const attrs = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
             FROM pg_roles WHERE rolname = 'care_app'`,
        );
        expect(attrs.rows[0]).toEqual({
            rolcanlogin: true,
            rolinherit: true,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolbypassrls: false,
        });
        const group = await ownerDb.raw<{ rows: Array<{ rolcanlogin: boolean }> }>(
            "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'vcare_app'",
        );
        expect(group.rows[0]?.rolcanlogin).toBe(false);
    });

    it("should deny CREATE TABLE in public, ALTER TABLE audit_logs, and DROP TABLE audit_logs to care_app (A14)", async () => {
        await expect(db.raw("CREATE TABLE public.app_probe (id int)")).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("ALTER TABLE audit_logs ADD COLUMN probe int")).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("DROP TABLE audit_logs_default")).rejects.toMatchObject({ code: "42501" });
        await expect(
            db.raw("CREATE TABLE public.audit_logs_y2099m01 PARTITION OF audit_logs FOR VALUES FROM ('2099-01-01') TO ('2099-02-01')"),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it("should let care_app call audit_logs_ensure_partitions, idempotently and only within 0..12 months", async () => {
        const first = await db.raw<{ rows: Array<{ partition_name: string; created: boolean }> }>(
            "SELECT partition_name, created FROM audit_logs_ensure_partitions(2)",
        );
        expect(first.rows).toHaveLength(3);
        expect(first.rows.every((row) => /^audit_logs_y\d{4}m\d{2}$/.test(row.partition_name))).toBe(true);
        const second = await db.raw<{ rows: Array<{ created: boolean }> }>("SELECT created FROM audit_logs_ensure_partitions(2)");
        expect(second.rows.map((row) => row.created)).toEqual([false, false, false]);

        for (const months of ["13", "-1", "NULL"]) {
            await expect(db.raw(`SELECT * FROM audit_logs_ensure_partitions(${months})`)).rejects.toMatchObject({ code: "22023" });
        }
        // The only input is an integer: no table name, schema, or SQL fragment can be passed in.
        await expect(db.raw("SELECT * FROM audit_logs_ensure_partitions('audit_logs; DROP TABLE audit_logs')")).rejects.toMatchObject({
            code: "22P02",
        });
    });

    it("should grant column-level INSERT and SELECT but nothing else on the parent and every partition (L2)", async () => {
        const result = await ownerDb.raw<{
            rows: Array<{ relname: string; tbl_ins: boolean; col_ins: boolean; id_ins: boolean; at_ins: boolean; sel: boolean; upd: boolean; del: boolean; trunc: boolean }>;
        }>(
            `SELECT c.relname,
                    has_table_privilege('vcare_app', c.oid, 'INSERT') AS tbl_ins,
                    has_column_privilege('vcare_app', c.oid, 'metadata', 'INSERT') AS col_ins,
                    has_column_privilege('vcare_app', c.oid, 'id', 'INSERT') AS id_ins,
                    has_column_privilege('vcare_app', c.oid, 'created_at', 'INSERT') AS at_ins,
                    has_table_privilege('vcare_app', c.oid, 'SELECT') AS sel,
                    has_table_privilege('vcare_app', c.oid, 'UPDATE') AS upd,
                    has_table_privilege('vcare_app', c.oid, 'DELETE') AS del,
                    has_table_privilege('vcare_app', c.oid, 'TRUNCATE') AS trunc
             FROM pg_class c
             WHERE c.oid = 'audit_logs'::regclass
                OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'audit_logs'::regclass)`,
        );
        expect(result.rows.length).toBeGreaterThanOrEqual(5); // parent + default + current + 2 ahead
        for (const row of result.rows) {
            expect(row).toEqual({
                relname: row.relname,
                tbl_ins: false,
                col_ins: true,
                id_ins: false,
                at_ins: false,
                sel: true,
                upd: false,
                del: false,
                trunc: false,
            });
        }
    });

    it("should grant vcare_app SELECT, INSERT and UPDATE but no DELETE or TRUNCATE on the three schedules tables and USAGE on their sequences", async () => {
        const tables = ["working_hours", "schedule_exceptions", "consultation_types"];
        for (const table of tables) {
            const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
                `SELECT has_table_privilege('vcare_app', ?::regclass, 'SELECT') AS sel,
                        has_table_privilege('vcare_app', ?::regclass, 'INSERT') AS ins,
                        has_table_privilege('vcare_app', ?::regclass, 'UPDATE') AS upd,
                        has_table_privilege('vcare_app', ?::regclass, 'DELETE') AS del,
                        has_table_privilege('vcare_app', ?::regclass, 'TRUNCATE') AS trunc,
                        has_sequence_privilege('vcare_app', ?::regclass, 'USAGE') AS seq`,
                [table, table, table, table, table, `${table}_id_seq`],
            );
            expect(result.rows[0]).toEqual({ sel: true, ins: true, upd: true, del: false, trunc: false, seq: true });
        }
    });

    it("should grant vcare_app SELECT and INSERT but no table-level UPDATE, DELETE or TRUNCATE on medical_records, and USAGE on its sequence", async () => {
        const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT has_table_privilege('vcare_app', 'medical_records', 'SELECT') AS sel,
                    has_table_privilege('vcare_app', 'medical_records', 'INSERT') AS ins,
                    has_table_privilege('vcare_app', 'medical_records', 'UPDATE') AS upd,
                    has_table_privilege('vcare_app', 'medical_records', 'DELETE') AS del,
                    has_table_privilege('vcare_app', 'medical_records', 'TRUNCATE') AS trunc,
                    has_sequence_privilege('vcare_app', 'medical_records_id_seq', 'USAGE') AS seq`,
        );
        expect(result.rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false, seq: true });
    });

    it("should limit vcare_app UPDATE on medical_records to the six clinical columns and updated_at (the lock and the parties cannot be moved)", async () => {
        const columns = ["id", "consultation_id", "patient_user_id", "doctor_user_id", "chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code",
            "treatment_plan", "follow_up_in_days", "locked_at", "created_at", "updated_at", "deleted_at"];
        const result = await ownerDb.raw<{ rows: Array<{ column_name: string; ok: boolean }> }>(
            `SELECT c AS column_name, has_column_privilege('vcare_app', 'medical_records', c, 'UPDATE') AS ok FROM unnest(?::text[]) AS c`, [columns]);
        const updatable = result.rows.filter((row) => row.ok).map((row) => row.column_name).sort();
        expect(updatable).toEqual(["chief_complaint", "diagnosis_code", "diagnosis_text", "examination_notes", "follow_up_in_days", "treatment_plan", "updated_at"]);
        for (const column of ["id", "consultation_id", "patient_user_id", "doctor_user_id", "locked_at", "created_at", "deleted_at"]) {
            expect([column, result.rows.find((row) => row.column_name === column)?.ok]).toEqual([column, false]);
        }
    });

    it("should make medical_record_amendments append-only for vcare_app: SELECT and a nine-column INSERT, never UPDATE, DELETE, TRUNCATE, id or created_at", async () => {
        const table = (privilege: string): string => `has_table_privilege('vcare_app', 'medical_record_amendments', '${privilege}')`;
        const insertable = (column: string): string => `has_column_privilege('vcare_app', 'medical_record_amendments', '${column}', 'INSERT')`;
        const columns = ["medical_record_id", "author_user_id", "chief_complaint", "examination_notes", "diagnosis_text", "diagnosis_code", "treatment_plan", "follow_up_in_days", "reason"];
        const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT ${table("SELECT")} AS sel, ${table("INSERT")} AS ins, ${table("UPDATE")} AS upd, ${table("DELETE")} AS del, ${table("TRUNCATE")} AS trunc,
                    ${insertable("id")} AS id_ins, ${insertable("created_at")} AS at_ins, ${columns.map((column, index) => `${insertable(column)} AS c${index}`).join(", ")},
                    has_sequence_privilege('vcare_app', 'medical_record_amendments_id_seq', 'USAGE') AS seq`,
        );
        expect(result.rows[0]).toEqual({ sel: true, ins: false, upd: false, del: false, trunc: false, id_ins: false, at_ins: false,
            ...Object.fromEntries(columns.map((_column, index) => [`c${index}`, true])), seq: true });
    });

    it("should give vcare_app on record_attachments SELECT, a six-column INSERT and an UPDATE of deleted_at only, never DELETE, TRUNCATE or table-level UPDATE", async () => {
        const table = (privilege: string): string => `has_table_privilege('vcare_app', 'record_attachments', '${privilege}')`;
        const column = (name: string, privilege: string): string => `has_column_privilege('vcare_app', 'record_attachments', '${name}', '${privilege}')`;
        const all = ["id", "medical_record_id", "uploaded_by_user_id", "object_key", "file_type", "size_bytes", "description", "created_at", "deleted_at"];
        const insertable = ["medical_record_id", "uploaded_by_user_id", "object_key", "file_type", "size_bytes", "description"];
        const result = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT ${table("SELECT")} AS sel, ${table("INSERT")} AS ins, ${table("UPDATE")} AS upd, ${table("DELETE")} AS del, ${table("TRUNCATE")} AS trunc,
                    ${all.map((name) => `${column(name, "INSERT")} AS i_${name}, ${column(name, "UPDATE")} AS u_${name}`).join(", ")},
                    has_sequence_privilege('vcare_app', 'record_attachments_id_seq', 'USAGE') AS seq`,
        );
        expect(result.rows[0]).toEqual({
            sel: true, ins: false, upd: false, del: false, trunc: false, seq: true,
            ...Object.fromEntries(all.flatMap((name) => [[`i_${name}`, insertable.includes(name)], [`u_${name}`, name === "deleted_at"]])),
        });
    });

    it("should let the care_app login insert and soft-delete an attachment, refuse the removal after the lock with the trigger's constraint name, and refuse DELETE and other UPDATEs", async () => {
        const [profile] = await ownerDb("doctor_profiles").insert({
            user_id: 601, headline: "TEST-HEADLINE", years_experience: 1, consultation_fee: 100, currency: "EGP", default_slot_minutes: 30, timezone: "UTC",
            is_accepting_patients: true, verification_status: "approved", identity_sync_status: "synced", decided_at: new Date(),
        }).returning("id");
        const [type] = await ownerDb("consultation_types").insert({ doctor_profile_id: profile.id, name: "TEST", duration_minutes: 30, price: 100, currency: "EGP", is_active: true }).returning("id");
        const recordFor = async (slot: number, lockedInPast: boolean): Promise<number> => {
            const start = new Date(Date.UTC(2030, 0, 1) + slot * 3_600_000);
            const [consultation] = await ownerDb("consultations").insert({
                doctor_user_id: 601, patient_user_id: 701, consultation_type_id: type.id, starts_at: start, ends_at: new Date(start.getTime() + 1_800_000), status: "completed",
                completed_at: new Date(start.getTime() + 1_500_000), complaint_text: "TEST-COMPLAINT", patient_timezone: "UTC", price: 100, currency: "EGP",
                idempotency_key: `00000000-0000-4000-8000-${String(slot).padStart(12, "0")}`, request_hash: "a".repeat(64),
            }).returning("id");
            const offset = lockedInPast ? "-1 hour" : "1 hour";
            const result = await ownerDb.raw<{ rows: Array<{ id: number }> }>(
                `INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at)
                 VALUES (?, 701, 601, 'TEST-CHIEF', NOW() + ?::interval - interval '24 hours', NOW() + ?::interval - interval '24 hours', NOW() + ?::interval) RETURNING id`,
                [consultation.id, offset, offset, offset]);
            return result.rows[0]?.id ?? 0;
        };
        const open = await recordFor(1, false);
        const locked = await recordFor(2, true);
        const add = (recordId: number, key: string): Promise<Array<{ id: number }>> => db("record_attachments").insert({
            medical_record_id: recordId, uploaded_by_user_id: 601, object_key: `record-attachments/${key}`, file_type: "image/png", size_bytes: 10,
        }).returning("id");
        const [openRow] = await add(open, "open");
        const [lockedRow] = await add(locked, "locked");
        await expect(db("record_attachments").where({ id: openRow?.id ?? 0 }).update({ deleted_at: db.fn.now() })).resolves.toBe(1);
        await expect(db("record_attachments").where({ id: lockedRow?.id ?? 0 }).update({ deleted_at: db.fn.now() }))
            .rejects.toMatchObject({ code: "23514", constraint: "trg_record_attachments_forbid_delete_after_lock" });
        await expect(db("record_attachments").where({ id: lockedRow?.id ?? 0 }).update({ description: "x" })).rejects.toMatchObject({ code: "42501" });
        await expect(db("record_attachments").where({ id: lockedRow?.id ?? 0 }).update({ object_key: "record-attachments/moved" })).rejects.toMatchObject({ code: "42501" });
        await expect(db("record_attachments").where({ id: lockedRow?.id ?? 0 }).delete()).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("TRUNCATE record_attachments")).rejects.toMatchObject({ code: "42501" });
        await truncateAll();
    });

    it("should reject care_app inserts that set created_at or id while AuditRecorder.record still inserts (L2)", async () => {
        const columns = "actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata";
        await expect(
            db.raw(`INSERT INTO audit_logs (${columns}, created_at) VALUES (NULL, 'system', 'test.backdated', 'test_entity', 1, NULL, '{}', '2020-01-01T00:00:00Z')`),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
            db.raw(`INSERT INTO audit_logs (id, ${columns}) VALUES (1, NULL, 'system', 'test.duplicate', 'test_entity', 1, NULL, '{}')`),
        ).rejects.toMatchObject({ code: "42501" });
        // Directly into a partition too (the per-partition grant is column-level as well).
        await expect(
            db.raw(`INSERT INTO audit_logs_default (${columns}, created_at) VALUES (NULL, 'system', 'test.parked', 'test_entity', 1, NULL, '{}', '2099-01-01T00:00:00Z')`),
        ).rejects.toMatchObject({ code: "42501" });

        const recorder = new AuditRecorder({ logger });
        await db.transaction((trx) =>
            recorder.record(trx, { actor: { kind: "system" }, action: "test.performed", entityType: "test_entity", entityId: 7, metadata: {} }),
        );
        const rows = await ownerDb.raw<{ rows: Array<{ count: number }> }>(
            "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'test.performed' AND entity_id = 7",
        );
        expect(rows.rows[0]?.count).toBe(1);
        await truncateAll(); // later cases count audit rows from zero
    });

    it("should pin the function's search_path, lock_timeout, SECURITY DEFINER, and owner", async () => {
        const result = await ownerDb.raw<{ rows: Array<{ prosecdef: boolean; proconfig: string[]; owner: string; public_exec: boolean }> }>(
            `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                    has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
             FROM pg_proc p WHERE p.proname = 'audit_logs_ensure_partitions'`,
        );
        expect(result.rows).toHaveLength(1);
        const fn = result.rows[0];
        expect(fn?.prosecdef).toBe(true);
        expect(fn?.proconfig).toEqual(expect.arrayContaining(["search_path=pg_catalog, pg_temp", "lock_timeout=200ms"]));
        expect(fn?.owner).toBe(new URL(OWNER_URL).username);
        expect(fn?.public_exec).toBe(false);
    });

    it("should deny EXECUTE on audit_logs_ensure_partitions to a role outside vcare_app", async () => {
        const role = `care_probe_${randomBytes(4).toString("hex")}`;
        const password = randomBytes(12).toString("hex");
        throwaway.push(role);
        const ddl = await ownerDb.raw<{ rows: Array<{ ddl: string }> }>(
            "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', ?::text, ?::text) AS ddl",
            [role, password],
        );
        await ownerDb.raw(ddl.rows[0]?.ddl ?? "");

        await withPool(urlFor(role, password), async (outsider) => {
            await expect(outsider.raw("SELECT * FROM audit_logs_ensure_partitions(0)")).rejects.toMatchObject({ code: "42501" });
            await expect(outsider.raw("SELECT count(*) FROM audit_logs")).rejects.toMatchObject({ code: "42501" });
        });
    });

    it("should make ensureAppLogin idempotent and resync the password and membership on a second run (A14)", async () => {
        const app = new URL(APP_URL);
        // Drift: a rotated password and a lost membership.
        await ownerDb.raw(`ALTER ROLE ${app.username} PASSWORD 'synthetic-drifted-pw-1180'`);
        await ownerDb.raw(`REVOKE vcare_app FROM ${app.username}`);
        await expect(withPool(APP_URL, (conn) => conn.raw("SELECT 1"))).rejects.toMatchObject({ code: "28P01" });

        await expect(ensureAppLogin(ownerDb, APP_URL)).resolves.toEqual({ created: false });
        await expect(ensureAppLogin(ownerDb, APP_URL)).resolves.toEqual({ created: false });

        await withPool(APP_URL, async (conn) => {
            const result = await conn.raw<{ rows: Array<{ count: number }> }>("SELECT count(*)::int AS count FROM audit_logs");
            expect(result.rows[0]?.count).toBe(0);
        });
    });

    it("should create a new login with the role attributes and vcare_app membership, then report created=false (A14)", async () => {
        const role = `care_app_probe_${randomBytes(3).toString("hex")}`;
        const password = `p'w"${randomBytes(6).toString("hex")}`; // quoting is PostgreSQL's (%L), not ours
        throwaway.push(role);
        const url = urlFor(role, password);

        await expect(ensureAppLogin(ownerDb, url)).resolves.toEqual({ created: true });
        await expect(ensureAppLogin(ownerDb, url)).resolves.toEqual({ created: false });

        const attrs = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, pg_has_role(rolname, 'vcare_app', 'MEMBER') AS member
             FROM pg_roles WHERE rolname = ?`,
            [role],
        );
        expect(attrs.rows[0]).toEqual({
            rolcanlogin: true,
            rolinherit: true,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            member: true,
        });
        await withPool(url, async (conn) => {
            await expect(conn.raw("SELECT count(*) FROM audit_logs")).resolves.toBeDefined();
            await expect(conn.raw("DELETE FROM audit_logs")).rejects.toMatchObject({ code: "42501" });
        });
    });

    it("should refuse to take over an existing login that holds CREATEDB and leave it untouched (L1)", async () => {
        const role = `care_app_priv_${randomBytes(3).toString("hex")}`;
        const password = `synthetic-${randomBytes(6).toString("hex")}`;
        throwaway.push(role);
        await ownerDb.raw(`CREATE ROLE ${role} WITH LOGIN CREATEDB PASSWORD 'synthetic-original-pw-5521'`);

        await expect(ensureAppLogin(ownerDb, urlFor(role, password))).rejects.toThrow(/^app_login_role_privileged$/);

        const attrs = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT rolcreatedb, pg_has_role(rolname, 'vcare_app', 'MEMBER') AS member FROM pg_roles WHERE rolname = ?`,
            [role],
        );
        // Refused, not demoted: no attribute, membership, or password change happened (the transaction rolled back).
        expect(attrs.rows[0]).toEqual({ rolcreatedb: true, member: false });
        await expect(withPool(urlFor(role, password), (conn) => conn.raw("SELECT 1"))).rejects.toMatchObject({ code: "28P01" });
    });

    it.each([
        ["the owner role (current_user)", "owner"],
        ["pg_write_all_data", "pg_write_all_data"],
    ])(
        "should refuse to take over an existing login that is a member of %s and leave its membership untouched (review 2026-10-03)",
        async (_label, granted) => {
            const role = `care_app_member_${randomBytes(3).toString("hex")}`;
            const password = `synthetic-${randomBytes(6).toString("hex")}`;
            throwaway.push(role);
            await ownerDb.raw(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'synthetic-original-pw-7730'`);
            const ownerRole = (await ownerDb.raw<{ rows: Array<{ current_user: string }> }>("SELECT current_user")).rows[0]
                ?.current_user;
            const parent = granted === "owner" ? ownerRole : granted;
            expect(parent).toBeDefined();
            await ownerDb.raw("GRANT ?? TO ??", [parent ?? "", role]);

            const before = await ownerDb.raw<{ rows: Array<{ parents: string[] }> }>(
                `SELECT array_agg(g.rolname::text ORDER BY g.rolname) AS parents
                 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
                 WHERE r.rolname = ?`,
                [role],
            );
            expect(before.rows[0]?.parents).toEqual([parent]);

            await expect(ensureAppLogin(ownerDb, urlFor(role, password))).rejects.toThrow(/^app_login_role_privileged$/);

            const after = await ownerDb.raw<{ rows: Array<{ parents: string[] }> }>(
                `SELECT array_agg(g.rolname::text ORDER BY g.rolname) AS parents
                 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member
                 WHERE r.rolname = ?`,
                [role],
            );
            // Refused before any DDL: not added to vcare_app, the other membership kept, the password unchanged.
            expect(after.rows[0]?.parents).toEqual([parent]);
            await expect(withPool(urlFor(role, password), (conn) => conn.raw("SELECT 1"))).rejects.toMatchObject({ code: "28P01" });
        },
    );

    it("should provision the app login through `migrate ensure-app-login` and log only created (CLI)", async () => {
        const result = await runMigrate("ensure-app-login", { DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: OWNER_URL });
        expect(result.code).toBe(0);
        const ensured = jsonLines(result.output).find((line) => line.message === "app_login_ensured");
        expect(ensured).toMatchObject({ level: "info", created: false });
        // Neither URL (each carries a password) nor the app login's user:password pair reaches the output.
        expect(result.output).not.toContain(APP_URL);
        expect(result.output).not.toContain(OWNER_URL);
        expect(result.output).not.toContain(`${new URL(APP_URL).username}:${new URL(APP_URL).password}`);
    });

    it("should refuse to run when DATABASE_URL names the owner role (role collision) without echoing the URL", async () => {
        const collided = urlFor(new URL(OWNER_URL).username, "synthetic-collision-pw-7790");
        const result = await runMigrate("ensure-app-login", { DATABASE_URL: collided, MIGRATION_DATABASE_URL: OWNER_URL });
        expect(result.code).toBe(1);
        const line = jsonLines(result.output).find((entry) => entry.message === "invalid_environment");
        expect(line?.keys).toEqual(["MIGRATION_DATABASE_URL"]);
        expect(result.output).not.toContain("synthetic-collision-pw-7790");
        // The owner was not touched: its password still works.
        await expect(ownerDb.raw("SELECT 1")).resolves.toBeDefined();
        await withPool(OWNER_URL, (conn) => conn.raw("SELECT 1"));
    });

    it("should refuse ensure-app-login without MIGRATION_DATABASE_URL (care-api/worker never hold the owner secret)", async () => {
        const result = await runMigrate("ensure-app-login", { DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: "" });
        expect(result.code).toBe(1);
        expect(jsonLines(result.output).find((entry) => entry.message === "invalid_environment")?.keys).toEqual([
            "MIGRATION_DATABASE_URL",
        ]);
    });
});
