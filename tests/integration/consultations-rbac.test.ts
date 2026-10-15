import type { Test } from "supertest";
import { expectErrorEnvelope } from "../helpers/contract";
import {
    ALLERGEN, COMPLAINT, DOCTOR, localStart, OTHER_PATIENT, PATIENT, REASON, bookingBody, useConsultationsHarness,
} from "../helpers/consultations-harness";
import type { Actor } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";

jest.setTimeout(60_000);

type Route = "book" | "list" | "get" | "reschedule" | "cancel" | "patientProfile";
/** [route, actor (undefined = no token), expected status, expected error code (undefined on success)] */
type Cell = readonly [Route, Actor | undefined, number, string | undefined];

const MATRIX: readonly Cell[] = [
    // POST /api/consultations: patient only, verified email, active account
    ["book", undefined, 401, "Unauthorized"], ["book", "patient", 201, undefined], ["book", "unverified", 403, "EmailNotVerified"],
    ["book", "suspendedPatient", 403, "Forbidden"], ["book", "doctor", 403, "Forbidden"], ["book", "admin", 403, "Forbidden"],
    // GET /api/consultations: every active role, scoped by the principal
    ["list", undefined, 401, "Unauthorized"], ["list", "patient", 200, undefined], ["list", "doctor", 200, undefined], ["list", "admin", 200, undefined],
    ["list", "suspendedPatient", 403, "Forbidden"],
    // GET /api/consultations/{id}: participants and admin; everyone else is told it does not exist
    ["get", undefined, 401, "Unauthorized"], ["get", "patient", 200, undefined], ["get", "otherPatient", 404, "NotFound"], ["get", "doctor", 200, undefined],
    ["get", "otherDoctor", 404, "NotFound"], ["get", "admin", 200, undefined], ["get", "suspendedPatient", 403, "Forbidden"],
    // PATCH reschedule: patient owner or admin
    ["reschedule", undefined, 401, "Unauthorized"], ["reschedule", "patient", 200, undefined], ["reschedule", "otherPatient", 404, "NotFound"],
    ["reschedule", "doctor", 403, "Forbidden"], ["reschedule", "otherDoctor", 403, "Forbidden"], ["reschedule", "admin", 200, undefined],
    ["reschedule", "suspendedPatient", 403, "Forbidden"],
    // PATCH cancel: patient owner, assigned doctor, admin
    ["cancel", undefined, 401, "Unauthorized"], ["cancel", "patient", 200, undefined], ["cancel", "otherPatient", 404, "NotFound"],
    ["cancel", "doctor", 200, undefined], ["cancel", "otherDoctor", 404, "NotFound"], ["cancel", "admin", 200, undefined],
    ["cancel", "suspendedToken", 403, "Forbidden"], ["cancel", "suspendedPatient", 403, "Forbidden"],
    // GET /api/patients/{id}: the patient themself or a doctor who has consulted them; never an admin
    ["patientProfile", undefined, 401, "Unauthorized"], ["patientProfile", "patient", 200, undefined], ["patientProfile", "otherPatient", 404, "NotFound"],
    ["patientProfile", "doctor", 200, undefined], ["patientProfile", "otherDoctor", 404, "NotFound"], ["patientProfile", "admin", 403, "Forbidden"],
    ["patientProfile", "suspendedToken", 403, "Forbidden"],
];

