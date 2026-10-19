import { expectErrorEnvelope } from "../helpers/contract";
import { DOCTOR, OTHER_DOCTOR, OTHER_PATIENT, PATIENT } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import type { Caller } from "../helpers/record-attachments-fixtures";
import { attachmentAudits, attachmentRows, intentRows, useAttachmentsHarness } from "../helpers/record-attachments-fixtures";
import { createRecord, provisionOtherDoctor, recordBody, relate, scanRedis, seedCompleted, STRANGER_DOCTOR, suspendLocally } from "../helpers/records-fixtures";

jest.setTimeout(120_000);

type Who = "none" | "patient" | "otherPatient" | "author" | "related" | "stranger" | "cancelledOnly" | "suspendedLocal" | "pending" | "rejected" | "suspendedToken" | "admin";
type Route = "intent" | "complete" | "download" | "remove";
/** [route, who, expected status, expected error code (undefined on success)] */
type Cell = readonly [Route, Who, number, string | undefined];

const CANCELLED_ONLY_DOCTOR = 206;

/** The table of spec 4.1: writes belong to the record's author alone; `download-url` follows the record reader rule. */
const MATRIX: readonly Cell[] = [
    // POST .../attachments/uploads
    ["intent", "none", 401, "Unauthorized"], ["intent", "patient", 403, "Forbidden"], ["intent", "otherPatient", 403, "Forbidden"], ["intent", "author", 201, undefined],
    ["intent", "related", 404, "NotFound"], ["intent", "stranger", 404, "NotFound"], ["intent", "cancelledOnly", 404, "NotFound"], ["intent", "suspendedLocal", 403, "Forbidden"],
    ["intent", "pending", 403, "Forbidden"], ["intent", "rejected", 403, "Forbidden"], ["intent", "suspendedToken", 403, "Forbidden"], ["intent", "admin", 403, "Forbidden"],
    // POST .../attachments/uploads/{uploadId}/complete
    ["complete", "none", 401, "Unauthorized"], ["complete", "patient", 403, "Forbidden"], ["complete", "otherPatient", 403, "Forbidden"], ["complete", "author", 201, undefined],
    ["complete", "related", 404, "NotFound"], ["complete", "stranger", 404, "NotFound"], ["complete", "cancelledOnly", 404, "NotFound"], ["complete", "suspendedLocal", 403, "Forbidden"],
    ["complete", "pending", 403, "Forbidden"], ["complete", "rejected", 403, "Forbidden"], ["complete", "suspendedToken", 403, "Forbidden"], ["complete", "admin", 403, "Forbidden"],
    // DELETE .../attachments/{attachmentId}
    ["remove", "none", 401, "Unauthorized"], ["remove", "patient", 403, "Forbidden"], ["remove", "otherPatient", 403, "Forbidden"], ["remove", "author", 204, undefined],
    ["remove", "related", 404, "NotFound"], ["remove", "stranger", 404, "NotFound"], ["remove", "cancelledOnly", 404, "NotFound"], ["remove", "suspendedLocal", 403, "Forbidden"],
    ["remove", "pending", 403, "Forbidden"], ["remove", "rejected", 403, "Forbidden"], ["remove", "suspendedToken", 403, "Forbidden"], ["remove", "admin", 403, "Forbidden"],
    // POST .../attachments/{attachmentId}/download-url
    ["download", "none", 401, "Unauthorized"], ["download", "patient", 200, undefined], ["download", "otherPatient", 404, "NotFound"], ["download", "author", 200, undefined],
    ["download", "related", 200, undefined], ["download", "stranger", 404, "NotFound"], ["download", "cancelledOnly", 404, "NotFound"], ["download", "suspendedLocal", 404, "NotFound"],
    ["download", "pending", 403, "Forbidden"], ["download", "rejected", 403, "Forbidden"], ["download", "suspendedToken", 403, "Forbidden"], ["download", "admin", 403, "Forbidden"],
];

