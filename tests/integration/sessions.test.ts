import { getEnv } from "../../src/lib/config/env";
import { verifyFakeJoinToken } from "../../src/lib/video/fake-video.adapter";
import { redis } from "../../src/lib/redis/redis";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { COMPLAINT, DOCTOR, HOUR, localStart, MINUTE, OTHER_PATIENT, PATIENT, REASON, useConsultationsHarness } from "../helpers/consultations-harness";
import { GRACE_MS, NOTE, OPEN_MS, OVERRUN_MS, patch, seedSession, SESSION_MS, sessionStart, TOKEN_TTL_MS } from "../helpers/sessions-fixtures";

jest.setTimeout(120_000);

const SECRET = getEnv().VIDEO_PROVIDER_KEY;
const SESSION_AUDITS = ["consultation.booked", "consultation.waiting", "consultation.started", "consultation.completed", "consultation.no_show"];
const doctorJoined = async (h: ReturnType<typeof useConsultationsHarness>): Promise<Array<Record<string, any>>> => // eslint-disable-line @typescript-eslint/no-explicit-any
    (await h.outbox()).filter((row) => row.kind === "doctor_joined");

describe("sessions lifecycle, windows, concurrency and provider outages (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("sessions");
    const freezeAt = (ms: number): void => h.clock.freeze(ms);
    const row = async (id: number): Promise<Record<string, any>> => (await h.consultationRows()).find((entry) => entry.id === id) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    // ───────────────────────────────────────────── lifecycle (SS-R4, SS-R6, SS-R7, SS-R8, SS-R15)
    describe("lifecycle", () => {
        it("should walk a booked consultation through join, start and complete with timestamps, audit rows and one doctor_joined notice", async () => {
            const booked = await h.book("patient");
            expect(booked.status).toBe(201);
            const id = booked.body.data.id as number;
            const start = Date.parse(booked.body.data.startsAt as string);
            freezeAt(start - 5 * MINUTE);

            const join = await patch(h, id, "join", "patient");
            expect(join.status).toBe(200);
            const joined = expectSuccessEnvelope(join.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
            expect(Object.keys(joined).sort()).toEqual(["consultation", "joinToken", "joinTokenExpiresAt", "roomId", "windowClosesAt", "windowOpensAt"].sort());
            expect(joined.consultation).toMatchObject({ id, status: "waiting", joinedAt: new Date(start - 5 * MINUTE).toISOString() });
            expect(joined.consultation.patient).toEqual({ userId: PATIENT, displayName: null, avatarUrl: null, profileHydrated: false });
            expect(joined.consultation.doctor).toMatchObject({ userId: DOCTOR, profileHydrated: false });
            expect(joined.consultation).not.toHaveProperty("complaintText");
            expect(joined.consultation).not.toHaveProperty("roomId");
            expect(joined.roomId).toBe(`fake-room-${id}`);
            expect(joined.windowOpensAt).toBe(new Date(start - OPEN_MS).toISOString());
            expect(joined.windowClosesAt).toBe(new Date(start + SESSION_MS + OVERRUN_MS).toISOString());
            expect(verifyFakeJoinToken(joined.joinToken as string, SECRET, start - 5 * MINUTE)).toEqual({ roomId: `fake-room-${id}`, userId: PATIENT, role: "patient", expiresAtMs: start - 5 * MINUTE + TOKEN_TTL_MS });
            expect(joined.joinTokenExpiresAt).toBe(new Date(start - 5 * MINUTE + TOKEN_TTL_MS).toISOString());
            expect(await row(id)).toMatchObject({ status: "waiting", room_id: `fake-room-${id}`, started_at: null, completed_at: null });

            freezeAt(start + MINUTE);
            const started = await patch(h, id, "start", "doctor");
            expect(started.status).toBe(200);
            expect(started.body.data.consultation).toMatchObject({ id, status: "in_progress", startedAt: new Date(start + MINUTE).toISOString() });
            expect(verifyFakeJoinToken(started.body.data.joinToken as string, SECRET, start + MINUTE)).toMatchObject({ userId: DOCTOR, role: "doctor", roomId: `fake-room-${id}` });
            expect(started.body.data.consultation).not.toHaveProperty("complaintText");

            freezeAt(start + 20 * MINUTE);
            const completed = await patch(h, id, "complete", "doctor");
            expect(completed.status).toBe(200);
            expect(completed.body.data).toMatchObject({ id, status: "completed", completedAt: new Date(start + 20 * MINUTE).toISOString() });
            expect(completed.body.data).not.toHaveProperty("complaintText");
            expect(await row(id)).toMatchObject({ status: "completed" });

            expect((await h.audits(...SESSION_AUDITS)).map((entry) => [entry.action, entry.actor_role, entry.actor_user_id, entry.entity_type, entry.entity_id]))
                .toEqual([["consultation.booked", "patient", PATIENT, "consultation", id], ["consultation.waiting", "patient", PATIENT, "consultation", id],
                    ["consultation.started", "doctor", DOCTOR, "consultation", id], ["consultation.completed", "doctor", DOCTOR, "consultation", id]]);
            const [waiting, startedAudit, completedAudit] = (await h.audits("consultation.waiting", "consultation.started", "consultation.completed"));
            expect(waiting?.metadata).toEqual({ byRole: "patient", fromStatus: "booked" });
            expect(startedAudit?.metadata).toEqual({ byRole: "doctor", fromStatus: "waiting" });
            expect(completedAudit?.metadata).toEqual({ byRole: "doctor" });
            expect((await h.audits("consultation.waiting"))[0]?.request_id).toEqual(expect.any(String));

            const notices = await doctorJoined(h);
            expect(notices).toHaveLength(1);
            expect(notices[0]).toMatchObject({ consultation_id: id, recipient_user_id: PATIENT, status: "pending" });
            expect(Object.keys(notices[0]?.payload as object).sort()).toEqual(["endsAt", "recipientRole", "startsAt"]);
            expect(notices[0]?.payload).toMatchObject({ recipientRole: "patient", startsAt: new Date(start).toISOString(), endsAt: new Date(start + SESSION_MS).toISOString() });
        });

        it("should answer 409 InvalidTransition on a second start and queue no second notice or audit row", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            expect((await patch(h, id, "start", "doctor")).status).toBe(200);
            const again = await patch(h, id, "start", "doctor");
            expect(again.status).toBe(409);
            expectErrorEnvelope(again.body, "InvalidTransition");
            expect(await doctorJoined(h)).toHaveLength(1);
            expect(await h.audits("consultation.started")).toHaveLength(1);
        });

        it("should start straight from booked (waiting is optional) and record the prior status in the audit row", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + MINUTE);
            expect((await patch(h, id, "start", "doctor")).status).toBe(200);
            expect((await h.audits("consultation.started"))[0]?.metadata).toEqual({ byRole: "doctor", fromStatus: "booked" });
            expect((await row(id)).joined_at).toBeNull();
        });

        it("should refuse complete unless the consultation is in_progress and leave the row untouched", async () => {
            for (const status of ["booked", "waiting"]) {
                const id = await seedSession(h, { status }, sessionStart() + (status === "booked" ? 0 : 2 * HOUR));
                freezeAt(sessionStart() + (status === "booked" ? 0 : 2 * HOUR));
                const res = await patch(h, id, "complete", "doctor");
                expect([status, res.status]).toEqual([status, 409]);
                expectErrorEnvelope(res.body, "InvalidTransition");
                expect((await row(id)).status).toBe(status);
            }
            expect(await h.audits("consultation.completed")).toHaveLength(0);
        });

        it("should complete after the session window closed because the doctor may overrun", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) });
            freezeAt(sessionStart() + SESSION_MS + OVERRUN_MS + 3 * HOUR);
            const res = await patch(h, id, "complete", "doctor");
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe("completed");
        });

        it.each(["completed", "no_show"])("should never change a %s consultation: join, start, complete and no-show all answer 409 InvalidTransition", async (status) => {
            const id = await seedSession(h, { status });
            freezeAt(sessionStart() + OVERRUN_MS + SESSION_MS + HOUR); // far outside the window: InvalidTransition must still win over RoomNotOpen
            const results = [await patch(h, id, "join", "patient"), await patch(h, id, "join", "doctor"), await patch(h, id, "start", "doctor"),
                await patch(h, id, "complete", "doctor"), await patch(h, id, "no-show", "doctor"), await patch(h, id, "no-show", "admin")];
            for (const res of results) { expect(res.status).toBe(409); expectErrorEnvelope(res.body, "InvalidTransition"); }
            expect((await row(id)).status).toBe(status);
            expect(await h.audits(...SESSION_AUDITS)).toHaveLength(0);
            expect(h.video.ensureCalls).toHaveLength(0);
        });

        it("should answer InvalidTransition (not RoomNotOpen) for every session action on a cancelled consultation", async () => {
            const id = await seedSession(h, { status: "cancelled", cancelled_at: new Date(), cancelled_by: "admin" });
            freezeAt(sessionStart() - 3 * HOUR);
            for (const [action, actor] of [["join", "patient"], ["join", "doctor"], ["start", "doctor"], ["complete", "doctor"], ["no-show", "admin"]] as const) {
                const res = await patch(h, id, action, actor);
                expect([action, actor, res.status]).toEqual([action, actor, 409]);
                expectErrorEnvelope(res.body, "InvalidTransition");
            }
        });

        it("should answer InvalidTransition on start of an in_progress consultation even outside the window", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) });
            freezeAt(sessionStart() + SESSION_MS + OVERRUN_MS + HOUR);
            const res = await patch(h, id, "start", "doctor");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "InvalidTransition");
        });
    });

    // ───────────────────────────────────────────── window boundaries (SS-R1, half-open)
    describe("session window", () => {
        const CASES: Array<[string, number, boolean]> = [
            ["1 ms before opensAt", -OPEN_MS - 1, false], ["exactly opensAt", -OPEN_MS, true], ["the start", 0, true],
            ["1 ms before closesAt", SESSION_MS + OVERRUN_MS - 1, true], ["exactly closesAt", SESSION_MS + OVERRUN_MS, false],
        ];

        it.each(CASES)("should %s decide join for a patient: inside=%s", async (_label, offset, inside) => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + offset);
            const res = await patch(h, id, "join", "patient");
            if (inside) {
                expect(res.status).toBe(200);
                expect(res.body.data.consultation.status).toBe("waiting");
            } else {
                expect(res.status).toBe(409);
                expectErrorEnvelope(res.body, "RoomNotOpen");
                expect(await row(id)).toMatchObject({ status: "booked", room_id: null, joined_at: null });
                expect(h.video.ensureCalls).toHaveLength(0); // SS-R10: no room for an out-of-window consultation
                expect(h.video.tokenCalls).toHaveLength(0);
                expect(await h.audits(...SESSION_AUDITS)).toHaveLength(0);
            }
        });

        it.each(CASES)("should %s decide start for the doctor: inside=%s", async (_label, offset, inside) => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + offset);
            const res = await patch(h, id, "start", "doctor");
            if (inside) {
                expect(res.status).toBe(200);
            } else {
                expect(res.status).toBe(409);
                expectErrorEnvelope(res.body, "RoomNotOpen");
                expect(await row(id)).toMatchObject({ status: "booked", room_id: null, started_at: null });
                expect(await doctorJoined(h)).toHaveLength(0);
                expect(h.video.ensureCalls).toHaveLength(0);
            }
        });

        it("should answer RoomNotOpen to a doctor join outside the window and issue no token", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart() - OPEN_MS - MINUTE);
            const res = await patch(h, id, "join", "doctor");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "RoomNotOpen");
            expect(h.video.tokenCalls).toHaveLength(0);
        });

        it("should answer RoomNotOpen on a waiting consultation re-joined after closesAt", async () => {
            const id = await seedSession(h, { status: "waiting", joined_at: new Date(sessionStart()), room_id: "fake-room-x" });
            freezeAt(sessionStart() + SESSION_MS + OVERRUN_MS);
            const res = await patch(h, id, "join", "patient");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "RoomNotOpen");
        });
    });

    // ───────────────────────────────────────────── join semantics and tokens (SS-R4, SS-R5, SS-R10, SS-R11)
    describe("join and tokens", () => {
        it("should give a doctor a token on a booked consultation without a transition or an audit row and persist the room", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart() - 2 * MINUTE);
            const res = await patch(h, id, "join", "doctor");
            expect(res.status).toBe(200);
            expect(res.body.data.consultation.status).toBe("booked");
            expect(res.body.data.consultation.joinedAt).toBeNull();
            expect(verifyFakeJoinToken(res.body.data.joinToken as string, SECRET, h.clock.now())).toMatchObject({ userId: DOCTOR, role: "doctor", roomId: `fake-room-${id}` });
            expect(await row(id)).toMatchObject({ status: "booked", room_id: `fake-room-${id}` });
            expect(await h.audits(...SESSION_AUDITS)).toHaveLength(0);
            expect(await h.outbox()).toHaveLength(0);
        });

        it("should issue a fresh token on a patient re-join of a waiting consultation with no second transition, audit row or room call", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            const first = await patch(h, id, "join", "patient");
            freezeAt(sessionStart() + 5 * MINUTE);
            const second = await patch(h, id, "join", "patient");
            expect([first.status, second.status]).toEqual([200, 200]);
            expect(second.body.data.joinToken).not.toBe(first.body.data.joinToken);
            expect(second.body.data.consultation.joinedAt).toBe(new Date(sessionStart()).toISOString()); // the original admission time stays
            expect(await h.audits("consultation.waiting")).toHaveLength(1);
            expect(h.video.ensureCalls).toHaveLength(1); // the stored room is reused
            expect(h.video.tokenCalls).toHaveLength(2);
        });

        it("should give both participants a token on an in_progress consultation, each bound to its own user and role", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()), room_id: `fake-room-stored` });
            freezeAt(sessionStart() + 10 * MINUTE);
            const patient = await patch(h, id, "join", "patient");
            const doctor = await patch(h, id, "join", "doctor");
            expect([patient.status, doctor.status]).toEqual([200, 200]);
            const now = h.clock.now();
            expect(verifyFakeJoinToken(patient.body.data.joinToken as string, SECRET, now)).toMatchObject({ userId: PATIENT, role: "patient", roomId: "fake-room-stored" });
            expect(verifyFakeJoinToken(doctor.body.data.joinToken as string, SECRET, now)).toMatchObject({ userId: DOCTOR, role: "doctor", roomId: "fake-room-stored" });
            expect(patient.body.data.joinToken).not.toBe(doctor.body.data.joinToken);
            expect(await h.audits(...SESSION_AUDITS)).toHaveLength(0);
            expect(h.video.ensureCalls).toHaveLength(0); // the stored room wins
        });

        it("should cap the token life at closesAt and otherwise at the configured TTL", async () => {
            const id = await seedSession(h);
            const closesAt = sessionStart() + SESSION_MS + OVERRUN_MS;
            freezeAt(closesAt - 60_000);
            const nearClose = await patch(h, id, "join", "patient");
            expect(nearClose.status).toBe(200);
            expect(nearClose.body.data.joinTokenExpiresAt).toBe(new Date(closesAt).toISOString());
            expect(verifyFakeJoinToken(nearClose.body.data.joinToken as string, SECRET, closesAt - 1)).toMatchObject({ expiresAtMs: closesAt });
            expect(verifyFakeJoinToken(nearClose.body.data.joinToken as string, SECRET, closesAt)).toBeUndefined();
            freezeAt(sessionStart());
            const normal = await patch(h, id, "join", "doctor");
            expect(normal.body.data.joinTokenExpiresAt).toBe(new Date(sessionStart() + TOKEN_TTL_MS).toISOString());
        });

        it("should create the room once per consultation and keep the first stored room id", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            await patch(h, id, "join", "doctor");
            await patch(h, id, "join", "patient");
            await patch(h, id, "start", "doctor");
            expect(h.video.ensureCalls).toHaveLength(1);
            expect(h.video.ensureCalls[0]).toMatchObject({ consultationId: id, startsAtMs: sessionStart(), endsAtMs: sessionStart() + SESSION_MS });
            expect((await row(id)).room_id).toBe(`fake-room-${id}`);
        });

        it("should not let a token from one participant verify as the other or under another key", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            const patient = await patch(h, id, "join", "patient");
            const claims = verifyFakeJoinToken(patient.body.data.joinToken as string, SECRET, h.clock.now());
            expect(claims).toMatchObject({ userId: PATIENT, role: "patient" });
            expect(claims).not.toMatchObject({ userId: DOCTOR });
            expect(verifyFakeJoinToken(patient.body.data.joinToken as string, `${SECRET}x`, h.clock.now())).toBeUndefined();
        });

        it("should answer 429 on the eleventh join or start in a minute without spending the write bucket of complete", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) });
            freezeAt(sessionStart() + MINUTE);
            const statuses: number[] = [];
            for (let i = 0; i < 11; i += 1) statuses.push((await patch(h, id, "join", "doctor")).status);
            expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
            expect(statuses[10]).toBe(429);
            const complete = await patch(h, id, "complete", "doctor");
            expect(complete.status).toBe(200); // its own bucket is untouched
        });
    });

    // ───────────────────────────────────────────── no-show (SS-R9)
    describe("no-show", () => {
        it("should refuse a no-show 1 ms before start plus grace and allow it exactly at start plus grace, for the doctor", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + GRACE_MS - 1);
            const early = await patch(h, id, "no-show", "doctor");
            expect(early.status).toBe(409);
            expectErrorEnvelope(early.body, "NoShowTooEarly");
            expect(await row(id)).toMatchObject({ status: "booked", no_show_marked_at: null });
            freezeAt(sessionStart() + GRACE_MS);
            const ok = await patch(h, id, "no-show", "doctor");
            expect(ok.status).toBe(200);
            expect(ok.body.data.status).toBe("no_show");
            expect(ok.body.data).not.toHaveProperty("complaintText");
            expect((await row(id)).no_show_marked_at).toEqual(new Date(sessionStart() + GRACE_MS));
            expect((await h.audits("consultation.no_show"))[0]).toMatchObject({ actor_role: "doctor", actor_user_id: DOCTOR, entity_id: id });
        });

        it("should let an admin mark a waiting consultation no-show after the grace and audit only the note length", async () => {
            const id = await seedSession(h, { status: "waiting", joined_at: new Date(sessionStart()), room_id: "fake-room-w" });
            freezeAt(sessionStart() + GRACE_MS + HOUR);
            const early = await h.call("patch", `/api/consultations/${id}/no-show`, "admin", { note: NOTE });
            expect(early.status).toBe(200);
            expect(early.body.data.status).toBe("no_show");
            expect(early.body.data.timezone).toBe("UTC"); // an admin viewer is rendered in UTC
            const [audit] = await h.audits("consultation.no_show");
            expect(audit).toMatchObject({ actor_role: "admin", actor_user_id: 303, entity_id: id });
            expect(audit?.metadata).toEqual({ byRole: "admin", fromStatus: "waiting", noteLength: NOTE.length });
            // The note is neither echoed nor stored anywhere: not in the response, the audit row, the outbox or the consultation row.
            const everything = JSON.stringify([early.body, await h.audits(...SESSION_AUDITS), await h.outbox(), await h.consultationRows()]);
            expect(everything).not.toContain(NOTE);
        });

        it.each([["an absent body", undefined], ["an empty object", {}], ["a blank note", { note: "   " }]])("should accept %s and audit no noteLength", async (_label, body) => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + GRACE_MS);
            const res = await h.call("patch", `/api/consultations/${id}/no-show`, "doctor", body);
            expect(res.status).toBe(200);
            expect((await h.audits("consultation.no_show"))[0]?.metadata).toEqual({ byRole: "doctor", fromStatus: "booked" });
        });

        it.each([["an unknown property", { note: "x", other: 1 }], ["a note over 1000 characters", { note: "x".repeat(1001) }], ["a NUL character", { note: "a\u0000b" }], ["a non-string note", { note: 5 }]])(
            "should answer 400 ValidationFailed for %s and change nothing", async (_label, body) => {
                const id = await seedSession(h);
                freezeAt(sessionStart() + GRACE_MS);
                const res = await h.call("patch", `/api/consultations/${id}/no-show`, "doctor", body);
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect((await row(id)).status).toBe("booked");
            });

        it.each([["join", "patient"], ["start", "doctor"], ["complete", "doctor"]] as const)(
            "should answer 400 ValidationFailed for malformed JSON on %s from the global body parser and change nothing", async (action, actor) => {
                const id = await seedSession(h);
                freezeAt(sessionStart());
                const res = await h.call("patch", `/api/consultations/${id}/${action}`, actor, undefined, { "Content-Type": "application/json" }).send("{oops");
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect((await row(id)).status).toBe("booked");
            });

        it("should accept a note of exactly 1000 characters", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + GRACE_MS);
            const res = await h.call("patch", `/api/consultations/${id}/no-show`, "doctor", { note: "x".repeat(1000) });
            expect(res.status).toBe(200);
            expect((await h.audits("consultation.no_show"))[0]?.metadata).toMatchObject({ noteLength: 1000 });
        });

        it("should answer InvalidTransition for an in_progress consultation even before the grace elapsed", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) });
            freezeAt(sessionStart() + MINUTE);
            const res = await patch(h, id, "no-show", "admin");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "InvalidTransition");
        });

        it("should release the doctor's interval so an overlapping consultation can be inserted afterwards", async () => {
            const id = await seedSession(h);
            const overlapping = (): Promise<unknown> => seedSession(h, { patient_user_id: OTHER_PATIENT }, sessionStart() + 10 * MINUTE);
            await expect(overlapping()).rejects.toMatchObject({ code: "23P01" }); // control: the booked row holds the interval
            freezeAt(sessionStart() + GRACE_MS);
            expect((await patch(h, id, "no-show", "doctor")).status).toBe(200);
            await expect(overlapping()).resolves.toEqual(expect.any(Number));
        });

        it("should answer 404 NotFound for an admin no-show of an unknown id and a non-numeric id", async () => {
            for (const id of ["999999", "abc"]) {
                const res = await patch(h, id, "no-show", "admin");
                expect([id, res.status]).toEqual([id, 404]);
                expectErrorEnvelope(res.body, "NotFound");
            }
        });
    });

    // ───────────────────────────────────────────── concurrency (SS-R2)
    describe("concurrency", () => {
        const statusesOf = (results: Array<{ status: number }>): number[] => results.map((res) => res.status).sort();

        it("should let exactly one of two simultaneous starts win with one doctor_joined row and one audit row", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            const results = await Promise.all([patch(h, id, "start", "doctor"), patch(h, id, "start", "doctor")]);
            expect(statusesOf(results)).toEqual([200, 409]);
            expectErrorEnvelope(results.find((res) => res.status === 409)?.body, "InvalidTransition");
            expect(await doctorJoined(h)).toHaveLength(1);
            expect(await h.audits("consultation.started")).toHaveLength(1);
            expect((await row(id)).status).toBe("in_progress");
        });

        it("should let exactly one of two simultaneous completes win", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) });
            freezeAt(sessionStart() + 10 * MINUTE);
            const results = await Promise.all([patch(h, id, "complete", "doctor"), patch(h, id, "complete", "doctor")]);
            expect(statusesOf(results)).toEqual([200, 409]);
            expect(await h.audits("consultation.completed")).toHaveLength(1);
        });

        it("should let exactly one of a doctor and an admin racing a no-show win", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart() + GRACE_MS);
            const results = await Promise.all([patch(h, id, "no-show", "doctor"), patch(h, id, "no-show", "admin")]);
            expect(statusesOf(results)).toEqual([200, 409]);
            expect(await h.audits("consultation.no_show")).toHaveLength(1);
            expect((await row(id)).status).toBe("no_show");
        });

        it("should admit the patient once when two joins race and answer both with a token", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            const results = await Promise.all([patch(h, id, "join", "patient"), patch(h, id, "join", "patient")]);
            expect(statusesOf(results)).toEqual([200, 200]);
            expect(await h.audits("consultation.waiting")).toHaveLength(1);
            expect((await row(id)).status).toBe("waiting");
        });

        it("should let exactly one of a doctor start and an admin cancel win, leaving a row consistent with the winner", async () => {
            const outcomes = new Set<string>();
            for (let round = 0; round < 6; round += 1) {
                const startMs = sessionStart() + round * 2 * HOUR;
                const id = await seedSession(h, {}, startMs);
                freezeAt(startMs);
                const [start, cancel] = await Promise.all([patch(h, id, "start", "doctor"), h.cancel(id, "admin", { reason: REASON })]);
                expect([start.status, cancel.status].sort()).toEqual([200, 409]);
                const loser = start.status === 409 ? start : cancel;
                expectErrorEnvelope(loser.body, "InvalidTransition");
                const final = await row(id);
                if (start.status === 200) {
                    expect(final).toMatchObject({ status: "in_progress", cancelled_at: null });
                    expect((await doctorJoined(h)).filter((entry) => entry.consultation_id === id)).toHaveLength(1);
                } else {
                    expect(final).toMatchObject({ status: "cancelled", started_at: null });
                    expect((await doctorJoined(h)).filter((entry) => entry.consultation_id === id)).toHaveLength(0);
                }
                outcomes.add(final.status as string);
            }
            expect([...outcomes].every((status) => status === "in_progress" || status === "cancelled")).toBe(true);
        });

        it("should re-validate the window under the lock when a join races an admin reschedule", async () => {
            for (let round = 0; round < 4; round += 1) {
                const startMs = sessionStart() + round * 3 * HOUR;
                const id = await seedSession(h, {}, startMs);
                freezeAt(startMs - MINUTE);
                const target = localStart(5, "11:00");
                const [join, move] = await Promise.all([patch(h, id, "join", "patient"), h.reschedule(id, "admin", { startsAt: target, reason: REASON })]);
                const final = await row(id);
                if (join.status === 200) {
                    // Admitted first: the row is waiting at its original time and the move could not apply.
                    expect(move.status).not.toBe(200);
                    expect(final).toMatchObject({ status: "waiting" });
                    expect(final.starts_at).toEqual(new Date(startMs));
                } else {
                    // Moved first: the join saw the new, out-of-window start under the lock.
                    expect(join.status).toBe(409);
                    expectErrorEnvelope(join.body, "RoomNotOpen");
                    expect(move.status).toBe(200);
                    expect(final).toMatchObject({ status: "booked", joined_at: null });
                    expect(final.starts_at).toEqual(new Date(target));
                }
            }
        });
    });

    // ───────────────────────────────────────────── video provider outages (SS-R12)
    describe("video provider outage", () => {
        it("should answer 503 VideoUnavailable and change nothing when room creation fails on a patient join", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.failEnsure = true;
            const res = await patch(h, id, "join", "patient");
            expect(res.status).toBe(503);
            expectErrorEnvelope(res.body, "VideoUnavailable");
            expect(await row(id)).toMatchObject({ status: "booked", room_id: null, joined_at: null });
            expect(await h.audits(...SESSION_AUDITS)).toHaveLength(0);
            // Recovered provider: the same call now succeeds.
            h.video.failEnsure = false;
            expect((await patch(h, id, "join", "patient")).status).toBe(200);
        });

        it("should answer 503 and queue no doctor_joined notice when room creation fails on start", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.failEnsure = true;
            const res = await patch(h, id, "start", "doctor");
            expect(res.status).toBe(503);
            expectErrorEnvelope(res.body, "VideoUnavailable");
            expect(await row(id)).toMatchObject({ status: "booked", started_at: null });
            expect(await doctorJoined(h)).toHaveLength(0);
            expect(await h.audits("consultation.started")).toHaveLength(0);
        });

        it("should keep the patient waiting when token issue fails after commit and answer 200 on the repeat join without a second audit row", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.failIssue = true;
            const res = await patch(h, id, "join", "patient");
            expect(res.status).toBe(503);
            expectErrorEnvelope(res.body, "VideoUnavailable");
            expect(await row(id)).toMatchObject({ status: "waiting", room_id: `fake-room-${id}` });
            expect(await h.audits("consultation.waiting")).toHaveLength(1);
            h.video.failIssue = false;
            const again = await patch(h, id, "join", "patient");
            expect(again.status).toBe(200);
            expect(verifyFakeJoinToken(again.body.data.joinToken as string, SECRET, h.clock.now())).toMatchObject({ userId: PATIENT });
            expect(await h.audits("consultation.waiting")).toHaveLength(1);
        });

        it("should keep the consultation in_progress with the notice queued when token issue fails after start, and let the doctor repair it with join", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.failIssue = true;
            const res = await patch(h, id, "start", "doctor");
            expect(res.status).toBe(503);
            expectErrorEnvelope(res.body, "VideoUnavailable");
            expect(await row(id)).toMatchObject({ status: "in_progress" });
            expect(await doctorJoined(h)).toHaveLength(1);
            h.video.failIssue = false;
            const repair = await patch(h, id, "join", "doctor");
            expect(repair.status).toBe(200);
            expect(repair.body.data.consultation.status).toBe("in_progress");
            expect(await doctorJoined(h)).toHaveLength(1);
        });

        it("should answer 503 for a failing token issue on a token-only doctor join and not persist a transition", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.failIssue = true;
            const res = await patch(h, id, "join", "doctor");
            expect(res.status).toBe(503);
            expect((await row(id)).status).toBe("booked");
        });

        it("should bound a slow provider at about 2 s: 503, state unchanged", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.delayMs = 3500;
            const began = Date.now();
            const res = await patch(h, id, "join", "patient");
            const elapsed = Date.now() - began;
            expect(res.status).toBe(503);
            expectErrorEnvelope(res.body, "VideoUnavailable");
            expect(elapsed).toBeGreaterThanOrEqual(1800);
            expect(elapsed).toBeLessThan(3400);
            expect(await row(id)).toMatchObject({ status: "booked", room_id: null });
            h.video.delayMs = 0;
        });

        it("should answer 503 for a slow token issue after commit while the committed state stays valid", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            // First call (ensureRoom) is fast; slow down only the token step.
            const original = h.video.issueJoinToken.bind(h.video);
            h.video.issueJoinToken = async (input) => { await new Promise((resolve) => setTimeout(resolve, 3500)); return original(input); };
            try {
                const res = await patch(h, id, "join", "patient");
                expect(res.status).toBe(503);
                expectErrorEnvelope(res.body, "VideoUnavailable");
                expect((await row(id)).status).toBe("waiting");
            } finally {
                h.video.issueJoinToken = original;
            }
        });

        it("should not answer 5xx other than 503 and keep the error envelope free of provider details", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            h.video.failEnsure = true;
            const res = await patch(h, id, "join", "patient");
            expect(JSON.stringify(res.body)).not.toMatch(/stub_ensure_failed|video_provider_error/);
            expect(Object.keys(res.body.error).sort()).toEqual(["code", "details", "message", "requestId"]);
        });
    });

    // ───────────────────────────────────────────── response hygiene
    describe("responses", () => {
        it("should send Cache-Control no-store and carry the request id on every session response", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            const requestId = crypto.randomUUID();
            const responses = [
                await h.call("patch", `/api/consultations/${id}/join`, "patient", undefined, { "X-Request-Id": requestId }),
                await h.call("patch", `/api/consultations/${id}/start`, "doctor"),
                await h.call("get", "/api/consultations/waiting-room", "doctor"),
                await h.call("get", `/api/consultations/calendar?from=${encodeURIComponent(new Date(sessionStart() - HOUR).toISOString())}&to=${encodeURIComponent(new Date(sessionStart() + HOUR).toISOString())}`, "doctor"),
                await patch(h, id, "complete", "doctor"),
                await patch(h, id, "join", "admin"), // an error response too
            ];
            for (const res of responses) expect(res.headers["cache-control"]).toBe("no-store");
            expect(responses[0]?.headers["x-request-id"]).toBe(requestId);
        });

        it("should never put the join token, room id or note in the audit rows, the outbox, or any Redis key or string value", async () => {
            const id = await seedSession(h);
            freezeAt(sessionStart());
            const join = await patch(h, id, "join", "patient");
            const start = await patch(h, id, "start", "doctor");
            freezeAt(sessionStart() + 5 * MINUTE);
            await patch(h, id, "complete", "doctor");
            const secrets = [join.body.data.joinToken as string, start.body.data.joinToken as string, `fake-room-${id}`, COMPLAINT];
            const stored = JSON.stringify([await h.audits(...SESSION_AUDITS), await h.outbox()]);
            for (const secret of secrets) expect(stored).not.toContain(secret);
            const redisDump: string[] = [];
            let cursor = "0";
            do {
                const [next, keys] = await redis.scan(cursor, "COUNT", 500);
                cursor = next;
                for (const key of keys) {
                    redisDump.push(key);
                    if ((await redis.type(key)) === "string") redisDump.push((await redis.get(key)) ?? "");
                }
            } while (cursor !== "0");
            for (const secret of secrets) expect(redisDump.join("\n")).not.toContain(secret);
        });
    });
});
