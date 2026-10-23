import { randomUUID } from "node:crypto";
import type { Response } from "supertest";
import { logger } from "../../src/lib/logger/logger";
import { contractNoStoreValue } from "../helpers/contract";
import { PATIENT } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { captureLogs } from "../helpers/log-capture";
import { DERIVED_AVAILABILITY_PREFIXES } from "../helpers/redis";
import {
    ATTACH_DESC, ATTACH_DESC_2, ATTACH_MARKERS, attachmentRows, FALSE_PDF, intentRows, PNG, storageCalls, useAttachmentsHarness,
} from "../helpers/record-attachments-fixtures";
import {
    CHIEF, getRecord, lockNow, MARKERS, NOTES, patchRecord, PLAN, provisionOtherDoctor, scanRedis, STRANGER_DOCTOR, timeline, withFailingAudit,
} from "../helpers/records-fixtures";

jest.setTimeout(180_000);

/** Shapes that only a storage key, a presigned URL or a POST policy field can have. */
const STORAGE_SHAPES = [/record-attachments\//, /quarantine\//, /storage\.test/, /x-amz-/i, /X-Amz/, /"fields"/];

describe("record attachments privacy: logs, audit metadata, Redis, error bodies and views (integration: real routes, Postgres, Redis; storage faked)", () => {
    const kit = useAttachmentsHarness("record-attachments-privacy");
    const { h, storage, newRecord, createIntent, complete, downloadUrl, remove, upload, add, addOk, send } = kit;

    it("should keep every attachment marker, object key, URL and POST field out of the logs, audit rows, Redis and error bodies across writes, reads and rejected requests", async () => {
        const level = logger as unknown as { level: string };
        const previousLevel = level.level;
        level.level = "debug";
        const logs = captureLogs();
        const responses: Array<{ label: string; status: number; headers: Record<string, string>; text: string }> = [];
        const note = (label: string, res: Response): Response => {
            responses.push({ label, status: res.status, headers: res.headers, text: JSON.stringify(res.body) });
            return res;
        };
        const keys: string[] = [];
        try {
            await provisionOtherDoctor(h);
            const stranger = { token: await h.signFor(STRANGER_DOCTOR, "doctor") };
            const recordId = await newRecord();
            const marked = (text: string): string => `${text} on the left side`;

            // Writes that succeed.
            const intent = note("intent", await createIntent(recordId, { description: marked(ATTACH_DESC) }));
            expect(intent.status).toBe(201);
            const uploadId = intent.body.data.uploadId as number;
            storage.seed(intent.body.data.fields.key as string, PNG);
            const completed = note("complete", await complete(recordId, uploadId));
            expect(completed.status).toBe(201);
            const attachmentId = completed.body.data.id as number;
            note("replay", await complete(recordId, uploadId));
            note("download-patient", await downloadUrl(recordId, attachmentId, "patient"));
            note("download-author", await downloadUrl(recordId, attachmentId, "doctor"));
            note("download-related", await downloadUrl(recordId, attachmentId, "otherDoctor"));
            const second = await upload(recordId, { description: ATTACH_DESC_2 });
            const secondDone = note("complete-2", await complete(recordId, second.uploadId));
            note("remove", await remove(recordId, secondDone.body.data.id as number));
            // Reads and record writes while attachments exist.
            note("get-patient", await getRecord(h, recordId, "patient"));
            note("get-doctor", await getRecord(h, recordId, "doctor"));
            note("timeline", await timeline(h, PATIENT, "patient"));
            note("patch-inplace", await patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` }));
            note("patch-noop", await patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` }));

            // Rejected requests that carry the markers in their bodies or sit behind marked intents.
            note("blank", await createIntent(recordId, { description: `   ` }));
            note("too-long", await createIntent(recordId, { description: `${ATTACH_DESC}${"x".repeat(500)}` }));
            note("nul", await createIntent(recordId, { description: `${ATTACH_DESC}\u0000` }));
            note("null", await createIntent(recordId, { description: null }));
            note("unknown-member", await createIntent(recordId, { description: ATTACH_DESC, filename: `${ATTACH_DESC}.pdf`, objectKey: ATTACH_DESC }));
            note("array-body", await createIntent(recordId, [ATTACH_DESC]));
            note("body-on-complete", await complete(recordId, uploadId, "doctor", { description: ATTACH_DESC }));
            note("body-on-download", await downloadUrl(recordId, attachmentId, "patient", { description: ATTACH_DESC }));
            note("body-on-remove", await remove(recordId, attachmentId, "doctor", { description: ATTACH_DESC }));
            const bad = await upload(recordId, { bytes: FALSE_PDF, description: marked(ATTACH_DESC) });
            note("false-bytes", await complete(recordId, bad.uploadId));
            note("closed-intent", await complete(recordId, bad.uploadId));
            const expired = await upload(recordId, { description: marked(ATTACH_DESC) });
            await ownerDb("upload_intents").where({ id: expired.uploadId }).update({ expires_at: new Date(Date.now() - 1_000) });
            note("expired", await complete(recordId, expired.uploadId));
            note("patient-intent", await createIntent(recordId, { description: ATTACH_DESC }, "patient"));
            note("admin-intent", await createIntent(recordId, { description: ATTACH_DESC }, "admin"));
            note("admin-download", await downloadUrl(recordId, attachmentId, "admin"));
            note("stranger-intent", await createIntent(recordId, { description: ATTACH_DESC }, stranger));
            note("related-intent", await createIntent(recordId, { description: ATTACH_DESC }, "otherDoctor"));
            note("related-remove", await remove(recordId, attachmentId, "otherDoctor"));
            note("other-patient-download", await downloadUrl(recordId, attachmentId, "otherPatient"));
            note("unauthenticated", await createIntent(recordId, { description: ATTACH_DESC }, "anonymous"));
            note("absent-record", await createIntent(999_999, { description: ATTACH_DESC }));
            note("absent-attachment", await downloadUrl(recordId, 999_999, "patient"));
            note("non-numeric", await remove("abc", "abc"));
            // Audit failures: the 500 bodies and the error logs must stay clean too.
            const failingIntent = await upload(recordId, { description: marked(ATTACH_DESC) });
            await withFailingAudit("attachment.added", async () => { note("audit-500-added", await complete(recordId, failingIntent.uploadId)); });
            await withFailingAudit("attachment.url_issued", async () => { note("audit-500-url", await downloadUrl(recordId, attachmentId, "patient")); });
            await withFailingAudit("attachment.removed", async () => { note("audit-500-removed", await remove(recordId, attachmentId)); });
            // A storage failure in complete.
            const unlucky = await upload(recordId, { description: marked(ATTACH_DESC) });
            storage.failNextCopy();
            note("storage-500", await complete(recordId, unlucky.uploadId));
            // The lock: removal refused, adding allowed.
            await lockNow(recordId);
            note("locked-remove", await remove(recordId, attachmentId));
            note("locked-add", await add(recordId, { description: marked(ATTACH_DESC) }));
            // The cap: the intent of a full record is refused.
            await kit.seedAttachments(recordId, 20);
            note("cap-intent", await createIntent(recordId, { description: marked(ATTACH_DESC) }));
            // Rate limit: drain the read bucket with unknown ids until the limiter answers.
            for (let index = 0; index < 125; index += 1) {
                const res = await downloadUrl(recordId, 999_999, "otherDoctor");
                if (res.status === 429) { note("rate-limited", res); break; }
            }
            for (const row of await intentRows()) keys.push(row.quarantine_key as string);
            for (const row of await attachmentRows()) keys.push(row.object_key as string);
        } finally {
            logs.restore();
            level.level = previousLevel;
        }

        // 1. Logs: no marker, no key, no URL, no POST field, no credential.
        const text = logs.text();
        const uuids = keys.map((key) => key.split("/")[1] as string).filter((value) => /^[0-9a-f-]{36}$/.test(value));
        expect(uuids.length).toBeGreaterThan(3);
        const secrets = [...ATTACH_MARKERS, ...MARKERS, ...keys, ...uuids, ...Object.values(h.tokens), "Authorization", "Bearer "];
        for (const secret of secrets) expect([secret.slice(0, 28), text.includes(secret)]).toEqual([secret.slice(0, 28), false]);
        for (const shape of STORAGE_SHAPES) expect([String(shape), shape.test(text)]).toEqual([String(shape), false]);
        // Not vacuous: the attachment routes logged, with only the whitelisted fields, and the audit failures were recorded without row content.
        const lines = logs.lines();
        const completed = lines.filter((line) => line.message === "request_completed" && typeof line.route === "string" && /\/api\/(records\/|patients\/:patientUserId\/records)/.test(line.route));
        expect(completed.length).toBeGreaterThanOrEqual(45);
        for (const line of completed) {
            expect(Object.keys(line).every((key) => ["level", "message", "timestamp", "service", "requestId", "userId", "role", "route", "method", "status", "code", "durationMs"].includes(key))).toBe(true);
        }
        expect(new Set(completed.map((line) => line.route))).toEqual(new Set([
            "/api/records/:id/attachments/uploads", "/api/records/:id/attachments/uploads/:uploadId/complete", "/api/records/:id/attachments/:attachmentId/download-url",
            "/api/records/:id/attachments/:attachmentId", "/api/records/:id", "/api/patients/:patientUserId/records",
        ]));
        const auditFailures = lines.filter((line) => line.message === "audit_write_failed");
        expect(auditFailures.map((line) => line.action).sort()).toEqual(["attachment.added", "attachment.removed", "attachment.url_issued"]);
        expect(auditFailures.every((line) => line.entityType === "record_attachment")).toBe(true);

        // 2. Audit metadata: ids, types, sizes and flags only.
        const audit = JSON.stringify(await ownerDb("audit_logs").select("action", "entity_type", "metadata").orderBy("id"));
        for (const secret of [...ATTACH_MARKERS, ...MARKERS, ...keys, ...uuids, "https://", "storage.test"]) expect([secret, audit.includes(secret)]).toEqual([secret, false]);

        // 3. Redis: counters only; nothing that carries a description, a key or a URL.
        const redisEntries = await scanRedis();
        expect(redisEntries.length).toBeGreaterThan(0);
        const redisText = JSON.stringify(redisEntries);
        for (const secret of [...ATTACH_MARKERS, ...MARKERS, ...keys, ...uuids]) expect([secret, redisText.includes(secret)]).toEqual([secret, false]);
        for (const shape of STORAGE_SHAPES) expect([String(shape), shape.test(redisText)]).toEqual([String(shape), false]);
        expect(redisEntries.every((entry) => ["rl:", ...DERIVED_AVAILABILITY_PREFIXES].some((prefix) => entry.key.startsWith(prefix)))).toBe(true);
        expect(redisEntries.filter((entry) => entry.key.startsWith("idem:"))).toEqual([]);

        // 4. Error bodies of every rejected request: no description, no clinical text, no key, no URL.
        const rejected = responses.filter((res) => res.status >= 400);
        expect(rejected.length).toBeGreaterThanOrEqual(30);
        for (const res of rejected) {
            for (const secret of [...ATTACH_MARKERS, ...MARKERS, ...keys, ...uuids]) expect([res.label, secret, res.text.includes(secret)]).toEqual([res.label, secret, false]);
            for (const shape of STORAGE_SHAPES) expect([res.label, String(shape), shape.test(res.text)]).toEqual([res.label, String(shape), false]);
        }

        // 5. Every response, success or error, is uncacheable.
        for (const res of responses) expect([res.label, res.headers["cache-control"]]).toEqual([res.label, contractNoStoreValue()]);

        // The scenario produced the statuses it meant to (the scans above scan something).
        const statusOf = (label: string): number => responses.find((res) => res.label === label)?.status ?? 0;
        expect(["intent", "complete", "replay", "download-patient", "download-author", "download-related", "complete-2", "remove", "get-patient", "get-doctor", "timeline",
            "patch-inplace", "patch-noop"].map(statusOf)).toEqual([201, 201, 200, 200, 200, 200, 201, 204, 200, 200, 200, 200, 200]);
        expect(["blank", "too-long", "nul", "null", "unknown-member", "array-body", "body-on-complete", "body-on-download", "body-on-remove", "false-bytes", "closed-intent", "expired",
            "patient-intent", "admin-intent", "admin-download", "stranger-intent", "related-intent", "related-remove", "other-patient-download", "unauthenticated", "absent-record",
            "absent-attachment", "non-numeric", "audit-500-added", "audit-500-url", "audit-500-removed", "storage-500", "locked-remove", "cap-intent", "rate-limited"].map(statusOf))
            .toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 409, 410, 403, 403, 403, 404, 404, 404, 404, 401, 404, 404, 404, 500, 500, 500, 500, 409, 409, 429]);
        expect(statusOf("locked-add")).toBe(201);
        // The successful responses do carry the description where the contract says they do (the markers are real fixtures, not absent ones).
        expect(responses.find((res) => res.label === "complete")?.text).toContain(ATTACH_DESC);
        expect(responses.find((res) => res.label === "get-patient")?.text).toContain(ATTACH_DESC);
    });

    it("should have no effect from an Idempotency-Key header: no replay, no 422 for a changed body, no idem key in Redis, a fresh row and audit row each time", async () => {
        const recordId = await newRecord();
        const key = randomUUID();
        const headers = { "Idempotency-Key": key };
        const one = await createIntent(recordId, { description: ATTACH_DESC }, "doctor", headers);
        const two = await createIntent(recordId, { description: ATTACH_DESC }, "doctor", headers);
        const three = await createIntent(recordId, { description: ATTACH_DESC_2 }, "doctor", headers);
        expect([one.status, two.status, three.status]).toEqual([201, 201, 201]);
        expect(new Set([one.body.data.uploadId, two.body.data.uploadId, three.body.data.uploadId]).size).toBe(3);
        expect(new Set([one.body.data.fields.key, two.body.data.fields.key, three.body.data.fields.key]).size).toBe(3);
        const id = await addOk(recordId);
        const urlOne = await send("post", `/api/records/${recordId}/attachments/${id}/download-url`, "patient", undefined, headers);
        const urlTwo = await send("post", `/api/records/${recordId}/attachments/${id}/download-url`, "patient", undefined, headers);
        expect([urlOne.status, urlTwo.status]).toEqual([200, 200]);
        expect(urlOne.headers["idempotent-replayed"]).toBeUndefined();
        expect(Number((await ownerDb("audit_logs").where({ action: "attachment.url_issued" }).count({ n: "*" }))[0]?.n)).toBe(2);
        const removed = await send("delete", `/api/records/${recordId}/attachments/${id}`, "doctor", undefined, headers);
        const again = await send("delete", `/api/records/${recordId}/attachments/${id}`, "doctor", undefined, headers);
        expect([removed.status, again.status]).toEqual([204, 404]);
        // Not even a malformed key is validated (the header is ignored).
        expect((await createIntent(recordId, {}, "doctor", { "Idempotency-Key": "not-a-uuid" })).status).toBe(201);
        expect((await scanRedis(["idem:"]))).toEqual([]);
    });

    it("should show the description but no key, bucket, URL or POST field in the record read, the timeline and both PATCH 200 bodies, and make zero storage calls", async () => {
        await provisionOtherDoctor(h);
        const recordId = await newRecord();
        await addOk(recordId, { description: ATTACH_DESC });
        await addOk(recordId, { description: ATTACH_DESC_2, bytes: PNG });
        storage.calls.length = 0;
        const bodies: Array<[string, Response]> = [
            ["get patient", await getRecord(h, recordId, "patient")], ["get doctor", await getRecord(h, recordId, "doctor")], ["get related", await getRecord(h, recordId, "otherDoctor")],
            ["timeline", await timeline(h, PATIENT, "patient")], ["timeline doctor", await timeline(h, PATIENT, "doctor")],
            ["patch in place", await patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` })], ["patch no-op", await patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` })],
        ];
        for (const [label, res] of bodies) {
            expect([label, res.status]).toEqual([label, 200]);
            const text = JSON.stringify(res.body);
            for (const shape of STORAGE_SHAPES) expect([label, String(shape), shape.test(text)]).toEqual([label, String(shape), false]);
            for (const forbidden of ["objectKey", "object_key", "downloadUrl", "uploadedByUserId", "\"url\"", "bucket"]) expect([label, forbidden, text.includes(forbidden)]).toEqual([label, forbidden, false]);
            for (const marker of [ATTACH_DESC, ATTACH_DESC_2]) expect([label, marker, text.includes(marker)]).toEqual([label, marker, true]);
            const attachments = (res.body.data.attachments ?? res.body.data.records?.[0]?.attachments) as Array<Record<string, unknown>>;
            expect(attachments.map((item) => Object.keys(item).sort())).toEqual([["createdAt", "description", "fileType", "id", "recordId", "sizeBytes"], ["createdAt", "description", "fileType", "id", "recordId", "sizeBytes"]]);
        }
        expect(storage.calls).toEqual([]);
        // The clinical text of the record itself is still shown only through the record views (not through any attachment route).
        const text = JSON.stringify(bodies[0]?.[1].body);
        for (const marker of [CHIEF, NOTES]) expect(text.includes(marker)).toBe(true);
    });

    it("should leave a record readable when every storage call would fail, because reading a record never touches storage", async () => {
        const recordId = await newRecord();
        await addOk(recordId, { description: ATTACH_DESC });
        const spies = (["createUploadPolicy", "headObject", "readHead", "promote", "delete", "presignDownload"] as const).map((method) => jest.spyOn(storage, method).mockRejectedValue(new Error("synthetic storage outage")));
        try {
            const read = await getRecord(h, recordId, "patient");
            const list = await timeline(h, PATIENT, "patient");
            const patch = await patchRecord(h, recordId, { treatmentPlan: `${PLAN} outage` });
            expect([read.status, list.status, patch.status]).toEqual([200, 200, 200]);
            expect(read.body.data.attachments).toHaveLength(1);
            for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally { for (const spy of spies) spy.mockRestore(); }
    });

    it("should send Cache-Control no-store on every attachment response including 400, 401, 403, 404, 409 and a malformed JSON body", async () => {
        const recordId = await newRecord();
        const id = await addOk(recordId);
        const responses: Response[] = [
            await createIntent(recordId, { description: "   " }), await createIntent(recordId, {}, "anonymous"), await createIntent(recordId, {}, "admin"), await createIntent(999_999),
            await complete(recordId, 999_999), await downloadUrl(recordId, id, "patient"), await remove(recordId, 999_999),
            await send("post", `/api/records/${recordId}/attachments/uploads`, "doctor").set("Content-Type", "application/json").send("{ not json"),
        ];
        for (const res of responses) expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
        expect(responses.at(-1)?.status).toBe(400);
        expect(storageCalls(storage, "presignDownload")).toHaveLength(1);
    });
});