describe("record attachments RBAC (integration: real routes, Postgres, Redis; storage, Identity and video faked)", () => {
    const kit = useAttachmentsHarness("record-attachments-rbac");
    const { h, storage, newRecord, createIntent, complete, downloadUrl, remove, upload, addOk, send } = kit;
    const callers = {} as Record<Who, Caller>;
    const codes = new Set<string>();
    let recordId = 0;
    let attachmentId = 0;
    let openUploadId = 0;

    beforeAll(async () => {
        callers.none = "anonymous"; callers.patient = "patient"; callers.otherPatient = "otherPatient"; callers.author = "doctor"; callers.related = "otherDoctor";
        callers.suspendedToken = "suspendedToken"; callers.admin = "admin"; callers.suspendedLocal = "doctor";
        callers.stranger = { token: await h.signFor(STRANGER_DOCTOR, "doctor") };
        callers.cancelledOnly = { token: await h.signFor(CANCELLED_ONLY_DOCTOR, "doctor") };
        callers.pending = { token: await h.signFor(DOCTOR, "doctor", "pending") };
        callers.rejected = { token: await h.signFor(DOCTOR, "doctor", "rejected") };
    });
    afterAll(() => { expect([...codes]).not.toContain("NotAssignedDoctor"); });

    /** One record with one attachment and one open intent, all written by the author; a related doctor and a cancelled-only doctor exist. */
    beforeEach(async () => {
        await provisionOtherDoctor(h);
        await h.seedDoctor(CANCELLED_ONLY_DOCTOR);
        await relate(h, CANCELLED_ONLY_DOCTOR, PATIENT, "cancelled");
        await relate(h, CANCELLED_ONLY_DOCTOR, PATIENT, "no_show");
        recordId = await newRecord();
        attachmentId = await addOk(recordId);
        openUploadId = (await upload(recordId)).uploadId;
        storage.calls.length = 0;
    });

    const snapshot = async (): Promise<unknown> => ({
        attachments: await attachmentRows(), intents: await intentRows(), audits: await ownerDb("audit_logs").select("action", "entity_id").orderBy("id"), storage: storage.calls.length,
    });

    const drive = (route: Route, who: Who) => {
        const caller = callers[who];
        switch (route) {
            case "intent": return createIntent(recordId, undefined, caller);
            case "complete": return complete(recordId, openUploadId, caller);
            case "download": return downloadUrl(recordId, attachmentId, caller);
            case "remove": return remove(recordId, attachmentId, caller);
        }
    };

    it.each(MATRIX)("should answer %s for %s with %i %s", async (route, who, status, code) => {
        if (who === "suspendedLocal") await suspendLocally(DOCTOR);
        const before = await snapshot();
        const res = await drive(route, who);
        expect(res.status).toBe(status);
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers["cache-control"]).toBe("no-store");
        if (code !== undefined) {
            expectErrorEnvelope(res.body, code);
            codes.add(res.body.error.code as string);
            // A denied call leaves no trace: no row, no intent change, no audit row and no storage call.
            expect(await snapshot()).toEqual(before);
        } else {
            codes.add("ok");
        }
    });

    it("should answer 403 to an admin on all four routes whether or not the ids exist, with no audit row, no storage call and no rate-limit budget spent", async () => {
        const before = await snapshot();
        const probes: Array<[Parameters<typeof send>[0], string, object | undefined]> = [
            ["post", `/api/records/${recordId}/attachments/uploads`, {}], ["post", "/api/records/999999/attachments/uploads", {}], ["post", "/api/records/abc/attachments/uploads", {}],
            ["post", `/api/records/${recordId}/attachments/uploads/${openUploadId}/complete`, undefined], ["post", "/api/records/999999/attachments/uploads/999999/complete", undefined],
            ["post", "/api/records/abc/attachments/uploads/abc/complete", undefined],
            ["post", `/api/records/${recordId}/attachments/${attachmentId}/download-url`, undefined], ["post", "/api/records/999999/attachments/999999/download-url", undefined],
            ["post", "/api/records/abc/attachments/abc/download-url", undefined],
            ["delete", `/api/records/${recordId}/attachments/${attachmentId}`, undefined], ["delete", "/api/records/999999/attachments/999999", undefined],
            ["delete", "/api/records/abc/attachments/abc", undefined],
        ];
        for (const [verb, path, payload] of probes) {
            const res = await send(verb, path, "admin", payload);
            expect([verb, path, res.status]).toEqual([verb, path, 403]);
            expectErrorEnvelope(res.body, "Forbidden");
        }
        expect(await snapshot()).toEqual(before);
        expect((await scanRedis(["rl:"])).filter((entry) => entry.key.includes("record-attachments") && entry.key.includes("303"))).toEqual([]);
    });

    it("should answer 403 to a patient on every write route before any lookup, even for ids that do not exist", async () => {
        for (const patient of ["patient", "otherPatient"] as const) {
            expect((await createIntent(999_999, {}, patient)).status).toBe(403);
            expect((await createIntent("abc", {}, patient)).status).toBe(403);
            expect((await complete(999_999, 999_999, patient)).status).toBe(403);
            expect((await complete("abc", "abc", patient)).status).toBe(403);
            expect((await remove(999_999, 999_999, patient)).status).toBe(403);
            expect((await remove("abc", "abc", patient)).status).toBe(403);
        }
    });

    it("should answer the same 404 to a related doctor, a stranger and the author for an absent record, so existence cannot be probed", async () => {
        const messages = new Set<string>();
        for (const who of ["related", "stranger", "cancelledOnly"] as const) {
            for (const res of [await createIntent(recordId, {}, callers[who]), await createIntent(999_999, {}, callers[who]), await createIntent("abc", {}, callers[who]),
                await complete(recordId, openUploadId, callers[who]), await complete(999_999, 1, callers[who]), await remove(recordId, attachmentId, callers[who]), await remove(999_999, 1, callers[who])]) {
                expect([who, res.status]).toEqual([who, 404]);
                messages.add(`${res.body.error.code}:${res.body.error.message}`);
            }
        }
        expect(messages.size).toBe(1);
        expect((await createIntent(999_999, {}, "doctor")).status).toBe(404);
        expect((await complete(999_999, 1, "doctor")).status).toBe(404);
        expect((await remove(999_999, 1, "doctor")).status).toBe(404);
    });

    it("should answer 404 to every permitted role for non-numeric, zero, negative and fractional ids on all four routes", async () => {
        for (const bad of ["abc", "0", "-1", "1.5", "1e3", "9999999999999999999999"]) {
            expect([bad, (await createIntent(bad, {}, "doctor")).status]).toEqual([bad, 404]);
            expect([bad, (await complete(bad, openUploadId, "doctor")).status]).toEqual([bad, 404]);
            expect([bad, (await complete(recordId, bad, "doctor")).status]).toEqual([bad, 404]);
            expect([bad, (await remove(bad, attachmentId, "doctor")).status]).toEqual([bad, 404]);
            expect([bad, (await remove(recordId, bad, "doctor")).status]).toEqual([bad, 404]);
            for (const reader of ["patient", "doctor", "otherDoctor"] as const) {
                expect([bad, reader, (await downloadUrl(bad, attachmentId, reader)).status]).toEqual([bad, reader, 404]);
                expect([bad, reader, (await downloadUrl(recordId, bad, reader)).status]).toEqual([bad, reader, 404]);
            }
        }
        expect(await attachmentAudits()).toHaveLength(1); // only the fixture's attachment.added
    });

    it("should route DELETE .../attachments/uploads to the delete handler and answer 404, not a different operation", async () => {
        const res = await send("delete", `/api/records/${recordId}/attachments/uploads`, "doctor");
        expect(res.status).toBe(404);
        expectErrorEnvelope(res.body, "NotFound");
        expect(await attachmentRows()).toHaveLength(1);
    });

    it("should keep a suspended author's attachments readable to the patient and to other consulted doctors while the author gets 404 on reads and 403 on every write", async () => {
        await suspendLocally(DOCTOR);
        expect((await downloadUrl(recordId, attachmentId, "patient")).status).toBe(200);
        expect((await downloadUrl(recordId, attachmentId, "otherDoctor")).status).toBe(200);
        expect((await downloadUrl(recordId, attachmentId, "doctor")).status).toBe(404);
        expect((await createIntent(recordId, {}, "doctor")).status).toBe(403);
        expect((await complete(recordId, openUploadId, "doctor")).status).toBe(403);
        expect((await remove(recordId, attachmentId, "doctor")).status).toBe(403);
        expect((await attachmentRows())[0]?.deleted_at).toBeNull();
    });

    it("should let a related doctor read but never write, and a doctor's access follow the consultation relationship (a cancelled one grants nothing, a later live one grants reads only)", async () => {
        const doctor = callers.cancelledOnly;
        expect((await downloadUrl(recordId, attachmentId, doctor)).status).toBe(404);
        await relate(h, CANCELLED_ONLY_DOCTOR, PATIENT, "waiting");
        expect((await downloadUrl(recordId, attachmentId, doctor)).status).toBe(200);
        expect((await remove(recordId, attachmentId, doctor)).status).toBe(404);
        expect((await createIntent(recordId, {}, doctor)).status).toBe(404);
        // A relationship with one patient grants nothing about another patient's record.
        const other = await createRecord(h, await seedCompleted(h, { patient_user_id: OTHER_PATIENT }));
        const otherAttachment = await addOk(other);
        expect((await downloadUrl(other, otherAttachment, doctor)).status).toBe(404);
        expect((await downloadUrl(other, otherAttachment, "otherPatient")).status).toBe(200);
        expect((await downloadUrl(other, otherAttachment, "patient")).status).toBe(404);
    });

    it("should answer 404 when the attachment belongs to another record, even to callers who may open both records, and delete nothing", async () => {
        const second = await newRecord();
        const foreign = await addOk(second);
        for (const reader of ["patient", "doctor", "otherDoctor"] as const) {
            expect([reader, (await downloadUrl(recordId, foreign, reader)).status]).toEqual([reader, 404]);
        }
        expect((await remove(recordId, foreign, "doctor")).status).toBe(404);
        expect((await attachmentRows()).filter((row) => row.deleted_at !== null)).toEqual([]);
        expect((await attachmentAudits()).filter((row) => row.action !== "attachment.added")).toEqual([]);
    });

    it("should never let a caller-supplied identity header change who the caller is", async () => {
        const spoof = { "X-User-Id": String(DOCTOR), "X-Role": "admin", "X-Forwarded-User": String(PATIENT) };
        expect((await send("post", `/api/records/${recordId}/attachments/${attachmentId}/download-url`, "otherPatient", undefined, spoof)).status).toBe(404);
        expect((await send("post", `/api/records/${recordId}/attachments/${attachmentId}/download-url`, "admin", undefined, spoof)).status).toBe(403);
        expect((await send("post", `/api/records/${recordId}/attachments/${attachmentId}/download-url`, "anonymous", undefined, spoof)).status).toBe(401);
        expect((await send("delete", `/api/records/${recordId}/attachments/${attachmentId}`, "patient", undefined, spoof)).status).toBe(403);
        expect((await send("delete", `/api/records/${recordId}/attachments/${attachmentId}`, "otherDoctor", undefined, spoof)).status).toBe(404);
        expect((await send("post", `/api/records/${recordId}/attachments/uploads`, "anonymous", {}, spoof)).status).toBe(401);
        expect((await attachmentRows())[0]?.deleted_at).toBeNull();
    });

    it("should answer 401 for a malformed or non-bearer credential on every attachment route", async () => {
        const routes: Array<[Parameters<typeof send>[0], string, object | undefined]> = [
            ["post", `/api/records/${recordId}/attachments/uploads`, {}], ["post", `/api/records/${recordId}/attachments/uploads/${openUploadId}/complete`, undefined],
            ["post", `/api/records/${recordId}/attachments/${attachmentId}/download-url`, undefined], ["delete", `/api/records/${recordId}/attachments/${attachmentId}`, undefined],
        ];
        for (const [verb, path, payload] of routes) {
            for (const authorization of ["Bearer not.a.jwt", "Basic Zm9vOmJhcg==", "Bearer ", "token"]) {
                const res = await send(verb, path, "anonymous", payload, { Authorization: authorization });
                expect([verb, path, authorization, res.status]).toEqual([verb, path, authorization, 401]);
                expectErrorEnvelope(res.body, "Unauthorized");
            }
        }
    });

    it("should hide an intent of another doctor, another record and another kind behind 404 and leave the intent open", async () => {
        // A second record by the same author: the intent is bound to the first record.
        const second = await newRecord();
        const foreign = await complete(second, openUploadId, "doctor");
        expect(foreign.status).toBe(404);
        // A verification-document intent is invisible to the attachment route.
        const [verification] = await ownerDb("upload_intents").insert({
            kind: "verification_document", target_id: 1, owner_user_id: DOCTOR, document_type: "license", quarantine_key: "quarantine/00000000-0000-4000-8000-000000000001",
            max_bytes: 10_485_760, expires_at: new Date(Date.now() + 600_000),
        }).returning("id");
        storage.seed("quarantine/00000000-0000-4000-8000-000000000001", Buffer.from("%PDF-1.7 x"));
        expect((await complete(recordId, (verification as { id: number }).id, "doctor")).status).toBe(404);
        const open = (await intentRows()).filter((row) => row.consumed_at === null).map((row) => String(row.id)).sort();
        expect(open).toEqual([String(openUploadId), String((verification as { id: number }).id)].sort());
        expect(storage.has("quarantine/00000000-0000-4000-8000-000000000001")).toBe(true);
    });

    it("should not let another record's author complete this author's intent, on their own record or on this one", async () => {
        const theirs = await createRecord(h, await seedCompleted(h, { doctor_user_id: OTHER_DOCTOR }), recordBody(), "otherDoctor");
        expect((await complete(theirs, openUploadId, "otherDoctor")).status).toBe(404);
        expect((await complete(recordId, openUploadId, "otherDoctor")).status).toBe(404);
        const row = (await intentRows()).find((intent) => String(intent.id) === String(openUploadId));
        expect(row?.consumed_at).toBeNull();
        expect(await attachmentRows()).toHaveLength(1);
    });
});
