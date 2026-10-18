import { contractNoStoreValue, expectErrorEnvelope } from "../helpers/contract";
import { DOCTOR, OTHER_PATIENT, PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import {
    AMEND_REASON, amendmentRows, CHIEF, createRecord, DX_TEXT, getRecord, lockNow, MARKERS, NOTES, patchRecord, PLAN, postRecord, provisionOtherDoctor, recordBody, recordRows,
    relate, seedCompleted, STRANGER_DOCTOR, suspendLocally, timeline,
} from "../helpers/records-fixtures";

jest.setTimeout(120_000);

type Who = "none" | "patient" | "otherPatient" | "author" | "related" | "unrelated" | "suspendedLocal" | "pending" | "suspendedToken" | "admin" | "cancelledOnly" | "bookedOnly";
type Route = "create" | "get" | "update" | "amend" | "timeline";
/** [route, who, expected status, expected error code (undefined on success)] */
type Cell = readonly [Route, Who, number, string | undefined];

const CANCELLED_ONLY_DOCTOR = 206;
const BOOKED_ONLY_DOCTOR = 207;

const MATRIX: readonly Cell[] = [
    // POST /consultations/{id}/record: the assigned doctor only; every other doctor, related or not, is 404 (M1)
    ["create", "none", 401, "Unauthorized"], ["create", "patient", 403, "Forbidden"], ["create", "otherPatient", 403, "Forbidden"], ["create", "author", 201, undefined],
    ["create", "related", 404, "NotFound"], ["create", "bookedOnly", 404, "NotFound"], ["create", "unrelated", 404, "NotFound"], ["create", "cancelledOnly", 404, "NotFound"], ["create", "suspendedLocal", 403, "Forbidden"],
    ["create", "pending", 403, "Forbidden"], ["create", "suspendedToken", 403, "Forbidden"], ["create", "admin", 403, "Forbidden"],
    // GET /records/{id}: the patient, the author and a consulted doctor; never an admin
    ["get", "none", 401, "Unauthorized"], ["get", "patient", 200, undefined], ["get", "otherPatient", 404, "NotFound"], ["get", "author", 200, undefined],
    ["get", "related", 200, undefined], ["get", "bookedOnly", 200, undefined], ["get", "unrelated", 404, "NotFound"], ["get", "cancelledOnly", 404, "NotFound"],
    ["get", "suspendedLocal", 404, "NotFound"], ["get", "pending", 403, "Forbidden"], ["get", "suspendedToken", 403, "Forbidden"], ["get", "admin", 403, "Forbidden"],
    // PATCH /records/{id} before the lock: the author only
    ["update", "none", 401, "Unauthorized"], ["update", "patient", 403, "Forbidden"], ["update", "otherPatient", 403, "Forbidden"], ["update", "author", 200, undefined],
    ["update", "related", 403, "NotAssignedDoctor"], ["update", "unrelated", 404, "NotFound"], ["update", "cancelledOnly", 404, "NotFound"], ["update", "suspendedLocal", 403, "Forbidden"],
    ["update", "pending", 403, "Forbidden"], ["update", "suspendedToken", 403, "Forbidden"], ["update", "admin", 403, "Forbidden"],
    // PATCH /records/{id} after the lock (an amendment): the same people, the same answers
    ["amend", "none", 401, "Unauthorized"], ["amend", "patient", 403, "Forbidden"], ["amend", "author", 201, undefined], ["amend", "related", 403, "NotAssignedDoctor"],
    ["amend", "unrelated", 404, "NotFound"], ["amend", "suspendedLocal", 403, "Forbidden"], ["amend", "admin", 403, "Forbidden"],
    // GET /patients/{patientUserId}/records: the patient themself or a consulted doctor
    ["timeline", "none", 401, "Unauthorized"], ["timeline", "patient", 200, undefined], ["timeline", "otherPatient", 404, "NotFound"], ["timeline", "author", 200, undefined],
    ["timeline", "related", 200, undefined], ["timeline", "bookedOnly", 200, undefined], ["timeline", "unrelated", 404, "NotFound"], ["timeline", "cancelledOnly", 404, "NotFound"],
    ["timeline", "suspendedLocal", 404, "NotFound"], ["timeline", "pending", 403, "Forbidden"], ["timeline", "suspendedToken", 403, "Forbidden"], ["timeline", "admin", 403, "Forbidden"],
];

describe("records RBAC matrix (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("records-rbac");
    const tokens = {} as Record<Who, string | undefined>;
    let consultationId = 0;
    let recordId = 0;
    let spareConsultationId = 0;

    beforeAll(async () => {
        tokens.none = undefined;
        tokens.patient = h.tokens.patient; tokens.otherPatient = h.tokens.otherPatient; tokens.author = h.tokens.doctor; tokens.related = h.tokens.otherDoctor;
        tokens.suspendedToken = h.tokens.suspendedToken; tokens.admin = h.tokens.admin; tokens.suspendedLocal = h.tokens.doctor;
        tokens.unrelated = await h.signFor(STRANGER_DOCTOR, "doctor");
        tokens.pending = await h.signFor(DOCTOR, "doctor", "pending");
        tokens.cancelledOnly = await h.signFor(CANCELLED_ONLY_DOCTOR, "doctor");
        tokens.bookedOnly = await h.signFor(BOOKED_ONLY_DOCTOR, "doctor");
    });

    /** Consultation A (completed) already holds a record; consultation B (completed) has none yet. Doctor 204 and 207 are related, 206 only cancelled/no-show. */
    beforeEach(async () => {
        await provisionOtherDoctor(h);
        await h.seedDoctor(CANCELLED_ONLY_DOCTOR);
        await relate(h, CANCELLED_ONLY_DOCTOR, PATIENT, "cancelled");
        await relate(h, CANCELLED_ONLY_DOCTOR, PATIENT, "no_show");
        await relate(h, BOOKED_ONLY_DOCTOR, PATIENT, "booked");
        consultationId = await seedCompleted(h);
        recordId = await createRecord(h, consultationId);
        spareConsultationId = await seedCompleted(h);
    });

    const snapshot = async (): Promise<unknown> => ({ records: await recordRows(), amendments: await amendmentRows(), audits: await ownerDb("audit_logs").select("action", "entity_id").orderBy("id") });

    const drive = (route: Route, who: Who) => {
        const token = tokens[who];
        const send = (verb: "get" | "post" | "patch", path: string, payload?: object) =>
            token === undefined ? h.call(verb, path, undefined, payload) : h.callWith(token, verb, path, payload);
        switch (route) {
            case "create": return send("post", `/api/consultations/${spareConsultationId}/record`, recordBody());
            case "get": return send("get", `/api/records/${recordId}`);
            case "update": return send("patch", `/api/records/${recordId}`, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
            case "amend": return send("patch", `/api/records/${recordId}`, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: AMEND_REASON });
            case "timeline": return send("get", `/api/patients/${PATIENT}/records`);
        }
    };

    it.each(MATRIX)("should answer %s for %s with %i %s", async (route, who, status, code) => {
        if (route === "amend") await lockNow(recordId);
        if (who === "suspendedLocal") await suspendLocally(DOCTOR);
        const before = await snapshot();
        const res = await drive(route, who);
        expect(res.status).toBe(status);
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        if (code !== undefined) {
            expectErrorEnvelope(res.body, code);
            // A denied call leaves no trace: no row changed and no audit row was written.
            expect(await snapshot()).toEqual(before);
            for (const text of [...MARKERS, "SYNTHETIC-PLAN-NEW"]) expect(JSON.stringify(res.body)).not.toContain(text);
        }
        // Every response on these paths is uncacheable, success or error, authenticated or not.
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
    });

    it("should answer 403 to an admin on every record route whether or not the id exists, so an admin learns nothing about ids", async () => {
        const probes: Array<[string, string, object | undefined]> = [
            ["post", `/api/consultations/${consultationId}/record`, recordBody()], ["post", "/api/consultations/999999/record", recordBody()], ["post", "/api/consultations/abc/record", recordBody()],
            ["get", `/api/records/${recordId}`, undefined], ["get", "/api/records/999999", undefined], ["get", "/api/records/abc", undefined],
            ["patch", `/api/records/${recordId}`, { treatmentPlan: PLAN }], ["patch", "/api/records/999999", { treatmentPlan: PLAN }], ["patch", "/api/records/abc", { treatmentPlan: PLAN }],
            ["get", `/api/patients/${PATIENT}/records`, undefined], ["get", "/api/patients/999999/records", undefined], ["get", "/api/patients/me/records", undefined],
        ];
        const before = await snapshot();
        for (const [verb, path, payload] of probes) {
            const res = await h.call(verb as "get", path, "admin", payload);
            expect([verb, path, res.status]).toEqual([verb, path, 403]);
            expectErrorEnvelope(res.body, "Forbidden");
        }
        expect(await snapshot()).toEqual(before);
    });

    it("should never put a clinical field in a response an admin can trigger", async () => {
        const bodies: string[] = [];
        for (const [verb, path] of [["get", `/api/records/${recordId}`], ["get", `/api/patients/${PATIENT}/records`], ["get", `/api/consultations/${consultationId}`]] as const) {
            bodies.push(JSON.stringify((await h.call(verb, path, "admin")).body));
        }
        for (const body of bodies) for (const text of [...MARKERS, "chiefComplaint", "examinationNotes", "diagnosisText", "treatmentPlan", "allergies"]) expect(body).not.toContain(text);
    });

    it("should answer 403 for a wrong role before the resource is looked up, even for ids that do not exist", async () => {
        for (const path of ["/api/consultations/999999/record", "/api/consultations/abc/record"]) expect((await h.call("post", path, "patient", recordBody())).status).toBe(403);
        expect((await h.call("patch", "/api/records/999999", "patient", { treatmentPlan: PLAN })).status).toBe(403);
        expect((await h.call("patch", "/api/records/abc", "otherPatient", { treatmentPlan: PLAN })).status).toBe(403);
    });

    it("should answer 404 for the same unknown ids to every permitted role, so existence cannot be probed", async () => {
        for (const who of ["patient", "otherPatient", "author", "related", "unrelated"] as const) {
            const read = await h.callWith(tokens[who] ?? "", "get", "/api/records/999999");
            const readText = await h.callWith(tokens[who] ?? "", "get", "/api/records/abc");
            expect([who, read.status, readText.status]).toEqual([who, 404, 404]);
        }
        for (const who of ["author", "related", "unrelated"] as const) {
            expect([who, (await h.callWith(tokens[who] ?? "", "patch", "/api/records/999999", { treatmentPlan: PLAN })).status]).toEqual([who, 404]);
            expect([who, (await h.callWith(tokens[who] ?? "", "post", "/api/consultations/999999/record", recordBody())).status]).toEqual([who, 404]);
        }
        const foreign = await h.callWith(tokens.otherPatient ?? "", "get", `/api/records/${recordId}`);
        const missing = await h.callWith(tokens.otherPatient ?? "", "get", "/api/records/999999");
        expect(foreign.body.error.message).toBe(missing.body.error.message);
        expect(foreign.body.error.code).toBe(missing.body.error.code);
    });

    it("should answer the timeline of /patients/me and of a non-numeric or unknown patient with 404 for patients and doctors", async () => {
        for (const who of ["patient", "author", "related"] as const) {
            for (const id of ["me", "abc", "0", "-1", "999999"]) {
                const res = await h.callWith(tokens[who] ?? "", "get", `/api/patients/${id}/records`);
                expect([who, id, res.status]).toEqual([who, id, 404]);
            }
        }
    });

    it("should keep a suspended author's record readable to the patient and to other consulted doctors while the author gets 404 on reads and 403 on writes", async () => {
        await suspendLocally(DOCTOR);
        expect((await getRecord(h, recordId, "patient")).status).toBe(200);
        expect((await getRecord(h, recordId, "otherDoctor")).status).toBe(200);
        expect((await timeline(h, PATIENT, "patient")).status).toBe(200);
        expect((await timeline(h, PATIENT, "otherDoctor")).status).toBe(200);
        expect((await getRecord(h, recordId, "doctor")).status).toBe(404);
        expect((await timeline(h, PATIENT, "doctor")).status).toBe(404);
        expect((await patchRecord(h, recordId, { treatmentPlan: PLAN }, "doctor")).status).toBe(403);
        expect((await postRecord(h, spareConsultationId, recordBody(), "doctor")).status).toBe(403);
    });

    it("should let a doctor's access follow the consultation relationship: a booked relationship grants, a cancelled one never does, and a later live one does", async () => {
        const stranger = await h.signFor(CANCELLED_ONLY_DOCTOR, "doctor");
        expect((await h.callWith(stranger, "get", `/api/records/${recordId}`)).status).toBe(404);
        await relate(h, CANCELLED_ONLY_DOCTOR, PATIENT, "waiting");
        expect((await h.callWith(stranger, "get", `/api/records/${recordId}`)).status).toBe(200);
        expect((await h.callWith(stranger, "get", `/api/patients/${PATIENT}/records`)).status).toBe(200);
        // A relationship with a patient grants nothing about another patient's records.
        const other = await seedCompleted(h, { patient_user_id: OTHER_PATIENT });
        const otherRecord = await createRecord(h, other);
        expect((await h.callWith(stranger, "get", `/api/records/${otherRecord}`)).status).toBe(404);
        expect((await h.callWith(stranger, "get", `/api/patients/${OTHER_PATIENT}/records`)).status).toBe(404);
    });

    it("should let each patient read only their own records and timeline", async () => {
        const other = await seedCompleted(h, { patient_user_id: OTHER_PATIENT });
        const otherRecord = await createRecord(h, other);
        expect((await getRecord(h, otherRecord, "otherPatient")).status).toBe(200);
        expect((await getRecord(h, otherRecord, "patient")).status).toBe(404);
        expect((await getRecord(h, recordId, "otherPatient")).status).toBe(404);
        expect((await timeline(h, OTHER_PATIENT, "otherPatient")).body.data.records.map((record: { id: number }) => record.id)).toEqual([otherRecord]);
        expect((await timeline(h, OTHER_PATIENT, "patient")).status).toBe(404);
    });

    it("should never let a caller-supplied identity header change who the caller is", async () => {
        const spoof = { "X-User-Id": String(DOCTOR), "X-Role": "admin", "X-Forwarded-User": String(PATIENT) };
        expect((await h.call("get", `/api/records/${recordId}`, "otherPatient", undefined, spoof)).status).toBe(404);
        expect((await h.call("get", `/api/records/${recordId}`, "admin", undefined, spoof)).status).toBe(403);
        expect((await h.call("patch", `/api/records/${recordId}`, "patient", { treatmentPlan: PLAN }, spoof)).status).toBe(403);
        expect((await h.call("patch", `/api/records/${recordId}`, undefined, { treatmentPlan: PLAN }, spoof)).status).toBe(401);
        expect((await h.call("get", `/api/records/${recordId}`, undefined, undefined, spoof)).status).toBe(401);
        expect((await h.callWith(tokens.unrelated ?? "", "get", `/api/records/${recordId}`, undefined, spoof)).status).toBe(404);
        expect((await recordRows())[0]?.treatment_plan).toBe(PLAN);
    });

    it("should answer 401 for a malformed or non-bearer credential on every record route", async () => {
        for (const [verb, path] of [["post", `/api/consultations/${spareConsultationId}/record`], ["get", `/api/records/${recordId}`], ["patch", `/api/records/${recordId}`], ["get", `/api/patients/${PATIENT}/records`]] as const) {
            for (const authorization of ["Bearer not.a.jwt", "Basic Zm9vOmJhcg==", "Bearer ", "token"]) {
                const res = await h.call(verb, path, undefined, verb === "get" ? undefined : recordBody(), { Authorization: authorization });
                expect([verb, path, authorization, res.status]).toEqual([verb, path, authorization, 401]);
                expectErrorEnvelope(res.body, "Unauthorized");
            }
        }
    });

    it("should not expose clinical text to a denied caller in any error body", async () => {
        for (const who of ["otherPatient", "unrelated", "admin", "pending"] as const) {
            for (const route of ["get", "timeline", "update"] as const) {
                const res = await drive(route, who);
                for (const text of [CHIEF, NOTES, DX_TEXT, PLAN]) expect(JSON.stringify(res.body)).not.toContain(text);
            }
        }
    });
});
