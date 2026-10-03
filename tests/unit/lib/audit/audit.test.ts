import type { Knex } from "knex";
import { actorFromAuth, AuditRecorder } from "../../../../src/lib/audit/audit";
import type { AuditEntry } from "../../../../src/lib/audit/types";
import { requestContext } from "../../../../src/lib/logger/request-context";
import { fakeLogger } from "../../../helpers/fake-logger";

const REQUEST_ID = "6fa459ea-ee8a-4ca4-894e-db77e160355e";

function fakeTrx(raw: jest.Mock = jest.fn(() => Promise.resolve({ rows: [] }))) {
    return { trx: { isTransaction: true, raw } as unknown as Knex.Transaction, raw };
}

function recorder() {
    const log = fakeLogger();
    return { audit: new AuditRecorder({ logger: log.logger }), log };
}

const entry = (overrides?: Partial<AuditEntry>): AuditEntry => ({
    actor: { kind: "user", userId: 7, role: "admin" },
    action: "specialty.created",
    entityType: "specialty",
    entityId: 12,
    metadata: { reason: "synthetic", count: 2, active: true, previous: null },
    ...overrides,
});

describe("lib/audit/AuditRecorder", () => {
    it("should insert one row with explicit columns, no RETURNING, and the context request id (A11)", async () => {
        const { audit } = recorder();
        const { trx, raw } = fakeTrx();
        await requestContext.run({ requestId: REQUEST_ID }, () => audit.record(trx, entry()));

        expect(raw).toHaveBeenCalledTimes(1);
        const [sql, bindings] = raw.mock.calls[0] as [string, unknown[]];
        expect(sql).toMatch(
            /^INSERT INTO audit_logs \(actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata\)\s+VALUES \(\?, \?, \?, \?, \?, \?, \?::jsonb\)$/,
        );
        expect(sql).not.toMatch(/RETURNING|\*/);
        expect(bindings).toEqual([
            7,
            "admin",
            "specialty.created",
            "specialty",
            12,
            REQUEST_ID,
            JSON.stringify({ reason: "synthetic", count: 2, active: true, previous: null }),
        ]);
    });

    it("should prefer an explicit requestId and store null when there is none (worker)", async () => {
        const { audit } = recorder();
        const explicit = fakeTrx();
        await audit.record(explicit.trx, entry({ requestId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }));
        expect((explicit.raw.mock.calls[0] as [string, unknown[]])[1][5]).toBe("7c9e6679-7425-40de-944b-e07fc1f90ae7");

        const none = fakeTrx();
        await audit.record(none.trx, entry({ actor: { kind: "system" } }));
        expect((none.raw.mock.calls[0] as [string, unknown[]])[1][5]).toBeNull();
    });

    it.each<[string, unknown]>([
        ["a plain Knex instance", { isTransaction: undefined, raw: jest.fn() }],
        ["undefined", undefined],
        ["an object claiming isTransaction as a string", { isTransaction: "true", raw: jest.fn() }],
    ])("should throw audit_requires_transaction when given %s (A11)", async (_label, conn) => {
        const { audit } = recorder();
        await expect(audit.record(conn as Knex.Transaction, entry())).rejects.toThrow("audit_requires_transaction");
    });

    it("should map user, service, and system actors to actor_user_id / actor_role (A12)", async () => {
        const { audit } = recorder();
        const cases: Array<[AuditEntry["actor"], number | null, string, Record<string, unknown>]> = [
            [{ kind: "user", userId: 101, role: "patient" }, 101, "patient", {}],
            [{ kind: "service", clientId: "ai-service" }, null, "service", { actorClientId: "ai-service" }],
            [{ kind: "system" }, null, "system", {}],
        ];
        for (const [actor, userId, role, extra] of cases) {
            const { trx, raw } = fakeTrx();
            await audit.record(trx, entry({ actor, metadata: { reason: "r" } }));
            const bindings = (raw.mock.calls[0] as [string, unknown[]])[1];
            expect(bindings[0]).toBe(userId);
            expect(bindings[1]).toBe(role);
            expect(JSON.parse(bindings[6] as string)).toEqual({ reason: "r", ...extra });
        }
    });

    it("should build a user actor from a verified AuthContext", () => {
        expect(actorFromAuth({ userId: 9, role: "doctor", status: "active", emailVerified: true })).toEqual({
            kind: "user",
            userId: 9,
            role: "doctor",
        });
    });

    const tooBig = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, "x".repeat(450)]));
    it.each<[string, Partial<AuditEntry>, string]>([
        ["an action without a dot", { action: "created" }, "action"],
        ["an action in CamelCase", { action: "Specialty.Created" }, "action"],
        ["an action over 64 chars", { action: `a.${"b".repeat(63)}` }, "action"],
        ["an entityType with a dash", { entityType: "medical-record" }, "entityType"],
        ["an entityType over 64 chars", { entityType: "e".repeat(65) }, "entityType"],
        ["entityId 0", { entityId: 0 }, "entityId"],
        ["a negative entityId", { entityId: -3 }, "entityId"],
        ["a fractional entityId", { entityId: 1.5 }, "entityId"],
        ["an unsafe entityId", { entityId: 2 ** 53 }, "entityId"],
        ["a user actor with userId 0", { actor: { kind: "user", userId: 0, role: "admin" } }, "actor.userId"],
        ["a user actor with an unknown role", { actor: { kind: "user", userId: 1, role: "root" as "admin" } }, "actor.role"],
        ["a service actor without a clientId", { actor: { kind: "service", clientId: "" } }, "actor.clientId"],
        ["a non-UUID requestId", { requestId: "req-1" }, "requestId"],
        ["metadata that is an array", { metadata: [] as unknown as AuditEntry["metadata"] }, "metadata"],
        ["a metadata key with a dot", { metadata: { "a.b": 1 } }, "metadata.a.b"],
        ["a metadata key starting with a digit", { metadata: { "1st": 1 } }, "metadata.1st"],
        ["a nested metadata value", { metadata: { nested: { a: 1 } as unknown as string } }, "metadata.nested"],
        ["an array metadata value", { metadata: { ids: [1, 2] as unknown as string } }, "metadata.ids"],
        ["a non-finite number", { metadata: { ratio: Number.NaN } }, "metadata.ratio"],
        ["a string over 500 chars", { metadata: { reason: "r".repeat(501) } }, "metadata.reason"],
        ["more than 20 keys", { metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }, "metadata"],
        ["a serialized object over 2 KB", { metadata: tooBig }, "metadata"],
        ["a redacted key (complaintText)", { metadata: { complaintText: "SYNTHETIC-COMPLAINT-7731" } }, "metadata.complaintText"],
        ["a redacted key (email)", { metadata: { email: "synthetic.patient@example.test" } }, "metadata.email"],
        ["a redacted key in another casing (full_name)", { metadata: { FullName: "Synthetic Person" } }, "metadata.FullName"],
        ["a service actor overriding actorClientId", { actor: { kind: "service", clientId: "c" }, metadata: { actorClientId: "x" } }, "metadata.actorClientId"],
    ])("should reject %s with audit_entry_invalid and insert nothing (A12)", async (_label, overrides, field) => {
        const { audit } = recorder();
        const { trx, raw } = fakeTrx();
        await expect(audit.record(trx, entry(overrides))).rejects.toThrow(`audit_entry_invalid: ${field}`);
        expect(raw).not.toHaveBeenCalled();
    });

    it("should never put a metadata value into the validation error", async () => {
        const { audit } = recorder();
        const { trx } = fakeTrx();
        await expect(audit.record(trx, entry({ metadata: { reason: `SYNTHETIC-COMPLAINT-7731${"r".repeat(600)}` } }))).rejects.toThrow(
            /^audit_entry_invalid: metadata\.reason$/,
        );
    });

    it("should log audit_write_failed and emit the metric without metadata, then rethrow, when the insert fails", async () => {
        const { audit, log } = recorder();
        const failure = Object.assign(new Error("permission denied for table audit_logs"), { code: "42501" });
        const { trx } = fakeTrx(jest.fn(() => Promise.reject(failure)));

        await expect(
            audit.record(trx, entry({ metadata: { reason: "SYNTHETIC-REASON-5150" } })),
        ).rejects.toBe(failure);
        expect(log.error).toHaveBeenCalledWith("audit_write_failed", {
            action: "specialty.created",
            entityType: "specialty",
            error: failure,
        });
        expect(log.metric).toHaveBeenCalledWith("audit_write_failed", 1, { action: "specialty.created" });
        expect(log.text()).not.toContain("SYNTHETIC-REASON-5150");
    });
});