describe("consultations RBAC matrix (integration: real routes, Postgres, Redis)", () => {
    const h = useConsultationsHarness("consultations-rbac");
    const snapshot = async (): Promise<unknown> => ({ rows: await h.consultationRows(), outbox: (await h.outbox()).length, audits: (await h.audits("consultation.booked", "consultation.rescheduled", "consultation.cancelled")).length });

    async function drive(route: Route, actor: Actor | undefined, id: number): Promise<Test> {
        switch (route) {
            case "book": return h.call("post", "/api/consultations", actor, bookingBody({ startsAt: localStart(4, "10:00") }), { "Idempotency-Key": crypto.randomUUID() });
            case "list": return h.call("get", "/api/consultations", actor);
            case "get": return h.call("get", `/api/consultations/${id}`, actor);
            case "reschedule": return h.call("patch", `/api/consultations/${id}/reschedule`, actor, { startsAt: localStart(5, "11:00"), reason: REASON }, { "Idempotency-Key": crypto.randomUUID() });
            case "cancel": return h.call("patch", `/api/consultations/${id}/cancel`, actor, { reason: REASON }, { "Idempotency-Key": crypto.randomUUID() });
            case "patientProfile": return h.call("get", `/api/patients/${PATIENT}`, actor);
        }
    }

    it.each(MATRIX)("should answer %s for %s with %i %s", async (route, actor, status, code) => {
        const id = await h.seedConsultation();
        await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC", allergies: [ALLERGEN] });
        const before = await snapshot();
        const res = await drive(route, actor, id);
        expect(res.status).toBe(status);
        if (code !== undefined) {
            expectErrorEnvelope(res.body, code);
            // A denied call leaves no trace: no row changed, no outbox row, no audit row.
            expect(await snapshot()).toEqual(before);
            expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
            expect(JSON.stringify(res.body)).not.toContain(ALLERGEN);
        }
    });

    it("should never let a caller-supplied identity header or body field change who the caller is", async () => {
        const id = await h.seedConsultation();
        const spoof = { "X-User-Id": String(PATIENT), "X-Role": "admin", "X-Forwarded-User": String(PATIENT) };
        expect((await h.call("get", `/api/consultations/${id}`, "otherPatient", undefined, spoof)).status).toBe(404);
        expect((await h.call("get", `/api/patients/${PATIENT}`, "otherDoctor", undefined, spoof)).status).toBe(404);
        const book = await h.call("post", "/api/consultations", "otherPatient", { ...bookingBody({ startsAt: localStart(4, "10:00") }), patientUserId: PATIENT },
            { "Idempotency-Key": crypto.randomUUID(), ...spoof });
        expect(book.status).toBe(400);
        const ok = await h.call("post", "/api/consultations", "otherPatient", bookingBody({ startsAt: localStart(4, "10:00") }), { "Idempotency-Key": crypto.randomUUID(), ...spoof });
        expect(ok.status).toBe(201);
        expect((await h.consultationRows()).find((row) => row.id !== id)).toMatchObject({ patient_user_id: OTHER_PATIENT });
    });

    it("should scope list results to the caller and keep other people's rows out of the page", async () => {
        const mine = await h.seedConsultation();
        const theirs = await h.seedConsultation({ patient_user_id: OTHER_PATIENT, starts_at: new Date(Date.now() + 4 * 86_400_000), ends_at: new Date(Date.now() + 4 * 86_400_000 + 1_800_000) });
        const ids = async (actor: Actor): Promise<number[]> => ((await h.call("get", "/api/consultations", actor)).body.data as Array<{ id: number }>).map((item) => item.id);
        expect(await ids("patient")).toEqual([mine]);
        expect(await ids("otherPatient")).toEqual([theirs]);
        expect(await ids("doctor")).toEqual([mine, theirs]);
        expect(await ids("otherDoctor")).toEqual([]);
        expect(await ids("admin")).toEqual([mine, theirs]);
    });

    describe("admin sees no clinical field anywhere", () => {
        it("should omit complaintText and the complaint string from admin get, list, reschedule and cancel responses", async () => {
            const id = await h.seedConsultation();
            const responses = [
                await h.call("get", `/api/consultations/${id}`, "admin"),
                await h.call("get", "/api/consultations", "admin"),
                await h.reschedule(id, "admin", { startsAt: localStart(5, "11:00"), reason: REASON }),
                await h.cancel(id, "admin", { reason: REASON }),
            ];
            for (const res of responses) {
                expect(res.status).toBe(200);
                expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
                expect(JSON.stringify(res.body)).not.toContain("complaintText");
            }
        });

        it("should give participants the complaint on get-one and on their own write responses, and never on list items", async () => {
            const id = await h.seedConsultation();
            expect((await h.call("get", `/api/consultations/${id}`, "patient")).body.data.complaintText).toBe(COMPLAINT);
            expect((await h.call("get", `/api/consultations/${id}`, "doctor")).body.data.complaintText).toBe(COMPLAINT);
            for (const actor of ["patient", "doctor", "admin"] as const) {
                const list = await h.call("get", "/api/consultations", actor);
                expect(JSON.stringify(list.body)).not.toContain(COMPLAINT);
            }
            const rescheduled = await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00") });
            expect(rescheduled.body.data.complaintText).toBe(COMPLAINT);
        });

        it("should answer 403 to an admin on the patient profile even when the profile exists and carries clinical fields", async () => {
            await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC", allergies: [ALLERGEN] });
            await h.seedConsultation();
            const res = await h.call("get", `/api/patients/${PATIENT}`, "admin");
            expect(res.status).toBe(403);
            expect(JSON.stringify(res.body)).not.toContain(ALLERGEN);
            expect(await ownerDb("audit_logs").where("action", "patient_profile.read")).toHaveLength(0);
        });
    });

    describe("a locally suspended doctor", () => {
        beforeEach(async () => { await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: new Date(), suspension_reason: "synthetic" }); });

        it("should still read own list and own consultation (reads are not practising actions)", async () => {
            const id = await h.seedConsultation();
            expect((await h.call("get", "/api/consultations", "doctor")).status).toBe(200);
            expect((await h.call("get", `/api/consultations/${id}`, "doctor")).status).toBe(200);
        });

        it("should be denied cancel and the patient profile with 403 Forbidden even though the token is still valid", async () => {
            const id = await h.seedConsultation();
            await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC" });
            const cancel = await h.cancel(id, "doctor", { reason: REASON });
            expect(cancel.status).toBe(403); expectErrorEnvelope(cancel.body, "Forbidden");
            const profile = await h.call("get", `/api/patients/${PATIENT}`, "doctor");
            expect(profile.status).toBe(403); expectErrorEnvelope(profile.body, "Forbidden");
            expect((await h.consultationRows())[0]).toMatchObject({ status: "booked" });
        });

        it("should let the admin and the patient still cancel (the block is on the doctor only)", async () => {
            const id = await h.seedConsultation();
            expect((await h.cancel(id, "admin", { reason: REASON })).status).toBe(200);
            const second = await h.seedConsultation({ starts_at: new Date(Date.now() + 4 * 86_400_000), ends_at: new Date(Date.now() + 4 * 86_400_000 + 1_800_000) });
            expect((await h.cancel(second, "patient")).status).toBe(200);
        });

        it("should block new bookings with 409 DoctorNotBookable", async () => {
            const res = await h.book();
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "DoctorNotBookable");
        });
    });
});
