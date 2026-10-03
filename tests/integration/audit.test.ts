import type { Express } from "express";
import request from "supertest";
import { actorFromAuth } from "../../src/lib/audit/audit";
import type { AuditRecorder } from "../../src/lib/audit/audit";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { db } from "../../src/lib/knex/knex";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { startFakeJwks, withFakeJwksCache } from "../helpers/fake-jwks";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady } from "../helpers/redis";
import { AUDIT_CLINICAL_FIXTURE, buildAuditTestRouter } from "../helpers/test-routers";
import { signUserToken } from "../helpers/tokens";
import type { FakeJwks } from "../helpers/types";

jest.setTimeout(20_000);

interface AuditRow {
    actor_user_id: number | null;
    actor_role: string;
    action: string;
    entity_type: string;
    entity_id: number;
    request_id: string | null;
    metadata: Record<string, unknown>;
    partition: string;
}

/** The current UTC month's partition name, e.g. `audit_logs_y2026m10`. */
function currentPartition(): string {
    const now = new Date();
    return `audit_logs_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Read as the OWNER so the assertion does not depend on the grants under test. */
async function auditRows(): Promise<AuditRow[]> {
    const result = await ownerDb.raw<{ rows: AuditRow[] }>(
        `SELECT actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata,
                tableoid::regclass::text AS partition
         FROM audit_logs ORDER BY id`,
    );
    return result.rows;
}

const auditRecorder = (): AuditRecorder => container.resolve<AuditRecorder>(TOKENS.AuditRecorder);

describe("audit log (integration: real Postgres as care_app)", () => {
    let fake: FakeJwks;
    let app: Express;
    let adminToken: string;

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["k1"]);
        app = buildTestApps({ publicRouters: [{ path: "/api", router: buildAuditTestRouter() }] }).publicApp;
        adminToken = await signUserToken(fake.key("k1"), { sub: "303", role: "admin" });
    });

    beforeEach(async () => {
        await truncateAll();
    });

    afterAll(async () => {
        await truncateAll();
        await fake.close();
        await closeRedis();
        await closeDb();
    });

    it("should write exactly one row with actor, action, entity, request id, and metadata when the transaction commits (A11)", async () => {
        const requestId = "9a0b7c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d";
        await withFakeJwksCache(fake, async () => {
            const res = await request(app)
                .post("/api/__test/audit")
                .set("Authorization", `Bearer ${adminToken}`)
                .set("X-Request-Id", requestId)
                .send({});
            expect(res.status).toBe(201);
            expect(expectSuccessEnvelope(res.body)).toEqual({ recorded: true });
        });
        expect(await auditRows()).toEqual([
            {
                actor_user_id: 303,
                actor_role: "admin",
                action: "test.performed",
                entity_type: "test_entity",
                entity_id: 1,
                request_id: requestId,
                metadata: { reason: "synthetic" },
                partition: currentPartition(), // a monthly partition, never audit_logs_default
            },
        ]);
    });

    it("should leave no row when the transaction rolls back (A11)", async () => {
        await withFakeJwksCache(fake, async () => {
            const res = await request(app).post("/api/__test/audit").set("Authorization", `Bearer ${adminToken}`).send({ fail: true });
            expect(res.status).toBe(500);
            expectErrorEnvelope(res.body, "InternalError");
        });
        expect(await auditRows()).toEqual([]);
    });

    it("should return 500 and write no row when the metadata is invalid, and never log the clinical value (A12)", async () => {
        const capture = captureLogs();
        try {
            await withFakeJwksCache(fake, async () => {
                const res = await request(app)
                    .post("/api/__test/audit")
                    .set("Authorization", `Bearer ${adminToken}`)
                    .send({ invalid: true });
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
                expect(JSON.stringify(res.body)).not.toContain(AUDIT_CLINICAL_FIXTURE);
            });
        } finally {
            capture.restore();
        }
        expect(await auditRows()).toEqual([]);
        expectNoSensitiveStrings(capture, [AUDIT_CLINICAL_FIXTURE]);
    });

    it("should deny a non-admin and write no row", async () => {
        await withFakeJwksCache(fake, async () => {
            const patient = await signUserToken(fake.key("k1"), { sub: "101", role: "patient" });
            const res = await request(app).post("/api/__test/audit").set("Authorization", `Bearer ${patient}`).send({});
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
            expect((await request(app).post("/api/__test/audit").send({})).status).toBe(401);
        });
        expect(await auditRows()).toEqual([]);
    });

    it("should make the row visible to other sessions only when the caller's transaction commits (A11)", async () => {
        let seenInside = -1;
        await db.transaction(async (trx) => {
            await auditRecorder().record(trx, {
                actor: { kind: "system" },
                action: "test.performed",
                entityType: "test_entity",
                entityId: 2,
                metadata: { reason: "visibility" },
            });
            seenInside = (await auditRows()).length; // another connection (owner pool)
        });
        expect(seenInside).toBe(0);
        expect(await auditRows()).toEqual([expect.objectContaining({ actor_user_id: null, actor_role: "system", entity_id: 2 })]);
    });

    it("should refuse the plain pool instead of opening a transaction itself (A11)", async () => {
        await expect(
            auditRecorder().record(db as never, {
                actor: actorFromAuth({ userId: 1, role: "admin", status: "active", emailVerified: true }),
                action: "test.performed",
                entityType: "test_entity",
                entityId: 3,
                metadata: {},
            }),
        ).rejects.toThrow("audit_requires_transaction");
        expect(await auditRows()).toEqual([]);
    });

    it("should store a service actor with a NULL user id and its client id in metadata", async () => {
        await db.transaction((trx) =>
            auditRecorder().record(trx, {
                actor: { kind: "service", clientId: "ai-service" },
                action: "doctor.summary_read",
                entityType: "doctor_profile",
                entityId: 9,
                metadata: {},
            }),
        );
        expect(await auditRows()).toEqual([
            expect.objectContaining({ actor_user_id: null, actor_role: "service", metadata: { actorClientId: "ai-service" } }),
        ]);
    });

    describe("grants: append-only for care_app (A13)", () => {
        const partitions = (): string[] => ["audit_logs", "audit_logs_default", currentPartition()];

        it("should connect the request pool as care_app", async () => {
            const result = await db.raw<{ rows: Array<{ user: string }> }>("SELECT current_user AS user");
            expect(result.rows[0]?.user).toBe("care_app");
        });

        it("should allow INSERT and SELECT as care_app", async () => {
            await db.raw(
                `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)
                 VALUES (7, 'admin', 'test.performed', 'test_entity', 5, NULL, '{}'::jsonb)`,
            );
            for (const table of partitions()) {
                const result = await db.raw<{ rows: Array<{ count: number }> }>(`SELECT count(*)::int AS count FROM ${table}`);
                expect(result.rows[0]?.count).toBe(table === "audit_logs_default" ? 0 : 1);
            }
        });

        it.each([
            ["UPDATE", (table: string) => `UPDATE ${table} SET action = 'test.tampered'`],
            ["DELETE", (table: string) => `DELETE FROM ${table}`],
            ["TRUNCATE", (table: string) => `TRUNCATE ${table}`],
        ])("should reject %s on audit_logs, audit_logs_default, and the monthly partition with 42501", async (_verb, sql) => {
            await ownerDb.raw(
                `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)
                 VALUES (7, 'admin', 'test.performed', 'test_entity', 5, NULL, '{}'::jsonb)`,
            );
            for (const table of partitions()) {
                await expect(db.raw(sql(table))).rejects.toMatchObject({ code: "42501" });
            }
            expect(await auditRows()).toEqual([expect.objectContaining({ action: "test.performed" })]);
        });
    });

    describe("database checks (A12)", () => {
        const insert = (values: string) =>
            db.raw(
                `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata) VALUES ${values}`,
            );

        it("should reject a metadata object over 4 KB at the database", async () => {
            await expect(
                db.raw(
                    `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)
                     VALUES (7, 'admin', 'test.performed', 'test_entity', 5, NULL, jsonb_build_object('pad', repeat('x', 4100)))`,
                ),
            ).rejects.toMatchObject({ code: "23514", constraint: "chk_audit_logs_metadata_size" });
        });

        it.each([
            ["a user actor without a user id", "(NULL, 'admin', 'test.performed', 'test_entity', 5, NULL, '{}')", "chk_audit_logs_actor_user_id"],
            ["a system actor with a user id", "(7, 'system', 'test.performed', 'test_entity', 5, NULL, '{}')", "chk_audit_logs_actor_user_id"],
            ["an unknown actor role", "(7, 'root', 'test.performed', 'test_entity', 5, NULL, '{}')", "chk_audit_logs_actor_role"],
            ["entity_id 0", "(7, 'admin', 'test.performed', 'test_entity', 0, NULL, '{}')", "chk_audit_logs_entity_id_positive"],
            ["metadata that is an array", "(7, 'admin', 'test.performed', 'test_entity', 5, NULL, '[]')", "chk_audit_logs_metadata_object"],
        ])("should reject %s at the database", async (_label, values, constraint) => {
            await expect(insert(values)).rejects.toMatchObject({ code: "23514", constraint });
        });
    });
});
