import { expectErrorEnvelope } from "../helpers/contract";
import type { Actor } from "../helpers/consultations-harness";
import { COMPLAINT, HOUR, MINUTE, OTHER_DOCTOR, PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { GRACE_MS, patch, seedSession, SESSION_MS, sessionStart } from "../helpers/sessions-fixtures";

jest.setTimeout(120_000);

type Route = "join" | "start" | "complete" | "noShow" | "waitingRoom" | "calendar";
/** [route, actor (undefined = no token), expected status, expected error code (undefined on success)] */
type Cell = readonly [Route, Actor | undefined, number, string | undefined];

const MATRIX: readonly Cell[] = [
    // PATCH join: the patient who booked it or the assigned doctor
    ["join", undefined, 401, "Unauthorized"], ["join", "patient", 200, undefined], ["join", "otherPatient", 404, "NotFound"], ["join", "doctor", 200, undefined],
    ["join", "otherDoctor", 404, "NotFound"], ["join", "admin", 403, "Forbidden"], ["join", "suspendedPatient", 403, "Forbidden"], ["join", "suspendedToken", 403, "Forbidden"],
    // PATCH start: the assigned doctor only
    ["start", undefined, 401, "Unauthorized"], ["start", "patient", 403, "Forbidden"], ["start", "otherPatient", 403, "Forbidden"], ["start", "doctor", 200, undefined],
    ["start", "otherDoctor", 404, "NotFound"], ["start", "admin", 403, "Forbidden"], ["start", "suspendedToken", 403, "Forbidden"],
    // PATCH complete: the assigned doctor only
    ["complete", undefined, 401, "Unauthorized"], ["complete", "patient", 403, "Forbidden"], ["complete", "otherPatient", 403, "Forbidden"], ["complete", "doctor", 200, undefined],
    ["complete", "otherDoctor", 404, "NotFound"], ["complete", "admin", 403, "Forbidden"], ["complete", "suspendedToken", 403, "Forbidden"],
    // PATCH no-show: the assigned doctor or any admin
    ["noShow", undefined, 401, "Unauthorized"], ["noShow", "patient", 403, "Forbidden"], ["noShow", "otherPatient", 403, "Forbidden"], ["noShow", "doctor", 200, undefined],
    ["noShow", "otherDoctor", 404, "NotFound"], ["noShow", "admin", 200, undefined], ["noShow", "suspendedToken", 403, "Forbidden"],
    // GET waiting-room and calendar: the doctor themself
    ["waitingRoom", undefined, 401, "Unauthorized"], ["waitingRoom", "patient", 403, "Forbidden"], ["waitingRoom", "doctor", 200, undefined],
    ["waitingRoom", "otherDoctor", 200, undefined], ["waitingRoom", "admin", 403, "Forbidden"], ["waitingRoom", "suspendedToken", 403, "Forbidden"],
    ["calendar", undefined, 401, "Unauthorized"], ["calendar", "patient", 403, "Forbidden"], ["calendar", "doctor", 200, undefined],
    ["calendar", "otherDoctor", 200, undefined], ["calendar", "admin", 403, "Forbidden"], ["calendar", "suspendedToken", 403, "Forbidden"],
];

describe("sessions RBAC matrix (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("sessions-rbac");
    beforeEach(async () => { await h.seedDoctor(OTHER_DOCTOR); });
    const snapshot = async (): Promise<unknown> => ({ rows: await h.consultationRows(), outbox: await h.outbox(),
        audits: (await ownerDb("audit_logs").select("action", "entity_id").orderBy("id")) as unknown[] });

    /** The row each route needs, with the clock inside the state's window (or past the no-show grace). */
    async function prepare(route: Route): Promise<number> {
        switch (route) {
            case "complete": { const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) }); h.clock.freeze(sessionStart() + 10 * MINUTE); return id; }
            case "noShow": { const id = await seedSession(h); h.clock.freeze(sessionStart() + GRACE_MS); return id; }
            default: { const id = await seedSession(h); h.clock.freeze(sessionStart() + MINUTE); return id; }
        }
    }
    const window = (): string => `from=${encodeURIComponent(new Date(sessionStart() - HOUR).toISOString())}&to=${encodeURIComponent(new Date(sessionStart() + HOUR).toISOString())}`;
    const drive = (route: Route, actor: Actor | undefined, id: number) => {
        switch (route) {
            case "join": return patch(h, id, "join", actor);
            case "start": return patch(h, id, "start", actor);
            case "complete": return patch(h, id, "complete", actor);
            case "noShow": return patch(h, id, "no-show", actor);
            case "waitingRoom": return h.call("get", "/api/consultations/waiting-room", actor);
            case "calendar": return h.call("get", `/api/consultations/calendar?${window()}`, actor);
        }
    };

    it.each(MATRIX)("should answer %s for %s with %i %s", async (route, actor, status, code) => {
        const id = await prepare(route);
        const before = await snapshot();
        const res = await drive(route, actor, id);
        expect(res.status).toBe(status);
        if (code !== undefined) {
            expectErrorEnvelope(res.body, code);
            // A denied call leaves no trace: no row changed, no outbox or audit row, no provider call.
            expect(await snapshot()).toEqual(before);
            expect(h.video.ensureCalls).toHaveLength(0);
            expect(h.video.tokenCalls).toHaveLength(0);
            expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
        }
    });

    it.each(["join", "start", "complete", "no-show"] as const)("should answer 404 NotFound for a non-numeric or unknown id on %s", async (action) => {
        h.clock.freeze(sessionStart());
        for (const id of ["abc", "0", "-1", "99999999"]) {
            const res = await patch(h, id, action, action === "join" ? "patient" : "doctor");
            expect([action, id, res.status]).toEqual([action, id, 404]);
            expectErrorEnvelope(res.body, "NotFound");
        }
    });

    it("should hide the other doctor's rows in the waiting room and the calendar instead of denying", async () => {
        const id = await seedSession(h);
        h.clock.freeze(sessionStart());
        const waiting = await h.call("get", "/api/consultations/waiting-room", "otherDoctor");
        expect(waiting.status).toBe(200);
        expect(waiting.body.data).toEqual([]);
        const calendar = await h.call("get", `/api/consultations/calendar?${window()}`, "otherDoctor");
        expect(calendar.body.data.consultations).toEqual([]);
        expect((await h.call("get", "/api/consultations/waiting-room", "doctor")).body.data.map((entry: { id: number }) => entry.id)).toEqual([id]);
    });

    it("should never let a caller-supplied identity header turn another principal into a participant or an admin", async () => {
        const id = await seedSession(h);
        h.clock.freeze(sessionStart() + GRACE_MS);
        const spoof = { "X-User-Id": String(PATIENT), "X-Role": "admin", "X-Forwarded-User": "202" };
        expect((await h.call("patch", `/api/consultations/${id}/join`, "otherPatient", undefined, spoof)).status).toBe(404);
        expect((await h.call("patch", `/api/consultations/${id}/start`, "admin", undefined, spoof)).status).toBe(403);
        expect((await h.call("patch", `/api/consultations/${id}/no-show`, "otherDoctor", undefined, spoof)).status).toBe(404);
        expect((await h.call("patch", `/api/consultations/${id}/no-show`, "patient", undefined, spoof)).status).toBe(403);
        expect((await h.consultationRows())[0]).toMatchObject({ status: "booked" });
    });

    describe("account state", () => {
        /** Per-route fixtures + request, so one table drives the suspension and the account-status cases. */
        const requests: Array<[string, Route, Actor | "pending"]> = [
            ["join", "join", "doctor"], ["start", "start", "doctor"], ["complete", "complete", "doctor"], ["no-show", "noShow", "doctor"],
            ["waiting-room", "waitingRoom", "doctor"], ["calendar", "calendar", "doctor"],
        ];

        it.each(requests)("should answer 403 Forbidden on %s immediately for a locally suspended doctor whose token still says active", async (_label, route) => {
            const id = await prepare(route);
            await ownerDb("doctor_profiles").where({ user_id: 202 }).update({ suspended_at: new Date(), suspension_reason: "SYNTHETIC-SUSPENSION" });
            const before = await snapshot();
            const res = await drive(route, "doctor", id);
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
            expect(await snapshot()).toEqual(before);
            expect(h.video.ensureCalls).toHaveLength(0);
        });

        it("should still let an admin mark a no-show for a consultation of a locally suspended doctor", async () => {
            const id = await prepare("noShow");
            await ownerDb("doctor_profiles").where({ user_id: 202 }).update({ suspended_at: new Date(), suspension_reason: "SYNTHETIC-SUSPENSION" });
            const res = await drive("noShow", "admin", id);
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe("no_show");
        });

        it("should still let the patient join a suspended doctor's consultation (the check applies to doctors only)", async () => {
            const id = await prepare("join");
            await ownerDb("doctor_profiles").where({ user_id: 202 }).update({ suspended_at: new Date(), suspension_reason: "SYNTHETIC-SUSPENSION" });
            expect((await drive("join", "patient", id)).status).toBe(200);
        });

        it.each(requests)("should answer 403 Forbidden on %s for a doctor whose account status is pending", async (_label, route) => {
            const id = await prepare(route);
            const token = await h.signFor(202, "doctor", "pending");
            const before = await snapshot();
            const method = route === "waitingRoom" || route === "calendar" ? "get" : "patch";
            const path = route === "waitingRoom" ? "/api/consultations/waiting-room" : route === "calendar" ? `/api/consultations/calendar?${window()}`
                : `/api/consultations/${id}/${route === "noShow" ? "no-show" : route}`;
            const res = await h.callWith(token, method, path);
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
            expect(await snapshot()).toEqual(before);
        });

        it("should answer 403 Forbidden to an admin whose account status is not active on no-show", async () => {
            const id = await prepare("noShow");
            const res = await h.callWith(await h.signFor(303, "admin", "suspended"), "patch", `/api/consultations/${id}/no-show`);
            expect(res.status).toBe(403);
        });
    });

    it("should never put complaint text in any session response for any permitted viewer", async () => {
        const id = await seedSession(h);
        h.clock.freeze(sessionStart() + MINUTE);
        const bodies = [
            (await patch(h, id, "join", "patient")).body, (await patch(h, id, "join", "doctor")).body, (await patch(h, id, "start", "doctor")).body,
            (await h.call("get", "/api/consultations/waiting-room", "doctor")).body, (await h.call("get", `/api/consultations/calendar?${window()}`, "doctor")).body,
            (await patch(h, id, "complete", "doctor")).body,
        ];
        for (const body of bodies) expect(JSON.stringify(body)).not.toContain(COMPLAINT);
        const noShowRow = await seedSession(h, {}, sessionStart() + 3 * HOUR + SESSION_MS);
        h.clock.freeze(sessionStart() + 3 * HOUR + SESSION_MS + GRACE_MS);
        const admin = await patch(h, noShowRow, "no-show", "admin");
        expect(admin.status).toBe(200);
        expect(JSON.stringify(admin.body)).not.toContain(COMPLAINT);
        expect(admin.body.data).not.toHaveProperty("complaintText");
    });
});
