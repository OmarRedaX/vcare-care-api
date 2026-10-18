import type { Response } from "supertest";
import {
    contractNoStoreValue, contractResponseCodes, expectErrorEnvelope, expectPaginationMeta, expectSuccessEnvelope, inlineLists, responseBlock, schemaBlock,
} from "../helpers/contract";
import { PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import {
    AMEND_REASON, createRecord, getRecord, lockNow, patchRecord, PLAN, postRecord, provisionOtherDoctor, recordBody, seedCompleted, seedProfile, seedWithStatus, timeline,
    withFailingAudit,
} from "../helpers/records-fixtures";

jest.setTimeout(180_000);

type Method = "get" | "post" | "patch";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CREATE = "/api/consultations/{id}/record";
const RECORD = "/api/records/{id}";
const TIMELINE = "/api/patients/{patientUserId}/records";

/** Top-level property names of a component schema (children of its `properties:` block). */
function properties(name: string): string[] {
    return [...schemaBlock(name).matchAll(/^ {8}([A-Za-z0-9]+):/gm)].map((match) => match[1] ?? "");
}

describe("records contract conformance (integration: real responses against contracts/openapi.yaml)", () => {
    const h = useConsultationsHarness("records-contract");
    const seen = new Map<string, Set<string>>();

    /** Every response is checked against the operation's declared status set, the headers and the envelope. */
    function conforms(res: Response, path: string, method: Method, expectedStatus: number, errorCode?: string): void {
        expect(res.status).toBe(expectedStatus);
        expect(contractResponseCodes(path, method)).toContain(String(res.status));
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
        const key = `${method.toUpperCase()} ${path}`;
        const set = seen.get(key) ?? new Set<string>();
        set.add(String(res.status));
        seen.set(key, set);
        if (errorCode !== undefined) expectErrorEnvelope(res.body, errorCode, res.headers["x-request-id"]);
    }

    function expectAmendment(data: Record<string, unknown>): void {
        const required = inlineLists(schemaBlock("MedicalRecordAmendment"), "required")[0] ?? [];
        for (const key of required) expect(Object.keys(data)).toContain(key);
        for (const key of Object.keys(data)) expect(properties("MedicalRecordAmendment")).toContain(key);
        for (const key of ["id", "recordId", "authorUserId"]) expect(Number.isInteger(data[key])).toBe(true);
        expect(typeof data.reason).toBe("string");
        expect(String(data.createdAt)).toMatch(ISO);
        for (const key of ["chiefComplaint", "examinationNotes", "diagnosisText", "diagnosisCode", "treatmentPlan"]) expect(data[key] === null || typeof data[key] === "string").toBe(true);
        expect(data.followUpInDays === null || Number.isInteger(data.followUpInDays)).toBe(true);
    }

    function expectRecord(data: Record<string, unknown>): void {
        const required = inlineLists(schemaBlock("MedicalRecord"), "required")[0] ?? [];
        for (const key of required) expect(Object.keys(data)).toContain(key);
        for (const key of Object.keys(data)) expect(properties("MedicalRecord")).toContain(key);
        for (const key of ["id", "consultationId", "patientUserId", "doctorUserId"]) expect(Number.isInteger(data[key])).toBe(true);
        expect(typeof data.chiefComplaint).toBe("string");
        for (const key of ["examinationNotes", "diagnosisText", "diagnosisCode", "treatmentPlan"]) expect(data[key] === null || typeof data[key] === "string").toBe(true);
        expect(data.diagnosisCode === null || (data.diagnosisCode as string).length <= 16).toBe(true);
        expect(data.followUpInDays === null || (Number.isInteger(data.followUpInDays) && (data.followUpInDays as number) >= 1 && (data.followUpInDays as number) <= 365)).toBe(true);
        for (const key of ["lockedAt", "createdAt", "updatedAt"]) expect(String(data[key])).toMatch(ISO);
        expect(typeof data.isLocked).toBe("boolean");
        expect(data.attachments).toEqual([]);
        expect(Array.isArray(data.amendments)).toBe(true);
        for (const amendment of data.amendments as Array<Record<string, unknown>>) expectAmendment(amendment);
        for (const forbidden of ["deletedAt", "deleted_at", "downloadUrl", "objectKey", "url"]) expect(Object.keys(data)).not.toContain(forbidden);
    }

    it("should conform on create: 201 with the MedicalRecord shape, 400, 401, 403 (both codes), 404, 409 (both codes), 429, 500", async () => {
        await provisionOtherDoctor(h);
        const id = await seedCompleted(h);
        conforms(await postRecord(h, id, recordBody(), undefined), CREATE, "post", 401, "Unauthorized");
        conforms(await postRecord(h, id, { chiefComplaint: "x" }, "doctor"), CREATE, "post", 400, "ValidationFailed");
        conforms(await postRecord(h, id, recordBody(), "patient"), CREATE, "post", 403, "Forbidden");
        conforms(await postRecord(h, id, recordBody(), "otherDoctor"), CREATE, "post", 403, "NotAssignedDoctor");
        conforms(await postRecord(h, 999999, recordBody(), "doctor"), CREATE, "post", 404, "NotFound");
        const booked = await seedWithStatus(h, "booked");
        conforms(await postRecord(h, booked, recordBody(), "doctor"), CREATE, "post", 409, "RecordRequiresCompleted");
        await withFailingAudit("record.created", async () => { conforms(await postRecord(h, id, recordBody(), "doctor"), CREATE, "post", 500, "InternalError"); });
        const created = await postRecord(h, id, recordBody(), "doctor");
        conforms(created, CREATE, "post", 201);
        expectRecord(expectSuccessEnvelope(created.body) as Record<string, unknown>);
        expect(created.body.data).toMatchObject({ isLocked: false, amendments: [], attachments: [] });
        conforms(await postRecord(h, id, recordBody(), "doctor"), CREATE, "post", 409, "Conflict");
        // The rate-limit response: 20 writes per minute per user (one write is already spent above).
        let limited: Response | undefined;
        for (let index = 0; index < 25 && limited === undefined; index += 1) {
            const res = await postRecord(h, await seedCompleted(h), { chiefComplaint: "SYNTHETIC-CHIEF-6601" }, "doctor");
            if (res.status === 429) limited = res;
        }
        expect(limited).toBeDefined();
        conforms(limited as Response, CREATE, "post", 429, "RateLimited");
        expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(responseBlock("RateLimited")).toContain("Retry-After");
    });

    it("should conform on get-one: 200 with amendments for patient and doctor, 400, 401, 403, 404, 429, 500", async () => {
        const id = await createRecord(h, await seedCompleted(h));
        await lockNow(id);
        expect((await patchRecord(h, id, { followUpInDays: 5, reason: AMEND_REASON })).status).toBe(201);
        for (const actor of ["patient", "doctor"] as const) {
            const res = await getRecord(h, id, actor);
            conforms(res, RECORD, "get", 200);
            const data = expectSuccessEnvelope(res.body) as Record<string, unknown>;
            expectRecord(data);
            expect(data).toMatchObject({ isLocked: true });
            expect((data.amendments as unknown[]).length).toBe(1);
        }
        conforms(await getRecord(h, `${id}?x=1`, "patient"), RECORD, "get", 400, "ValidationFailed");
        conforms(await getRecord(h, id), RECORD, "get", 401, "Unauthorized");
        conforms(await getRecord(h, id, "admin"), RECORD, "get", 403, "Forbidden");
        conforms(await getRecord(h, 999999, "patient"), RECORD, "get", 404, "NotFound");
        conforms(await getRecord(h, id, "otherPatient"), RECORD, "get", 404, "NotFound");
        await withFailingAudit("record.read", async () => { conforms(await getRecord(h, id, "patient"), RECORD, "get", 500, "InternalError"); });
        let limited: Response | undefined;
        for (let index = 0; index < 125 && limited === undefined; index += 1) {
            const res = await getRecord(h, id, "patient");
            if (res.status === 429) limited = res;
        }
        expect(limited).toBeDefined();
        conforms(limited as Response, RECORD, "get", 429, "RateLimited");
        expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    });

    it("should conform on patch: 200 in place and no-op, 201 amendment, 400, 401, 403 (both codes), 404, 409 RecordLocked, 429, 500", async () => {
        await provisionOtherDoctor(h);
        const id = await createRecord(h, await seedCompleted(h));
        const inPlace = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
        conforms(inPlace, RECORD, "patch", 200);
        expectRecord(expectSuccessEnvelope(inPlace.body) as Record<string, unknown>);
        const noOp = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
        conforms(noOp, RECORD, "patch", 200);
        expect(noOp.body.data.updatedAt).toBe(inPlace.body.data.updatedAt);
        conforms(await patchRecord(h, id, {}), RECORD, "patch", 400, "ValidationFailed");
        conforms(await h.call("patch", `/api/records/${id}`, undefined, { treatmentPlan: PLAN }), RECORD, "patch", 401, "Unauthorized");
        conforms(await patchRecord(h, id, { treatmentPlan: PLAN }, "patient"), RECORD, "patch", 403, "Forbidden");
        conforms(await patchRecord(h, id, { treatmentPlan: PLAN }, "otherDoctor"), RECORD, "patch", 403, "NotAssignedDoctor");
        conforms(await patchRecord(h, 999999, { treatmentPlan: PLAN }), RECORD, "patch", 404, "NotFound");
        // 409 RecordLocked: the trigger refuses an update the service allowed (see records-rules for the full account of how).
        const original = (await ownerDb.raw("SELECT pg_get_functiondef('forbid_update_after_lock'::regproc) AS def")).rows[0].def as string;
        await ownerDb.raw(`CREATE OR REPLACE FUNCTION forbid_update_after_lock() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'record % is locked', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_medical_records_forbid_update_after_lock'; END $$ LANGUAGE plpgsql;`);
        try { conforms(await patchRecord(h, id, { treatmentPlan: PLAN }), RECORD, "patch", 409, "RecordLocked"); } finally { await ownerDb.raw(original); }
        await withFailingAudit("record.updated", async () => { conforms(await patchRecord(h, id, { treatmentPlan: PLAN }), RECORD, "patch", 500, "InternalError"); });
        await lockNow(id);
        const amended = await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON });
        conforms(amended, RECORD, "patch", 201);
        expectAmendment(expectSuccessEnvelope(amended.body) as Record<string, unknown>);
        expect(amended.body.data).not.toHaveProperty("amendments");
        conforms(await patchRecord(h, id, { treatmentPlan: PLAN }), RECORD, "patch", 400, "ValidationFailed");
        let limited: Response | undefined;
        for (let index = 0; index < 25 && limited === undefined; index += 1) {
            const res = await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON });
            if (res.status === 429) limited = res;
        }
        expect(limited).toBeDefined();
        conforms(limited as Response, RECORD, "patch", 429, "RateLimited");
    });

    it("should conform on the timeline: 200 with PatientTimeline and PaginationMeta (patient present and null), 400, 401, 403, 404, 429, 500", async () => {
        const first = await createRecord(h, await seedCompleted(h));
        await createRecord(h, await seedCompleted(h));
        await lockNow(first);
        await patchRecord(h, first, { followUpInDays: 9, reason: AMEND_REASON });
        const withoutProfile = await timeline(h, PATIENT, "doctor", "?limit=1");
        conforms(withoutProfile, TIMELINE, "get", 200);
        expect(expectSuccessEnvelope(withoutProfile.body)).toMatchObject({ patient: null });
        expect(expectPaginationMeta(withoutProfile.body.meta)).toMatchObject({ hasMore: true, count: 1 });
        await seedProfile(PATIENT);
        for (const actor of ["patient", "doctor"] as const) {
            const res = await timeline(h, PATIENT, actor);
            conforms(res, TIMELINE, "get", 200);
            const data = expectSuccessEnvelope(res.body) as { patient: Record<string, unknown> | null; records: Array<Record<string, unknown>> };
            for (const key of inlineLists(schemaBlock("PatientTimeline"), "required")[0] ?? []) expect(Object.keys(data)).toContain(key);
            for (const key of inlineLists(schemaBlock("PatientProfile"), "required")[0] ?? []) expect(Object.keys(data.patient ?? {})).toContain(key);
            expect(data.records).toHaveLength(2);
            for (const record of data.records) expectRecord(record);
            expectPaginationMeta(res.body.meta);
            expect(Object.keys(res.body.meta).sort()).toEqual(["count", "hasMore", "nextCursor"]);
        }
        conforms(await timeline(h, PATIENT, "patient", "?limit=0"), TIMELINE, "get", 400, "ValidationFailed");
        conforms(await timeline(h, PATIENT, undefined), TIMELINE, "get", 401, "Unauthorized");
        conforms(await timeline(h, PATIENT, "admin"), TIMELINE, "get", 403, "Forbidden");
        conforms(await timeline(h, PATIENT, "otherPatient"), TIMELINE, "get", 404, "NotFound");
        await withFailingAudit("patient_records.listed", async () => { conforms(await timeline(h, PATIENT, "patient"), TIMELINE, "get", 500, "InternalError"); });
        let limited: Response | undefined;
        for (let index = 0; index < 65 && limited === undefined; index += 1) {
            const res = await timeline(h, PATIENT, "patient");
            if (res.status === 429) limited = res;
        }
        expect(limited).toBeDefined();
        conforms(limited as Response, TIMELINE, "get", 429, "RateLimited");
    });

    it("should have exercised every status code the contract declares for each record operation", () => {
        // The four tests above run first and fill `seen`; this one only reads it, so it must stay last.
        const declared = (path: string, method: Method): string[] => [...contractResponseCodes(path, method)].sort();
        for (const [path, method] of [[CREATE, "post"], [RECORD, "get"], [RECORD, "patch"], [TIMELINE, "get"]] as const) {
            expect([`${method.toUpperCase()} ${path}`, [...(seen.get(`${method.toUpperCase()} ${path}`) ?? [])].sort()]).toEqual([`${method.toUpperCase()} ${path}`, declared(path, method)]);
        }
    });
});
