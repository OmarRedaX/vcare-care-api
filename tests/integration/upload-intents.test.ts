import type { Knex } from "knex";
import { UPLOAD_INTENT_LOCK_NAMESPACE } from "../../src/app/upload-intents/constants";
import { UploadIntentKind } from "../../src/app/upload-intents/enums";
import { UploadIntentsService } from "../../src/app/upload-intents/service/upload-intents.service";
import type { CompleteRequest } from "../../src/app/upload-intents/types";
import { buildUploadIntentPurgeLoop } from "../../src/app/upload-intents/worker/upload-intent-purge.loop";
import { getEnv } from "../../src/lib/config/env";
import { createKnex, db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { InMemoryObjectStorage } from "../helpers/fake-storage";

jest.setTimeout(30_000);
const OWNER = 202;
const PDF = Buffer.from("%PDF-1.7 synthetic upload-intents file");
const KINDS = [UploadIntentKind.VerificationDocument, UploadIntentKind.RecordAttachment] as const;
type Row = { id: number };

/** The shared upload-intent lifecycle on the real database (ADR 0022): both kinds go through the same service with module callbacks. */
describe("upload-intents (integration: real Postgres, in-memory storage)", () => {
    const storage = new InMemoryObjectStorage();
    const service = new UploadIntentsService(db, storage, getEnv());
    const kindFields = (kind: UploadIntentKind) => kind === UploadIntentKind.VerificationDocument ? { documentType: "license", description: null } : { documentType: null, description: "SYNTHETIC-UPLOAD-DESC" };
    const open = async (kind: UploadIntentKind, svc: UploadIntentsService = service, owner = OWNER): Promise<{ id: number; key: string }> => {
        const created = await svc.create({ kind, targetId: 1, ownerUserId: owner, ...kindFields(kind) });
        const row = await ownerDb("upload_intents").where("id", created.uploadId).first();
        return { id: Number(row.id), key: String(row.quarantine_key) };
    };
    const insertResult = jest.fn();
    const request = (uploadId: number, kind: UploadIntentKind, owner = OWNER): CompleteRequest<Row, number> => ({
        uploadId, kind, ownerUserId: owner, finalKeyPrefix: kind === UploadIntentKind.VerificationDocument ? "verification-documents/" : "record-attachments/",
        authorizeTarget: (intent) => Promise.resolve(intent.target_id), findResult: (resultId) => Promise.resolve({ id: resultId }), precheck: () => Promise.resolve(),
        insertResult: insertResult as CompleteRequest<Row, number>["insertResult"],
    });

    beforeEach(async () => { await truncateAll(); storage.clear(); insertResult.mockReset(); insertResult.mockImplementation(() => Promise.resolve({ row: { id: 900 }, id: 900 })); });
    afterAll(async () => { await truncateAll(); await closeDb(); });

    describe.each(KINDS)("complete for kind %s", (kind) => {
        it("should store the intent row, promote the verified object, insert through the callback and close the intent with its result", async () => {
            const upload = await open(kind); storage.seed(upload.key, PDF);
            const stored = await ownerDb("upload_intents").where("id", upload.id).first();
            expect([stored.kind, stored.target_id, stored.owner_user_id, stored.max_bytes, stored.consumed_at]).toEqual([kind, 1, OWNER, 10_485_760, null]);
            const completed = await service.complete(request(upload.id, kind));
            expect(completed).toEqual({ row: { id: 900 }, replay: false });
            const promote = storage.calls.find((c) => c.operation === "promote");
            expect(String(promote?.args[1])).toMatch(kind === UploadIntentKind.VerificationDocument ? /^verification-documents\// : /^record-attachments\//);
            expect(storage.has(upload.key)).toBe(false); expect(storage.has(String(promote?.args[1]))).toBe(true);
            const closed = await ownerDb("upload_intents").where("id", upload.id).first();
            expect(closed.consumed_at).not.toBeNull(); expect(String(closed.result_id)).toBe("900");
            expect(insertResult).toHaveBeenCalledWith(expect.objectContaining({ fileType: "application/pdf", sizeBytes: PDF.length, intent: expect.objectContaining({ id: upload.id, kind }) }), expect.anything());
        });

        it("should replay the created row without a second insert or storage call", async () => {
            const upload = await open(kind); storage.seed(upload.key, PDF);
            await service.complete(request(upload.id, kind)); storage.calls.length = 0;
            await expect(service.complete(request(upload.id, kind))).resolves.toEqual({ row: { id: 900 }, replay: true });
            expect(insertResult).toHaveBeenCalledTimes(1); expect(storage.calls).toEqual([]);
        });

        it("should hide another owner's intent and an intent of the other kind", async () => {
            const upload = await open(kind); storage.seed(upload.key, PDF);
            await expect(service.complete(request(upload.id, kind, 999))).rejects.toMatchObject({ code: "NotFound" });
            const other = kind === UploadIntentKind.VerificationDocument ? UploadIntentKind.RecordAttachment : UploadIntentKind.VerificationDocument;
            await expect(service.complete(request(upload.id, other))).rejects.toMatchObject({ code: "NotFound" });
            expect(storage.calls.filter((c) => c.operation !== "createUploadPolicy")).toEqual([]);
        });

        it("should reject false bytes behind a pdf name, delete the object, close the intent and insert nothing", async () => {
            const upload = await open(kind); storage.seed(upload.key, Buffer.from("fake PDF bytes"));
            await expect(service.complete(request(upload.id, kind))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "file", issue: "stored file is invalid" }] });
            expect(insertResult).not.toHaveBeenCalled(); expect(storage.has(upload.key)).toBe(false);
            expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).not.toBeNull();
        });

        it("should answer UploadIntentExpired, delete the object and close an expired intent", async () => {
            const upload = await open(kind); storage.seed(upload.key, PDF);
            await ownerDb("upload_intents").where("id", upload.id).update({ expires_at: new Date(Date.now() - 1000) });
            await expect(service.complete(request(upload.id, kind))).rejects.toMatchObject({ code: "UploadIntentExpired" });
            expect(storage.has(upload.key)).toBe(false); expect(insertResult).not.toHaveBeenCalled();
            expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).not.toBeNull();
        });

        it("should roll the short transaction back, delete the promoted object and keep the intent open when the insert fails", async () => {
            const upload = await open(kind); storage.seed(upload.key, PDF);
            insertResult.mockRejectedValueOnce(new Error("synthetic insert failure"));
            await expect(service.complete(request(upload.id, kind))).rejects.toThrow("synthetic insert failure");
            const promote = storage.calls.find((c) => c.operation === "promote");
            expect(storage.has(String(promote?.args[1]))).toBe(false);
            expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).toBeNull();
        });

        it("should make one concurrent complete win and answer the other with a replay or a conflict", async () => {
            const upload = await open(kind); storage.seed(upload.key, PDF);
            const results = await Promise.allSettled([service.complete(request(upload.id, kind)), service.complete(request(upload.id, kind))]);
            expect(insertResult).toHaveBeenCalledTimes(1);
            expect(results.filter((r) => r.status === "fulfilled" && !r.value.replay)).toHaveLength(1);
            for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "Conflict" });
        });
    });

    describe("purge", () => {
        it("should close expired open intents of both kinds, delete their quarantine objects and leave the rest", async () => {
            const verification = await open(UploadIntentKind.VerificationDocument); const attachment = await open(UploadIntentKind.RecordAttachment);
            const fresh = await open(UploadIntentKind.RecordAttachment); const consumed = await open(UploadIntentKind.VerificationDocument);
            for (const upload of [verification, attachment, fresh, consumed]) storage.seed(upload.key, PDF);
            await ownerDb("upload_intents").whereIn("id", [verification.id, attachment.id, consumed.id]).update({ expires_at: new Date(Date.now() - 1000) });
            await ownerDb("upload_intents").where("id", consumed.id).update({ consumed_at: new Date(), result_id: 5 });
            const old = await open(UploadIntentKind.RecordAttachment);
            await ownerDb("upload_intents").where("id", old.id).update({ consumed_at: new Date(), result_id: 6, created_at: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
            const loop = buildUploadIntentPurgeLoop({ service, db, logger, intervalSeconds: 300 });
            await expect(loop.tick(new AbortController().signal)).resolves.toBe("done");
            expect(storage.has(verification.key)).toBe(false); expect(storage.has(attachment.key)).toBe(false);
            expect(storage.has(fresh.key)).toBe(true); expect(storage.has(consumed.key)).toBe(true);
            const rows = await ownerDb("upload_intents").select("id", "consumed_at", "result_id").orderBy("id");
            const byId = new Map(rows.map((row: { id: string; consumed_at: Date | null; result_id: string | null }) => [Number(row.id), row]));
            expect(byId.get(verification.id)?.consumed_at).not.toBeNull(); expect(byId.get(verification.id)?.result_id).toBeNull();
            expect(byId.get(attachment.id)?.consumed_at).not.toBeNull(); expect(byId.get(attachment.id)?.result_id).toBeNull();
            expect(byId.get(fresh.id)?.consumed_at).toBeNull();
            expect(String(byId.get(consumed.id)?.result_id)).toBe("5");
            expect(byId.has(old.id)).toBe(false);
        });

        it("should leave an expired intent open when the storage delete fails so the next tick retries", async () => {
            const upload = await open(UploadIntentKind.RecordAttachment); storage.seed(upload.key, PDF);
            await ownerDb("upload_intents").where("id", upload.id).update({ expires_at: new Date(Date.now() - 1000) });
            const failing = new InMemoryObjectStorage(); failing.seed(upload.key, PDF);
            const spy = jest.spyOn(failing, "delete").mockRejectedValueOnce(new Error("synthetic storage failure"));
            const loop = buildUploadIntentPurgeLoop({ service: new UploadIntentsService(db, failing, getEnv()), db, logger: { ...logger, error: jest.fn(), metric: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as typeof logger, intervalSeconds: 300 });
            await expect(loop.tick(new AbortController().signal)).resolves.toBe("incomplete");
            expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).toBeNull();
            spy.mockRestore();
            await expect(loop.tick(new AbortController().signal)).resolves.toBe("done");
            expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).not.toBeNull();
        });
    });

    describe.each([2, 4])("session advisory locks on a pool of %i connections", (poolMax) => {
        const advisoryLocks = (pool: Knex) => pool.raw<{ rows: Array<{ n: number }> }>("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND a.application_name = 'care-test'");
        let pool: Knex; let small: UploadIntentsService;
        beforeEach(() => { pool = createKnex({ url: getEnv().DATABASE_URL, poolMax, statementTimeoutMs: 10_000, applicationName: "care-test" }); small = new UploadIntentsService(pool, storage, getEnv()); });
        afterEach(async () => { await pool.destroy(); });

        it.each(KINDS)("should finish concurrent %s completes without exhausting the pool or leaking a lock", async (kind) => {
            const uploads: Array<{ id: number; key: string }> = [];
            for (let index = 0; index < 4; index += 1) { const upload = await open(kind, small); storage.seed(upload.key, PDF); uploads.push(upload); }
            const results = await Promise.allSettled(uploads.map((upload) => small.complete(request(upload.id, kind))));
            const outcomes = results.map((r) => r.status === "fulfilled" ? "completed" : `${(r.reason as { code?: string }).code ?? String(r.reason)}:${JSON.stringify((r.reason as { extra?: unknown }).extra ?? null)}`);
            expect(outcomes).toContain("completed");
            for (const outcome of outcomes) expect(["completed", "Conflict:{\"retryAfter\":1}"]).toContain(outcome);
            expect((await advisoryLocks(pool)).rows[0]?.n).toBe(0);
            expect(insertResult).toHaveBeenCalledTimes(results.filter((r) => r.status === "fulfilled").length);
        });
    });

    it("should keep the intent lock namespace at 1101", () => {
        expect(UPLOAD_INTENT_LOCK_NAMESPACE).toBe(1101);
    });
});
