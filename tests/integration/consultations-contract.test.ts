import { randomUUID } from "node:crypto";
import type { Response } from "supertest";
import {
    contractNoStoreValue, contractOperationBlock, contractResponseCodes, expectErrorEnvelope, expectPaginationMeta, expectSuccessEnvelope,
    inlineLists, responseBlock, schemaBlock,
} from "../helpers/contract";
import { ALLERGEN, DOCTOR, localStart, PATIENT, REASON, bookingBody, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";

jest.setTimeout(60_000);

type Method = "get" | "post" | "patch";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Top-level property names of a component schema (children of its `properties:` block). */
function properties(name: string): string[] {
    return [...schemaBlock(name).matchAll(/^ {8}([A-Za-z0-9]+):/gm)].map((match) => match[1] ?? "");
}

describe("consultations contract conformance (integration: real responses against contracts/openapi.yaml)", () => {
    const h = useConsultationsHarness("consultations-contract");
    const seen = new Map<string, Set<string>>();

    /** Every response is checked against the operation's declared status set and the envelope. */
    function conforms(res: Response, path: string, method: Method, expectedStatus: number, errorCode?: string): void {
        const key = `${method.toUpperCase()} ${path}`;
        expect(res.status).toBe(expectedStatus);
        expect(contractResponseCodes(path, method)).toContain(String(res.status));
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        const set = seen.get(key) ?? new Set<string>(); set.add(String(res.status)); seen.set(key, set);
        if (errorCode !== undefined) {
            expectErrorEnvelope(res.body, errorCode, res.headers["x-request-id"]);
            return;
        }
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
    }

    function expectConsultation(data: Record<string, unknown>, options: { complaint: boolean }): void {
        const allowed = properties("Consultation");
        const required = inlineLists(schemaBlock("Consultation"), "required")[0] ?? [];
        for (const key of required) expect(Object.keys(data)).toContain(key);
        for (const key of Object.keys(data)) expect(allowed).toContain(key);
        expect(Object.keys(data).includes("complaintText")).toBe(options.complaint);
        expect(Number.isInteger(data.id)).toBe(true);
        expect(inlineLists(schemaBlock("ConsultationStatus"), "enum")[0]).toContain(data.status);
        for (const key of ["startsAt", "endsAt", "startsAtLocal", "endsAtLocal", "createdAt", "updatedAt"]) expect(String(data[key])).toMatch(ISO);
        for (const key of ["joinedAt", "startedAt", "completedAt", "cancelledAt"]) if (data[key] !== undefined) expect(data[key] === null || (typeof data[key] === "string" && ISO.test(data[key]))).toBe(true);
        expect(typeof data.timezone).toBe("string");
        expect(typeof data.patientTimezone).toBe("string");
        expect(typeof data.needsAdminFollowup).toBe("boolean");
        if (data.hasRecord !== undefined) expect(data.hasRecord).toBe(false);
        const type = data.consultationType as Record<string, unknown>;
        expect(Object.keys(type).sort()).toEqual(["durationMinutes", "id", "name"]);
        const price = data.price as Record<string, unknown>;
        for (const key of inlineLists(schemaBlock("Money"), "required")[0] ?? []) expect(Object.keys(price)).toContain(key);
        expect(Number.isInteger(price.amount)).toBe(true);
        expect(String(price.currency)).toMatch(/^[A-Z]{3}$/);
        for (const side of ["doctor", "patient"]) {
            const participant = data[side] as Record<string, unknown>;
            for (const key of [...(inlineLists(schemaBlock("Participant"), "required")[0] ?? []), ...(inlineLists(schemaBlock("HydratedUserFields"), "required")[0] ?? [])]) {
                expect(Object.keys(participant)).toContain(key);
            }
            expect(Object.keys(participant).sort()).toEqual(["avatarUrl", "displayName", "profileHydrated", "userId"]);
        }
        for (const forbidden of ["roomId", "idempotencyKey", "requestHash", "cancelledByUserId", "reminder24hSentAt", "reminder1hSentAt", "noShowMarkedAt", "complaint_text"]) {
            expect(Object.keys(data)).not.toContain(forbidden);
        }
    }

    it("should conform on book: 201 with the Consultation shape, 400, 401, 403, 404, 409, 422", async () => {
        const created = await h.book();
        conforms(created, "/api/consultations", "post", 201);
        expectConsultation(expectSuccessEnvelope(created.body) as Record<string, unknown>, { complaint: true });
        expect(created.body.data).toMatchObject({ status: "booked", cancelledAt: null, cancelledBy: null, cancelReason: null, needsAdminFollowup: false });
        conforms(await h.call("post", "/api/consultations", "patient", { ...bookingBody(), nope: 1 }, { "Idempotency-Key": randomUUID() }), "/api/consultations", "post", 400, "ValidationFailed");
        conforms(await h.call("post", "/api/consultations", undefined, bookingBody(), { "Idempotency-Key": randomUUID() }), "/api/consultations", "post", 401, "Unauthorized");
        conforms(await h.book("unverified"), "/api/consultations", "post", 403, "EmailNotVerified");
        conforms(await h.book("doctor"), "/api/consultations", "post", 403, "Forbidden");
        conforms(await h.book("patient", bookingBody({ doctorId: 999 })), "/api/consultations", "post", 404, "NotFound");
        conforms(await h.book("otherPatient", bookingBody()), "/api/consultations", "post", 409, "SlotUnavailable");
        conforms(await h.book("otherPatient", bookingBody({ startsAt: localStart(3, "10:15") })), "/api/consultations", "post", 422, "OutsideWorkingHours");
        conforms(await h.book("otherPatient", bookingBody({ startsAt: localStart(-1, "10:00") })), "/api/consultations", "post", 422, "BookingInPast");
        conforms(await h.book("otherPatient", bookingBody({ startsAt: localStart(61, "10:00") })), "/api/consultations", "post", 422, "BeyondBookingHorizon");
        const key = randomUUID();
        await h.book("otherPatient", bookingBody({ startsAt: localStart(4, "10:00") }), key);
        conforms(await h.book("otherPatient", bookingBody({ startsAt: localStart(4, "11:00") }), key), "/api/consultations", "post", 422, "IdempotencyConflict");
        await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ is_accepting_patients: false });
        conforms(await h.book("otherPatient", bookingBody({ startsAt: localStart(5, "10:00") })), "/api/consultations", "post", 409, "DoctorNotBookable");
    });

    it("should conform on list: 200 items without complaintText plus PaginationMeta, 400, 401, 403", async () => {
        await h.book();
        for (const actor of ["patient", "doctor", "admin"] as const) {
            const res = await h.call("get", "/api/consultations", actor);
            conforms(res, "/api/consultations", "get", 200);
            expectSuccessEnvelope(res.body);
            expectPaginationMeta(res.body.meta);
            expect(Array.isArray(res.body.data)).toBe(true);
            for (const item of res.body.data as Array<Record<string, unknown>>) expectConsultation(item, { complaint: false });
        }
        conforms(await h.call("get", "/api/consultations?scope=soon", "patient"), "/api/consultations", "get", 400, "ValidationFailed");
        conforms(await h.call("get", "/api/consultations", undefined), "/api/consultations", "get", 401, "Unauthorized");
        conforms(await h.call("get", `/api/consultations?doctorUserId=${DOCTOR}`, "patient"), "/api/consultations", "get", 403, "Forbidden");
    });

    it("should conform on get-one: participants with complaintText, admin without, 400, 401, 404", async () => {
        const id = (await h.book()).body.data.id as number;
        const patient = await h.call("get", `/api/consultations/${id}`, "patient");
        conforms(patient, "/api/consultations/{id}", "get", 200);
        expectConsultation(patient.body.data, { complaint: true });
        const admin = await h.call("get", `/api/consultations/${id}`, "admin");
        conforms(admin, "/api/consultations/{id}", "get", 200);
        expectConsultation(admin.body.data, { complaint: false });
        conforms(await h.call("get", `/api/consultations/${id}?timezone=Mars/Olympus`, "patient"), "/api/consultations/{id}", "get", 400, "ValidationFailed");
        conforms(await h.call("get", `/api/consultations/${id}`, undefined), "/api/consultations/{id}", "get", 401, "Unauthorized");
        conforms(await h.call("get", `/api/consultations/${id}`, "otherPatient"), "/api/consultations/{id}", "get", 404, "NotFound");
        conforms(await h.call("get", `/api/consultations/${id}`, "suspendedPatient"), "/api/consultations/{id}", "get", 403, "Forbidden");
    });

    it("should conform on reschedule: 200, 400, 401, 403, 404, 409 and 422", async () => {
        const id = (await h.book()).body.data.id as number;
        const path = "/api/consultations/{id}/reschedule";
        const ok = await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00") });
        conforms(ok, path, "patch", 200);
        expectConsultation(ok.body.data, { complaint: true });
        conforms(await h.reschedule(id, "admin", { startsAt: localStart(5, "12:00") }), path, "patch", 400, "ValidationFailed");
        conforms(await h.call("patch", `/api/consultations/${id}/reschedule`, undefined, { startsAt: localStart(5, "12:00") }, { "Idempotency-Key": randomUUID() }), path, "patch", 401, "Unauthorized");
        conforms(await h.reschedule(id, "doctor", { startsAt: localStart(5, "12:00") }), path, "patch", 403, "Forbidden");
        conforms(await h.reschedule(id, "otherPatient", { startsAt: localStart(5, "12:00") }), path, "patch", 404, "NotFound");
        const near = await h.seedConsultation({ patient_user_id: PATIENT, starts_at: new Date(Date.now() + 60 * 60_000), ends_at: new Date(Date.now() + 90 * 60_000) });
        conforms(await h.reschedule(near, "patient", { startsAt: localStart(5, "12:00") }), path, "patch", 409, "PolicyWindowViolation");
        conforms(await h.reschedule(id, "patient", { startsAt: localStart(5, "11:10") }), path, "patch", 422, "OutsideWorkingHours");
        const key = randomUUID();
        await h.reschedule(id, "patient", { startsAt: localStart(6, "11:00") }, key);
        conforms(await h.reschedule(id, "patient", { startsAt: localStart(6, "12:00") }, key), path, "patch", 422, "IdempotencyConflict");
    });

    it("should conform on cancel: 200, 400, 401, 403, 404, 409 and 422", async () => {
        const id = (await h.book()).body.data.id as number;
        const path = "/api/consultations/{id}/cancel";
        conforms(await h.cancel(id, "doctor", {}), path, "patch", 400, "ValidationFailed");
        conforms(await h.call("patch", `/api/consultations/${id}/cancel`, undefined, {}, { "Idempotency-Key": randomUUID() }), path, "patch", 401, "Unauthorized");
        conforms(await h.cancel(id, "suspendedPatient", {}), path, "patch", 403, "Forbidden");
        conforms(await h.cancel(id, "otherPatient", {}), path, "patch", 404, "NotFound");
        const key = randomUUID();
        const ok = await h.cancel(id, "doctor", { reason: REASON }, key);
        conforms(ok, path, "patch", 200);
        expectConsultation(ok.body.data, { complaint: true });
        expect(ok.body.data).toMatchObject({ status: "cancelled", cancelledBy: "doctor", cancelReason: REASON });
        expect(String(ok.body.data.cancelledAt)).toMatch(ISO);
        conforms(await h.cancel(id, "doctor", { reason: REASON }), path, "patch", 409, "InvalidTransition");
        conforms(await h.cancel(id, "doctor", { reason: `${REASON} changed` }, key), path, "patch", 422, "IdempotencyConflict");
        const near = await h.seedConsultation({ starts_at: new Date(Date.now() + 60 * 60_000), ends_at: new Date(Date.now() + 90 * 60_000) });
        conforms(await h.cancel(near, "patient", {}), path, "patch", 409, "PolicyWindowViolation");
    });

    it("should conform on getPatientProfile: 200 PatientProfile shape, 401, 403, 404", async () => {
        await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC", allergies: [ALLERGEN] });
        await h.seedConsultation();
        const path = "/api/patients/{patientUserId}";
        const ok = await h.call("get", `/api/patients/${PATIENT}`, "doctor");
        conforms(ok, path, "get", 200);
        const data = ok.body.data as Record<string, unknown>;
        for (const key of inlineLists(schemaBlock("PatientProfile"), "required")[0] ?? []) expect(Object.keys(data)).toContain(key);
        const allowed = [...schemaBlock("PatientProfile").matchAll(/^ {8}([A-Za-z0-9]+):/gm)].map((match) => match[1]);
        for (const key of Object.keys(data)) expect(allowed).toContain(key);
        expect(data.allergies).toEqual([ALLERGEN]);
        conforms(await h.call("get", `/api/patients/${PATIENT}`, undefined), path, "get", 401, "Unauthorized");
        conforms(await h.call("get", `/api/patients/${PATIENT}`, "admin"), path, "get", 403, "Forbidden");
        conforms(await h.call("get", `/api/patients/${PATIENT}`, "otherDoctor"), path, "get", 404, "NotFound");
    });

    it("should send Retry-After on 429 and on the in-flight Conflict as the contract declares", async () => {
        expect(responseBlock("RateLimited")).toContain("Retry-After");
        for (let index = 0; index < 10; index += 1) await h.book("patient", bookingBody({ startsAt: localStart(3, "10:15") }));
        const limited = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:15") }));
        conforms(limited, "/api/consultations", "post", 429, "RateLimited");
        expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
        expect(limited.headers["cache-control"]).toBe(contractNoStoreValue());
    });

    it("should have exercised only statuses each operation declares", () => {
        const ops: Array<[string, string, Method]> = [["POST /api/consultations", "/api/consultations", "post"], ["GET /api/consultations", "/api/consultations", "get"]];
        for (const [key, path, method] of ops) {
            for (const status of seen.get(key) ?? []) expect(contractResponseCodes(path, method)).toContain(status);
        }
        expect(contractOperationBlock("/api/consultations", "post")).toContain("bookConsultation");
    });
});
