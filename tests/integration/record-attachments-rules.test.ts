import type { Knex } from "knex";
import type { Response } from "supertest";
import { RecordAttachmentsService } from "../../src/app/record-attachments/service/record-attachments.service";
import { RecordLinksService } from "../../src/app/records/service/record-links.service";
import { UploadIntentsService } from "../../src/app/upload-intents/service/upload-intents.service";
import { buildUploadIntentPurgeLoop } from "../../src/app/upload-intents/worker/upload-intent-purge.loop";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { createKnex, db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { StorageError } from "../../src/lib/storage/storage-error";
import type { AuthContext } from "../../src/lib/types/types";
import { bookingBody, localStart, OTHER_DOCTOR } from "../helpers/consultations-harness";
import { expectErrorEnvelope } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import {
    attachmentAudits, attachmentRows, FALSE_PDF, intentRows, JPEG, liveCount, PDF, PNG, recordSnapshot, storageCalls, useAttachmentsHarness,
} from "../helpers/record-attachments-fixtures";
import { amendmentRows, createRecord, getRecord, lockIn, lockNow, patchRecord, recordBody, seedCompleted, suspendLocally, withFailingAudit } from "../helpers/records-fixtures";

jest.setTimeout(120_000);

const INTENT_LOCK_NAMESPACE = 1101;

/** Polls a database or storage condition (never a fixed sleep); fails loudly with `label` when it does not hold in time. */
async function until(label: string, condition: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for: ${label}`);
}

describe("record attachments rules (integration: real routes, Postgres, Redis; storage, Identity and video faked)", () => {
    const kit = useAttachmentsHarness("record-attachments-rules");
    const { h, storage, newRecord, createIntent, complete, downloadUrl, remove, upload, add, addOk, seedAttachments } = kit;
    /** Every object key currently in the fake bucket under the final prefix. */
    const finalObjects = (): string[] => storageCalls(storage, "promote").map((args) => args[1] as string).filter((key) => storage.has(key));

    // ───────────────────────────────────────────── RA-R3 / RA-R5: only a verified object becomes a row
    describe("verification of the stored object at complete", () => {
        it.each([
            ["false bytes behind a .pdf name and an application/pdf type", FALSE_PDF],
            ["a truncated PDF signature", Buffer.from("%PDF")],
            ["an empty object", Buffer.alloc(0)],
            ["a GIF", Buffer.from("GIF89a synthetic")],
        ])("should reject %s with 400 on file, delete the quarantine object, close the intent and create no row and no audit row", async (_label, bytes) => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId, { bytes, description: "SYNTHETIC-ATTACH-DESC-0001" });
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "file", issue: "stored file is invalid" }]);
            expect(await attachmentRows()).toEqual([]);
            expect(storage.has(uploaded.quarantineKey)).toBe(false);
            expect(finalObjects()).toEqual([]);
            const [intent] = await intentRows();
            expect(intent?.consumed_at).not.toBeNull();
            expect(intent?.result_id).toBeNull();
            expect(await attachmentAudits()).toEqual([]);
            // A second try finds a closed intent without a result.
            const again = await complete(recordId, uploaded.uploadId);
            expect(again.status).toBe(409);
            expectErrorEnvelope(again.body, "Conflict");
        });

        it("should accept the shortest valid signatures: a 5 byte PDF header, a 3 byte JPEG marker and an 8 byte PNG signature", async () => {
            const recordId = await newRecord();
            for (const [bytes, type] of [[Buffer.from("%PDF-"), "application/pdf"], [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
                [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"]] as const) {
                const res = await add(recordId, { bytes });
                expect([type, res.status, res.body.data?.fileType]).toEqual([type, 201, type]);
            }
        });

        it("should reject an object over 10485760 bytes by its HEAD size without reading its bytes", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            storage.setHeadSize(uploaded.quarantineKey, 10_485_761);
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field: "file", issue: "stored file is invalid" }]);
            expect(storageCalls(storage, "readHead")).toEqual([]);
            expect(storage.has(uploaded.quarantineKey)).toBe(false);
            expect(await attachmentRows()).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).not.toBeNull();
        });

        it("should reject a declared size of 0 without reading its bytes", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            storage.setHeadSize(uploaded.quarantineKey, 0);
            expect((await complete(recordId, uploaded.uploadId)).status).toBe(400);
            expect(storageCalls(storage, "readHead")).toEqual([]);
            expect(await attachmentRows()).toEqual([]);
        });

        it("should reject a missing object (never uploaded) with 400, close the intent and create no row", async () => {
            const recordId = await newRecord();
            const intent = await createIntent(recordId);
            const res = await complete(recordId, intent.body.data.uploadId);
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field: "file", issue: "stored file is invalid" }]);
            expect(await attachmentRows()).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).not.toBeNull();
        });

        it("should answer 410, delete the quarantine object, close the intent and create no row when the intent has expired", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            await ownerDb("upload_intents").where({ id: uploaded.uploadId }).update({ expires_at: new Date(Date.now() - 1_000) });
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(410);
            expectErrorEnvelope(res.body, "UploadIntentExpired");
            expect(storage.has(uploaded.quarantineKey)).toBe(false);
            expect(storageCalls(storage, "headObject")).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).not.toBeNull();
            expect(await attachmentRows()).toEqual([]);
            expect(await attachmentAudits()).toEqual([]);
        });

        it("should answer 500 and keep the intent open and the quarantine object when the storage HEAD fails, then succeed on retry", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            const spy = jest.spyOn(storage, "headObject").mockRejectedValueOnce(new StorageError("head"));
            try {
                const res = await complete(recordId, uploaded.uploadId);
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
            } finally { spy.mockRestore(); }
            expect(await attachmentRows()).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).toBeNull();
            expect(storage.has(uploaded.quarantineKey)).toBe(true);
            expect(await attachmentAudits()).toEqual([]);
            expect((await complete(recordId, uploaded.uploadId)).status).toBe(201);
        });

        it("should answer 500 and keep the intent open when the promote copy fails, create no row, and let a retry succeed", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            storage.failNextCopy();
            const failed = await complete(recordId, uploaded.uploadId);
            expect(failed.status).toBe(500);
            expectErrorEnvelope(failed.body, "InternalError");
            expect(await attachmentRows()).toEqual([]);
            expect(await attachmentAudits()).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).toBeNull();
            expect(storage.has(uploaded.quarantineKey)).toBe(true);
            const retry = await complete(recordId, uploaded.uploadId);
            expect(retry.status).toBe(201);
            expect(await attachmentRows()).toHaveLength(1);
        });

        it("should answer 500, create no row and keep the intent open when the object is re-POSTed after the checks (ETag-bound promote)", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            storage.replaceAfterNextHead(uploaded.quarantineKey, Buffer.from("%PDF-1.7 a different object posted after the checks"));
            const failed = await complete(recordId, uploaded.uploadId);
            expect(failed.status).toBe(500);
            expect(await attachmentRows()).toEqual([]);
            expect(await attachmentAudits()).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).toBeNull();
            expect(finalObjects()).toEqual([]);
            // The swapped object is a valid PDF itself, so a retry inspects and promotes what is stored now.
            expect((await complete(recordId, uploaded.uploadId)).status).toBe(201);
        });

        it("should roll the attachment back, delete the promoted object and keep the intent open when the audit insert fails", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId, { description: "SYNTHETIC-ATTACH-DESC-0001" });
            await withFailingAudit("attachment.added", async () => {
                const res = await complete(recordId, uploaded.uploadId);
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
            });
            expect(await attachmentRows()).toEqual([]);
            expect(await attachmentAudits()).toEqual([]);
            const [promote] = storageCalls(storage, "promote");
            expect(promote).toBeDefined();
            expect(storage.has(promote?.[1] as string)).toBe(false);
            expect(storageCalls(storage, "delete").map((args) => args[0])).toContain(promote?.[1]);
            const [intent] = await intentRows();
            expect(intent?.consumed_at).toBeNull();
            expect(intent?.result_id).toBeNull();
            // The quarantine object was deleted by the promote step, so the retry finds it gone: 400 and the intent closes (SD3).
            const retry = await complete(recordId, uploaded.uploadId);
            expect(retry.status).toBe(400);
            expect((await intentRows())[0]?.consumed_at).not.toBeNull();
        });
    });

    // ───────────────────────────────────────────── Case 3: a suspension committed during the storage round trip blocks the write
    describe("local suspension during complete", () => {
        it("should answer 403, create no row and no attachment.added audit row, delete the promoted object and keep the intent open when the doctor is suspended mid-complete", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId, { description: "SYNTHETIC-ATTACH-DESC-0001" });
            storage.beforeNextPromote(async () => { await suspendLocally(); });
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
            expect(await attachmentRows()).toEqual([]);
            expect(await attachmentAudits()).toEqual([]);
            const [promote] = storageCalls(storage, "promote");
            expect(promote).toBeDefined();
            expect(storage.has(promote?.[1] as string)).toBe(false);
            expect(storageCalls(storage, "delete").map((args) => args[0])).toContain(promote?.[1]);
            const [intent] = await intentRows();
            expect(intent?.consumed_at).toBeNull();
            expect(intent?.result_id).toBeNull();
        });
    });

    // ───────────────────────────────────────────── RA-R4: intents are owner, record, kind bound and single use
    describe("intent binding and replay", () => {
        it("should answer 404 and touch no storage when another doctor owns the intent", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            await ownerDb("upload_intents").where({ id: uploaded.uploadId }).update({ owner_user_id: OTHER_DOCTOR });
            storage.calls.length = 0;
            const res = await complete(recordId, uploaded.uploadId);
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
            expect(storage.calls).toEqual([]);
            expect(await attachmentRows()).toEqual([]);
            expect((await intentRows())[0]?.consumed_at).toBeNull();
        });

        it("should answer 404 and touch no storage when the intent belongs to another record of the same author", async () => {
            const first = await newRecord();
            const second = await newRecord();
            const uploaded = await upload(first);
            storage.calls.length = 0;
            const res = await complete(second, uploaded.uploadId);
            expect(res.status).toBe(404);
            expect(storage.calls).toEqual([]);
            expect(await attachmentRows()).toEqual([]);
            expect((await complete(first, uploaded.uploadId)).status).toBe(201);
        });

        it("should answer 404 and touch no storage when the intent is a verification-document intent", async () => {
            const recordId = await newRecord();
            const [row] = await ownerDb("upload_intents").insert({
                kind: "verification_document", target_id: recordId, owner_user_id: 202, document_type: "license", quarantine_key: "quarantine/11111111-1111-4111-8111-111111111111",
                max_bytes: 10_485_760, expires_at: new Date(Date.now() + 600_000),
            }).returning("id");
            storage.seed("quarantine/11111111-1111-4111-8111-111111111111", PDF);
            const res = await complete(recordId, (row as { id: number }).id);
            expect(res.status).toBe(404);
            expect(storage.calls).toEqual([]);
            expect(await attachmentRows()).toEqual([]);
        });

        it("should answer 404 for an unknown intent id", async () => {
            const recordId = await newRecord();
            expect((await complete(recordId, 424_242)).status).toBe(404);
        });

        it("should return the same attachment with 200 on a replayed complete, with one row, one audit row and no second storage round trip", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId, { description: "SYNTHETIC-ATTACH-DESC-0001" });
            const first = await complete(recordId, uploaded.uploadId);
            storage.calls.length = 0;
            const replay = await complete(recordId, uploaded.uploadId);
            const third = await complete(recordId, uploaded.uploadId);
            expect([first.status, replay.status, third.status]).toEqual([201, 200, 200]);
            expect(replay.body.data).toEqual(first.body.data);
            expect(third.body.data).toEqual(first.body.data);
            expect(await attachmentRows()).toHaveLength(1);
            expect(await attachmentAudits()).toHaveLength(1);
            expect(storage.calls).toEqual([]);
        });

        it("should answer 409 Conflict on a replay whose attachment has since been deleted", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            const first = await complete(recordId, uploaded.uploadId);
            expect((await remove(recordId, first.body.data.id)).status).toBe(204);
            const replay = await complete(recordId, uploaded.uploadId);
            expect(replay.status).toBe(409);
            expectErrorEnvelope(replay.body, "Conflict");
            expect(await attachmentRows()).toHaveLength(1);
        });

        it("should let two concurrent completes of one intent create exactly one attachment, the loser replaying or conflicting", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            const results = await Promise.all([complete(recordId, uploaded.uploadId), complete(recordId, uploaded.uploadId)]);
            expect(results.filter((res) => res.status === 201)).toHaveLength(1);
            const loser = results.find((res) => res.status !== 201) as Response;
            expect([200, 409]).toContain(loser.status);
            if (loser.status === 409) { expectErrorEnvelope(loser.body, "Conflict"); expect(loser.headers["retry-after"]).toBe("1"); }
            expect(await attachmentRows()).toHaveLength(1);
            expect(await attachmentAudits()).toHaveLength(1);
        });

        it("should answer 409 with Retry-After 1 and touch no storage when another request holds the per-intent lock, then succeed once it is released", async () => {
            const recordId = await newRecord();
            const uploaded = await upload(recordId);
            storage.calls.length = 0;
            await ownerDb.transaction(async (trx) => {
                await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?::text, ?::bigint))", [String(uploaded.uploadId), INTENT_LOCK_NAMESPACE]);
                const res = await complete(recordId, uploaded.uploadId);
                expect(res.status).toBe(409);
                expectErrorEnvelope(res.body, "Conflict");
                expect(res.headers["retry-after"]).toBe("1");
            });
            expect(storage.calls).toEqual([]);
            expect(await attachmentRows()).toEqual([]);
            expect((await complete(recordId, uploaded.uploadId)).status).toBe(201);
        });
    });

    // ───────────────────────────────────────────── RA-R8: the cap of 20 live attachments
    describe("cap of 20 live attachments", () => {
        it("should accept the 20th attachment, refuse the 21st complete and the 21st intent, and free a slot when one is deleted", async () => {
            const recordId = await newRecord();
            await seedAttachments(recordId, 18);
            const nineteenth = await addOk(recordId);
            const twentiethUpload = await upload(recordId);
            const twentyFirstUpload = await upload(recordId);
            expect((await complete(recordId, twentiethUpload.uploadId)).status).toBe(201);
            expect(await liveCount(recordId)).toBe(20);

            // The 21st complete is refused BEFORE any storage call: the quarantine object stays and the intent stays open.
            storage.calls.length = 0;
            const refused = await complete(recordId, twentyFirstUpload.uploadId);
            expect(refused.status).toBe(409);
            expectErrorEnvelope(refused.body, "AttachmentLimitReached");
            expect(refused.headers["retry-after"]).toBeUndefined();
            expect(storage.calls).toEqual([]);
            expect(storage.has(twentyFirstUpload.quarantineKey)).toBe(true);
            expect((await intentRows()).find((row) => String(row.id) === String(twentyFirstUpload.uploadId))?.consumed_at).toBeNull();
            const refusedIntent = await createIntent(recordId);
            expect(refusedIntent.status).toBe(409);
            expectErrorEnvelope(refusedIntent.body, "AttachmentLimitReached");

            // A removal frees a slot; the SAME intent then completes.
            expect((await remove(recordId, nineteenth)).status).toBe(204);
            expect(await liveCount(recordId)).toBe(19);
            expect((await createIntent(recordId)).status).toBe(201);
            const retry = await complete(recordId, twentyFirstUpload.uploadId);
            expect(retry.status).toBe(201);
            expect(await liveCount(recordId)).toBe(20);
        });

        it("should count live attachments per record: deleted rows and another record's rows do not count toward the cap", async () => {
            const recordId = await newRecord();
            const other = await newRecord();
            await seedAttachments(other, 20);
            await seedAttachments(recordId, 12);
            await seedAttachments(recordId, 8, { deleted_at: new Date() });
            expect(await liveCount(recordId)).toBe(12);
            expect((await createIntent(recordId)).status).toBe(201);
            expect((await add(recordId)).status).toBe(201);
            expect((await createIntent(other)).status).toBe(409); // the full record is refused; the count is per record
        });

        it("should answer exactly one 201 and one 409 AttachmentLimitReached when two completes race for the last slot at 19", async () => {
            for (let round = 0; round < 3; round += 1) {
                const recordId = await newRecord();
                await seedAttachments(recordId, 19);
                const [a, b] = [await upload(recordId), await upload(recordId)];
                const results = await Promise.all([complete(recordId, a.uploadId), complete(recordId, b.uploadId)]);
                expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
                const loser = results.find((res) => res.status === 409) as Response;
                expectErrorEnvelope(loser.body, "AttachmentLimitReached");
                expect(loser.headers["retry-after"]).toBeUndefined();
                expect(await liveCount(recordId)).toBe(20);
                expect((await attachmentAudits()).filter((row) => row.entity_type === "record_attachment" && row.metadata.recordId === recordId)).toHaveLength(1);
            }
        });

        it("should hold the cap inside the transaction: two completes that both pass the courtesy check at 19 cannot both insert, and the loser leaves no orphan object", async () => {
            const recordId = await newRecord();
            await seedAttachments(recordId, 19);
            const [a, b] = [await upload(recordId), await upload(recordId)];
            storage.calls.length = 0;
            // Block both requests on the record row, after they passed the cap precheck and promoted their objects.
            const release = await new Promise<() => void>((resolveHolder) => {
                void ownerDb.transaction(async (trx) => {
                    await trx.raw("SELECT id FROM medical_records WHERE id = ? FOR UPDATE", [recordId]);
                    await new Promise<void>((resolveRelease) => resolveHolder(resolveRelease));
                });
            });
            const pending = Promise.all([complete(recordId, a.uploadId), complete(recordId, b.uploadId)]);
            try {
                await until("both completes promoted their objects and wait on the record row", () => storageCalls(storage, "promote").length === 2);
            } finally { release(); }
            const results = await pending;
            expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
            const loserIndex = results.findIndex((res) => res.status === 409);
            const loser = [a, b][loserIndex] as typeof a;
            const winner = [a, b][1 - loserIndex] as typeof a;
            expectErrorEnvelope(results[loserIndex]?.body, "AttachmentLimitReached");
            expect(await liveCount(recordId)).toBe(20);
            // No orphan: the only final object left in the bucket is the winner's row.
            const winnerRow = (await attachmentRows()).find((row) => row.id === results[1 - loserIndex]?.body.data.id);
            expect(winnerRow).toBeDefined();
            expect(finalObjects()).toEqual([winnerRow?.object_key]);
            const intents = await intentRows();
            expect(intents.find((row) => String(row.id) === String(winner.uploadId))?.consumed_at).not.toBeNull();
            // SD3: the loser's intent stays open with its quarantine object gone; a retry at the cap answers 409 again.
            expect(intents.find((row) => String(row.id) === String(loser.uploadId))?.consumed_at).toBeNull();
            expect(storage.has(loser.quarantineKey)).toBe(false);
            expect((await complete(recordId, loser.uploadId)).status).toBe(409);
            // After a slot is freed, the retry finds the object gone: 400 and the intent closes.
            const [firstLive] = await attachmentRows();
            expect((await remove(recordId, firstLive?.id as number)).status).toBe(204);
            const late = await complete(recordId, loser.uploadId);
            expect(late.status).toBe(400);
            expect((await intentRows()).find((row) => String(row.id) === String(loser.uploadId))?.consumed_at).not.toBeNull();
        });
    });

    // ───────────────────────────────────────────── RA-R6: add before and after the lock, never touching the record
    describe("adding around the lock", () => {
        it("should add before the lock with afterLock false and leave the medical record row untouched", async () => {
            const recordId = await newRecord();
            await lockIn(recordId, 20_000);
            const before = await recordSnapshot(recordId);
            const res = await add(recordId);
            expect(res.status).toBe(201);
            const [audit] = await attachmentAudits();
            expect(audit?.metadata).toEqual({ recordId, fileType: "application/pdf", sizeBytes: PDF.length, afterLock: false });
            expect(await recordSnapshot(recordId)).toBe(before);
        });

        it("should add after the lock with afterLock true, no reason, no amendment and the medical record row byte for byte unchanged", async () => {
            const recordId = await newRecord();
            await lockNow(recordId);
            const before = await recordSnapshot(recordId);
            const intent = await createIntent(recordId, { description: "SYNTHETIC-ATTACH-DESC-0001" });
            expect(intent.status).toBe(201);
            const res = await add(recordId, { bytes: PNG });
            expect(res.status).toBe(201);
            const audit = (await attachmentAudits()).at(-1);
            expect(audit).toMatchObject({ action: "attachment.added", entity_type: "record_attachment", entity_id: res.body.data.id, metadata: { recordId, fileType: "image/png", afterLock: true } });
            expect(await recordSnapshot(recordId)).toBe(before);
            expect(await amendmentRows()).toEqual([]);
            const read = await getRecord(h, recordId, "patient");
            expect(read.body.data.isLocked).toBe(true);
            expect(read.body.data.attachments.map((item: { id: number }) => item.id)).toEqual([res.body.data.id]);
        });
    });

    // ───────────────────────────────────────────── RA-R7: removal is pre-lock only
    describe("removal and the lock", () => {
        it("should remove before the lock with 204, a soft delete and one attachment.removed audit row", async () => {
            const recordId = await newRecord();
            await lockIn(recordId, 20_000);
            const id = await addOk(recordId);
            expect((await remove(recordId, id)).status).toBe(204);
            const [row] = await attachmentRows();
            expect(row?.deleted_at).not.toBeNull();
            const removed = (await attachmentAudits()).filter((entry) => entry.action === "attachment.removed");
            expect(removed).toHaveLength(1);
            expect(removed[0]).toMatchObject({ actor_user_id: 202, actor_role: "doctor", entity_type: "record_attachment", entity_id: id, metadata: { recordId } });
        });

        it("should refuse removal after the lock with 409 RecordLocked, change nothing and write no removal audit row", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            await lockNow(recordId);
            const before = await attachmentRows();
            const res = await remove(recordId, id);
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "RecordLocked");
            expect(await attachmentRows()).toEqual(before);
            expect((await attachmentAudits()).filter((entry) => entry.action === "attachment.removed")).toEqual([]);
            // The attachment is still listed and still downloadable.
            expect((await getRecord(h, recordId, "patient")).body.data.attachments).toHaveLength(1);
            expect((await downloadUrl(recordId, id, "patient")).status).toBe(200);
        });

        it("should answer 404 before 409 on a locked record for an absent, an already deleted and another record's attachment, and 409 only for a live one", async () => {
            const recordId = await newRecord();
            const other = await newRecord();
            const [keep] = [await addOk(recordId)];
            const deleted = await addOk(recordId);
            expect((await remove(recordId, deleted)).status).toBe(204);
            const foreign = await addOk(other);
            await lockNow(recordId);
            await lockNow(other);
            for (const [label, id, status] of [["absent", 999_999, 404], ["already deleted", deleted, 404], ["another record's", foreign, 404], ["live", keep, 409]] as const) {
                const res = await remove(recordId, id);
                expect([label, res.status]).toEqual([label, status]);
            }
        });

        it("should agree with the database trigger: a direct soft delete as the application role is refused after the lock and allowed before it", async () => {
            const open = await newRecord();
            const locked = await newRecord();
            const [openId, lockedId] = [await addOk(open), await addOk(locked)];
            await lockNow(locked);
            await expect(db("record_attachments").where({ id: lockedId }).update({ deleted_at: db.fn.now() }))
                .rejects.toMatchObject({ code: "23514", constraint: "trg_record_attachments_forbid_delete_after_lock" });
            await expect(db("record_attachments").where({ id: openId }).update({ deleted_at: db.fn.now() })).resolves.toBe(1);
            expect((await attachmentRows()).map((row) => [row.id, row.deleted_at === null])).toEqual([[openId, false], [lockedId, true]]);
        });

        it("should decide a removal by the lock state at the start of its transaction, the same verdict in the service and the trigger, when it waits across the lock instant", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            // The application pool cancels a statement after 2 s, so the whole wait must fit inside it.
            await lockIn(recordId, 1_200);
            const lockedAt = ((await ownerDb("medical_records").where({ id: recordId }).first("locked_at")).locked_at as Date).getTime();
            const release = await new Promise<() => void>((resolveHolder) => {
                void ownerDb.transaction(async (trx) => {
                    await trx.raw("SELECT id FROM medical_records WHERE id = ? FOR UPDATE", [recordId]);
                    await new Promise<void>((resolveRelease) => resolveHolder(resolveRelease));
                });
            });
            // A supertest request is lazy: `.then` is what sends it.
            const pending = remove(recordId, id).then((response) => response);
            try {
                await until("the removal waits on the record row", async () => (await ownerDb.raw<{ rows: unknown[] }>(
                    "SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')")).rows.length > 0);
                expect(Date.now()).toBeLessThan(lockedAt); // the transaction began before the lock instant, or this scenario proves nothing
                await until("the lock instant passes", () => Date.now() > lockedAt + 30, 1_800);
            } finally { release(); }
            const res = await pending;
            // Both the lock flag and the trigger read the transaction's NOW(): a transaction that began before the lock instant is allowed, never a 500.
            expect(res.status).toBe(204);
            expect((await attachmentRows())[0]?.deleted_at).not.toBeNull();
            // A removal that starts at or after the lock instant is refused.
            const later = await addOk(recordId);
            const second = await remove(recordId, later);
            expect(second.status).toBe(409);
            expectErrorEnvelope(second.body, "RecordLocked");
        });
    });

    // ───────────────────────────────────────────── RA-R19: the purge now covers attachment intents
    describe("abandoned intents", () => {
        it("should close an expired attachment intent made through the route, delete its quarantine object, and leave a fresh intent and a completed one alone", async () => {
            const recordId = await newRecord();
            const abandoned = await upload(recordId, { description: "SYNTHETIC-ATTACH-DESC-0001" });
            const fresh = await upload(recordId);
            const completedId = await addOk(recordId);
            await ownerDb("upload_intents").where({ id: abandoned.uploadId }).update({ expires_at: new Date(Date.now() - 1_000) });
            const loop = buildUploadIntentPurgeLoop({ service: container.resolve<UploadIntentsService>(TOKENS.UploadIntentsService), db, logger, intervalSeconds: 300 });
            await expect(loop.tick(new AbortController().signal)).resolves.toBe("done");
            expect(storage.has(abandoned.quarantineKey)).toBe(false);
            expect(storage.has(fresh.quarantineKey)).toBe(true);
            const rows = new Map((await intentRows()).map((row) => [String(row.id), row]));
            expect(rows.get(String(abandoned.uploadId))?.consumed_at).not.toBeNull();
            expect(rows.get(String(abandoned.uploadId))?.result_id).toBeNull();
            expect(rows.get(String(fresh.uploadId))?.consumed_at).toBeNull();
            expect((await attachmentRows()).map((row) => row.id)).toEqual([completedId]);
            // The purged intent is closed without a result: completing it is a conflict, never a row.
            const late = await complete(recordId, abandoned.uploadId);
            expect(late.status).toBe(409);
            expectErrorEnvelope(late.body, "Conflict");
            expect((await complete(recordId, fresh.uploadId)).status).toBe(201);
        });
    });

    // ───────────────────────────────────────────── RA-R20: lock order, no deadlocks
    describe("concurrency with other writers", () => {
        it("should finish a complete racing an in-place PATCH of the same record without a deadlock, many times", async () => {
            const recordId = await newRecord();
            for (let round = 0; round < 8; round += 1) {
                const uploaded = await upload(recordId);
                const results = await Promise.all([complete(recordId, uploaded.uploadId), patchRecord(h, recordId, { treatmentPlan: `SYNTHETIC-PLAN-${round}` }), complete(recordId, (await upload(recordId)).uploadId)]);
                expect(results.map((res) => res.status)).toEqual([201, 200, 201]);
            }
            expect(await liveCount(recordId)).toBe(16);
            const read = await getRecord(h, recordId, "doctor");
            expect(read.body.data.attachments).toHaveLength(16);
            expect(read.body.data.treatmentPlan).toBe("SYNTHETIC-PLAN-7");
        });

        it("should finish a delete racing a complete and a PATCH on one record without a deadlock", async () => {
            const recordId = await newRecord();
            const ids: number[] = [];
            for (let index = 0; index < 4; index += 1) ids.push(await addOk(recordId));
            const uploaded = await upload(recordId);
            const results = await Promise.all([remove(recordId, ids[0] as number), complete(recordId, uploaded.uploadId), patchRecord(h, recordId, { treatmentPlan: "SYNTHETIC-PLAN-X" }), remove(recordId, ids[1] as number)]);
            expect(results.map((res) => res.status)).toEqual([204, 201, 200, 204]);
            expect(await liveCount(recordId)).toBe(3);
        });

        it("should finish a follow-up booking of the record racing a complete without a deadlock, many times", async () => {
            const recordId = await newRecord();
            for (let round = 0; round < 4; round += 1) {
                const uploaded = await upload(recordId);
                const results = await Promise.all([
                    complete(recordId, uploaded.uploadId),
                    h.book("patient", bookingBody({ followUpOfRecordId: recordId, startsAt: localStart(5 + round, "10:00") })),
                ]);
                expect(results.map((res) => res.status)).toEqual([201, 201]);
                expect(results[1]?.body.data.followUpOfRecordId).toBe(recordId);
            }
            expect(await liveCount(recordId)).toBe(4);
        });

        it("should serialize two removals of different attachments and a creation of a third on the same record", async () => {
            const recordId = await newRecord();
            const [a, b] = [await addOk(recordId), await addOk(recordId)];
            const uploaded = await upload(recordId);
            const results = await Promise.all([remove(recordId, a), remove(recordId, b), complete(recordId, uploaded.uploadId)]);
            expect(results.map((res) => res.status)).toEqual([204, 204, 201]);
            expect(await liveCount(recordId)).toBe(1);
        });
    });

    // ───────────────────────────────────────────── misc rules
    describe("other rules", () => {
        it("should keep an attachment of a soft-deleted record unreachable", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            await ownerDb("medical_records").where({ id: recordId }).update({ deleted_at: new Date() });
            expect((await downloadUrl(recordId, id, "patient")).status).toBe(404);
            expect((await remove(recordId, id)).status).toBe(404);
            expect((await createIntent(recordId)).status).toBe(404);
        });

        it("should keep each doctor's records separate: a second author's attachments never appear on this author's record", async () => {
            const mine = await newRecord();
            const theirs = await createRecord(h, await seedCompleted(h, { doctor_user_id: OTHER_DOCTOR }), recordBody(), "otherDoctor");
            const a = await addOk(mine);
            const b = (await kit.add(theirs, { caller: "otherDoctor" })).body.data.id as number;
            expect(b).toBeDefined();
            expect((await getRecord(h, mine, "patient")).body.data.attachments.map((item: { id: number }) => item.id)).toEqual([a]);
            expect((await getRecord(h, theirs, "patient")).body.data.attachments.map((item: { id: number }) => item.id)).toEqual([b]);
        });

        it("should allow JPEG and PNG and PDF on the same record and keep each stored type", async () => {
            const recordId = await newRecord();
            for (const bytes of [PDF, PNG, JPEG]) await addOk(recordId, { bytes });
            expect((await attachmentRows()).map((row) => row.file_type)).toEqual(["application/pdf", "image/png", "image/jpeg"]);
        });
    });

    // ───────────────────────────────────────────── the per-intent session lock on small pools
    describe.each([2, 4])("session advisory locks on a pool of %i connections", (poolMax) => {
        const doctorAuth: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
        const advisoryLocks = (pool: Knex) => pool.raw<{ rows: Array<{ n: number }> }>(
            "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND a.application_name = 'care-test'");
        let pool: Knex;
        let small: RecordAttachmentsService;
        beforeEach(() => {
            pool = createKnex({ url: getEnv().DATABASE_URL, poolMax, statementTimeoutMs: 10_000, applicationName: "care-test" });
            small = new RecordAttachmentsService(pool, container.resolve(TOKENS.AuditRecorder), new RecordLinksService(pool), new UploadIntentsService(pool, storage, getEnv()), container.resolve(TOKENS.DoctorsService), storage, getEnv());
        });
        afterEach(async () => { await pool.destroy(); });

        it("should finish concurrent record_attachment completes without exhausting the pool or leaking an advisory lock, each outcome a row or a retryable Conflict", async () => {
            const recordId = await newRecord();
            const uploads = [];
            for (let index = 0; index < 4; index += 1) uploads.push(await upload(recordId));
            const results = await Promise.allSettled(uploads.map((uploaded) => small.complete(doctorAuth, recordId, uploaded.uploadId)));
            const fulfilled = results.filter((result) => result.status === "fulfilled");
            expect(fulfilled.length).toBeGreaterThanOrEqual(1);
            for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "Conflict", extra: { retryAfter: 1 } });
            expect((await advisoryLocks(pool)).rows[0]?.n).toBe(0);
            expect(await attachmentRows()).toHaveLength(fulfilled.length);
            expect(await attachmentAudits()).toHaveLength(fulfilled.length);
            // The refused ones are still open and complete once the pool is free again.
            for (const [index, result] of results.entries()) {
                if (result.status === "rejected") expect((await complete(recordId, (uploads[index] as { uploadId: number }).uploadId)).status).toBe(201);
            }
            expect(await liveCount(recordId)).toBe(4);
        });

        it("should serve a download-url and a delete while the pool is busy with completes", async () => {
            const recordId = await newRecord();
            const id = await addOk(recordId);
            const uploads = [await upload(recordId), await upload(recordId)];
            const results = await Promise.allSettled([
                ...uploads.map((uploaded) => small.complete(doctorAuth, recordId, uploaded.uploadId)), small.downloadUrl(doctorAuth, recordId, id), small.remove(doctorAuth, recordId, id),
            ]);
            expect(results.slice(2).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
            expect((await advisoryLocks(pool)).rows[0]?.n).toBe(0);
        });
    });
});
