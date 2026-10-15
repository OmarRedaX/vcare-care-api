import "reflect-metadata";
import type { Knex } from "knex";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import { ConsultationStatus } from "../../../../src/app/consultations/enums";
import { SessionsService } from "../../../../src/app/sessions/service/sessions.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { Env } from "../../../../src/lib/config/types";
import { VideoProviderError } from "../../../../src/lib/video/video-error";
import type { AuthContext } from "../../../../src/lib/types/types";
import { fakeLogger } from "../../../helpers/fake-logger";

const MINUTE = 60_000;
const STARTS = Date.parse("2030-01-01T10:00:00Z");
const ENDS = STARTS + 30 * MINUTE;
const OPENS = STARTS - 10 * MINUTE;
const CLOSES = ENDS + 15 * MINUTE;
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const doctor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
const otherDoctor: AuthContext = { userId: 204, role: "doctor", status: "active", emailVerified: true };
const otherPatient: AuthContext = { userId: 102, role: "patient", status: "active", emailVerified: true };
const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };
const NOTE = "SYNTHETIC-NOTE-5521";
const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const TOKEN = "SYNTHETIC-TOKEN-9917";

function consultation(changes: Partial<Consultation> = {}): Consultation {
    return new Consultation({
        id: 7, doctorUserId: 202, patientUserId: 101, consultationTypeId: 3, consultationTypeName: "Synthetic Visit", startsAt: new Date(STARTS),
        endsAt: new Date(ENDS), status: ConsultationStatus.Booked, complaintText: COMPLAINT, patientTimezone: "UTC", price: 15000, currency: "EGP",
        roomId: null, ...changes,
    });
}

const ENV = { WAITING_ROOM_OPEN_MINUTES: 10, SESSION_OVERRUN_MINUTES: 15, NO_SHOW_GRACE_MINUTES: 10, VIDEO_JOIN_TOKEN_TTL_SECONDS: 300 } as Env;

function setup(nowMs: number = STARTS) {
    const events: string[] = [];
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => {
        events.push("begin");
        const result = await callback(trx);
        events.push("commit");
        return result;
    });
    const db = { id: "db", transaction } as unknown as Knex;
    const record = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const log = fakeLogger();
    const rows = {
        find: jest.fn().mockResolvedValue(consultation()),
        lockForUpdate: jest.fn().mockResolvedValue(consultation()),
        transition: jest.fn().mockImplementation((row: Consultation, _from: unknown, to: ConsultationStatus, changes: Record<string, unknown>) => {
            events.push("transition");
            return Promise.resolve(consultation({ ...row, status: to, roomId: (changes.room_id as string | undefined) ?? row.roomId }));
        }),
        setRoomIfAbsent: jest.fn().mockResolvedValue(true),
        notifyChanged: jest.fn().mockResolvedValue(undefined),
    };
    const video = {
        ensureRoom: jest.fn().mockImplementation((input: { consultationId: number }) => { events.push("ensureRoom"); return Promise.resolve({ roomId: `room-${input.consultationId}` }); }),
        issueJoinToken: jest.fn().mockImplementation((input: { expiresAtMs: number }) => { events.push("issueToken"); return Promise.resolve({ token: TOKEN, expiresAtMs: input.expiresAtMs }); }),
    };
    const clock = { now: jest.fn(() => nowMs) };
    const service = new SessionsService(db, { record } as unknown as AuditRecorder, ENV, log.logger, clock, rows as never, { enqueue }, video);
    return { service, transaction, trx, events, record, enqueue, log, rows, video, clock };
}

afterEach(() => { jest.useRealTimers(); });

describe("SessionsService.join", () => {
    it("should move a patient from booked to waiting, create the room before the transaction and issue the token after the commit", async () => {
        const { service, events, rows, record, video } = setup();
        const result = await service.join(patient, 7);
        expect(events).toEqual(["ensureRoom", "begin", "transition", "commit", "issueToken"]);
        expect(rows.transition).toHaveBeenCalledWith(expect.anything(), ["booked"], "waiting", { joined_at: new Date(STARTS), room_id: "room-7" }, expect.anything());
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "consultation.waiting", entityType: "consultation", entityId: 7,
            metadata: { byRole: "patient", fromStatus: "booked" } }));
        expect(video.issueJoinToken).toHaveBeenCalledWith({ roomId: "room-7", userId: 101, role: "patient", expiresAtMs: STARTS + 300_000 });
        expect(result).toMatchObject({ roomId: "room-7", joinToken: TOKEN, joinTokenExpiresAt: new Date(STARTS + 300_000),
            windowOpensAt: new Date(OPENS), windowClosesAt: new Date(CLOSES) });
        expect(result.consultation.status).toBe("waiting");
    });

    it.each([
        ["one millisecond before the window opens", OPENS - 1, "RoomNotOpen"],
        ["exactly when the window opens", OPENS, undefined],
        ["one millisecond before the window closes", CLOSES - 1, undefined],
        ["exactly when the window closes", CLOSES, "RoomNotOpen"],
    ])("should treat the window as half-open %s", async (_label, nowMs, code) => {
        const { service } = setup(nowMs);
        if (code === undefined) await expect(service.join(patient, 7)).resolves.toBeDefined();
        else await expect(service.join(patient, 7)).rejects.toMatchObject({ code });
    });

    it.each(["completed", "cancelled", "no_show"] as const)("should answer InvalidTransition, never RoomNotOpen, for a %s row outside the window", async (status) => {
        const { service, rows, video, transaction } = setup(CLOSES + 60 * MINUTE);
        rows.find.mockResolvedValue(consultation({ status: status as ConsultationStatus }));
        await expect(service.join(patient, 7)).rejects.toMatchObject({ code: "InvalidTransition" });
        expect(video.ensureRoom).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should answer NotFound for a missing row and for a user who is not a participant, before any provider call", async () => {
        const { service, rows, video } = setup();
        rows.find.mockResolvedValue(undefined);
        await expect(service.join(patient, 7)).rejects.toMatchObject({ code: "NotFound" });
        rows.find.mockResolvedValue(consultation());
        for (const actor of [otherPatient, otherDoctor, admin]) await expect(service.join(actor, 7)).rejects.toMatchObject({ code: "NotFound" });
        expect(video.ensureRoom).not.toHaveBeenCalled();
    });

    it.each(["waiting", "in_progress"] as const)("should give a patient on a %s row a fresh token without a transition, audit row or room creation", async (status) => {
        const { service, rows, record, transaction, video } = setup();
        rows.find.mockResolvedValue(consultation({ status: status as ConsultationStatus, roomId: "room-7" }));
        const result = await service.join(patient, 7);
        expect(result.joinToken).toBe(TOKEN);
        expect(transaction).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(video.ensureRoom).not.toHaveBeenCalled();
        expect(rows.setRoomIfAbsent).not.toHaveBeenCalled();
    });

    it("should give a doctor on a booked row a token without a transition or audit row and persist a room that did not exist", async () => {
        const { service, rows, record, transaction, video } = setup();
        const result = await service.join(doctor, 7);
        expect(transaction).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(rows.setRoomIfAbsent).toHaveBeenCalledWith(7, "room-7");
        expect(video.issueJoinToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 202, role: "doctor" }));
        expect(result.consultation.status).toBe("booked");
    });

    it("should use the stored room when a concurrent call persisted another one first", async () => {
        const { service, rows, video } = setup();
        rows.setRoomIfAbsent.mockResolvedValue(false);
        rows.find.mockResolvedValueOnce(consultation()).mockResolvedValueOnce(consultation({ roomId: "room-stored" }));
        const result = await service.join(doctor, 7);
        expect(result.roomId).toBe("room-stored");
        expect(video.issueJoinToken).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-stored" }));
    });

    it("should re-check the window against the locked row and not transition when a reschedule moved the start", async () => {
        const { service, rows, record, video } = setup();
        rows.lockForUpdate.mockResolvedValue(consultation({ startsAt: new Date(STARTS + 3_600_000), endsAt: new Date(ENDS + 3_600_000) }));
        await expect(service.join(patient, 7)).rejects.toMatchObject({ code: "RoomNotOpen" });
        expect(rows.transition).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(video.issueJoinToken).not.toHaveBeenCalled();
    });

    it("should answer with a token only when a concurrent join already admitted the patient", async () => {
        const { service, rows, record } = setup();
        rows.lockForUpdate.mockResolvedValue(consultation({ status: ConsultationStatus.Waiting, roomId: "room-7" }));
        const result = await service.join(patient, 7);
        expect(rows.transition).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(result.roomId).toBe("room-7");
    });

    it("should answer InvalidTransition when the guarded update touches no row", async () => {
        const { service, rows, record } = setup();
        rows.transition.mockResolvedValue(undefined);
        await expect(service.join(patient, 7)).rejects.toMatchObject({ code: "InvalidTransition" });
        expect(record).not.toHaveBeenCalled();
    });

    it("should answer VideoUnavailable and change no state when room creation fails", async () => {
        const { service, video, transaction, rows, log } = setup();
        video.ensureRoom.mockRejectedValue(new VideoProviderError("rejected"));
        await expect(service.join(patient, 7)).rejects.toMatchObject({ code: "VideoUnavailable", status: 503 });
        expect(transaction).not.toHaveBeenCalled();
        expect(rows.transition).not.toHaveBeenCalled();
        expect(log.messages("warn")).toEqual(["video_provider_failed"]);
        expect(log.text()).toContain("rejected");
    });

    it("should answer VideoUnavailable when the provider exceeds its two second bound", async () => {
        jest.useFakeTimers();
        const { service, video, transaction } = setup();
        video.ensureRoom.mockImplementation(() => new Promise(() => undefined));
        const outcome = service.join(patient, 7).then(() => "ok", (error: { code: string }) => error.code);
        await jest.advanceTimersByTimeAsync(2001);
        expect(await outcome).toBe("VideoUnavailable");
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should keep the committed waiting state and answer VideoUnavailable when token issuance fails after the commit", async () => {
        const { service, video, events, record, log } = setup();
        video.issueJoinToken.mockRejectedValue(new Error(`provider said ${TOKEN} ${NOTE}`));
        await expect(service.join(patient, 7)).rejects.toMatchObject({ code: "VideoUnavailable" });
        expect(events).toEqual(["ensureRoom", "begin", "transition", "commit"]);
        expect(video.issueJoinToken).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
        expect(log.text()).not.toContain(TOKEN);
        expect(log.text()).not.toContain(NOTE);
    });

    it("should cap the token life at the window close", async () => {
        const { service, video } = setup(CLOSES - 60_000);
        const result = await service.join(doctor, 7);
        expect(video.issueJoinToken).toHaveBeenCalledWith(expect.objectContaining({ expiresAtMs: CLOSES }));
        expect(result.joinTokenExpiresAt).toEqual(new Date(CLOSES));
    });
});

describe("SessionsService.start", () => {
    it("should move to in_progress, queue exactly one doctor_joined notice and audit in one transaction, then issue the doctor token", async () => {
        const { service, events, rows, record, enqueue, video } = setup();
        const result = await service.start(doctor, 7);
        expect(events).toEqual(["ensureRoom", "begin", "transition", "commit", "issueToken"]);
        expect(rows.transition).toHaveBeenCalledWith(expect.anything(), ["booked", "waiting"], "in_progress", { started_at: new Date(STARTS), room_id: "room-7" }, expect.anything());
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(expect.anything(), [{ kind: "doctor_joined", consultationId: 7, recipientUserId: 101,
            payload: { startsAt: new Date(STARTS).toISOString(), endsAt: new Date(ENDS).toISOString(), recipientRole: "patient" } }]);
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "consultation.started", metadata: { byRole: "doctor", fromStatus: "booked" } }));
        expect(video.issueJoinToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 202, role: "doctor" }));
        expect(result.consultation.status).toBe("in_progress");
    });

    it("should accept a waiting consultation", async () => {
        const { service, rows } = setup();
        rows.find.mockResolvedValue(consultation({ status: ConsultationStatus.Waiting, roomId: "room-7" }));
        rows.lockForUpdate.mockResolvedValue(consultation({ status: ConsultationStatus.Waiting, roomId: "room-7" }));
        await expect(service.start(doctor, 7)).resolves.toBeDefined();
    });

    it.each(["in_progress", "completed", "cancelled", "no_show"] as const)("should answer InvalidTransition for a %s row even outside the window and queue nothing", async (status) => {
        const { service, rows, enqueue, transaction, video } = setup(CLOSES + 60 * MINUTE);
        rows.find.mockResolvedValue(consultation({ status: status as ConsultationStatus }));
        await expect(service.start(doctor, 7)).rejects.toMatchObject({ code: "InvalidTransition" });
        expect(enqueue).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(video.ensureRoom).not.toHaveBeenCalled();
    });

    it.each([[OPENS - 1], [CLOSES]])("should answer RoomNotOpen outside the half-open window (%i)", async (nowMs) => {
        const { service, video } = setup(nowMs);
        await expect(service.start(doctor, 7)).rejects.toMatchObject({ code: "RoomNotOpen" });
        expect(video.ensureRoom).not.toHaveBeenCalled();
    });

    it("should answer NotFound for a doctor other than the assigned one and for a missing row", async () => {
        const { service, rows } = setup();
        await expect(service.start(otherDoctor, 7)).rejects.toMatchObject({ code: "NotFound" });
        rows.find.mockResolvedValue(undefined);
        await expect(service.start(doctor, 7)).rejects.toMatchObject({ code: "NotFound" });
    });

    it("should answer InvalidTransition and queue nothing when a concurrent start won the guarded update", async () => {
        const { service, rows, enqueue, record } = setup();
        rows.transition.mockResolvedValue(undefined);
        await expect(service.start(doctor, 7)).rejects.toMatchObject({ code: "InvalidTransition" });
        expect(enqueue).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should change no state when room creation fails", async () => {
        const { service, video, transaction } = setup();
        video.ensureRoom.mockRejectedValue(new Error("down"));
        await expect(service.start(doctor, 7)).rejects.toMatchObject({ code: "VideoUnavailable" });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should keep the committed in_progress state and the queued notice when the token cannot be issued", async () => {
        const { service, video, enqueue, record } = setup();
        video.issueJoinToken.mockRejectedValue(new Error("down"));
        await expect(service.start(doctor, 7)).rejects.toMatchObject({ code: "VideoUnavailable" });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
    });
});

describe("SessionsService.complete", () => {
    const inProgress = (): Consultation => consultation({ status: ConsultationStatus.InProgress, roomId: "room-7" });

    it("should complete an in_progress consultation long after the window closed, audit it and notify the listener after the commit", async () => {
        const { service, rows, record, events } = setup(CLOSES + 3 * 60 * MINUTE);
        rows.find.mockResolvedValue(inProgress());
        rows.lockForUpdate.mockResolvedValue(inProgress());
        rows.notifyChanged.mockImplementation(() => { events.push("listener"); return Promise.resolve(); });
        const result = await service.complete(doctor, 7);
        expect(result.status).toBe("completed");
        expect(rows.transition).toHaveBeenCalledWith(expect.anything(), ["in_progress"], "completed", { completed_at: new Date(CLOSES + 3 * 60 * MINUTE) }, expect.anything());
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "consultation.completed", metadata: { byRole: "doctor" } }));
        expect(rows.notifyChanged).toHaveBeenCalledWith("completed", expect.objectContaining({ id: 7 }));
        expect(events).toEqual(["begin", "transition", "commit", "listener"]);
    });

    it.each(["booked", "waiting", "completed", "cancelled", "no_show"] as const)("should answer InvalidTransition for a %s consultation", async (status) => {
        const { service, rows, record } = setup();
        rows.find.mockResolvedValue(consultation({ status: status as ConsultationStatus }));
        rows.lockForUpdate.mockResolvedValue(consultation({ status: status as ConsultationStatus }));
        await expect(service.complete(doctor, 7)).rejects.toMatchObject({ code: "InvalidTransition" });
        expect(record).not.toHaveBeenCalled();
        expect(rows.notifyChanged).not.toHaveBeenCalled();
    });

    it("should answer NotFound for a doctor other than the assigned one", async () => {
        const { service } = setup();
        await expect(service.complete(otherDoctor, 7)).rejects.toMatchObject({ code: "NotFound" });
    });

    it("should answer InvalidTransition when the guarded update touches no row", async () => {
        const { service, rows } = setup();
        rows.lockForUpdate.mockResolvedValue(inProgress());
        rows.transition.mockResolvedValue(undefined);
        await expect(service.complete(doctor, 7)).rejects.toMatchObject({ code: "InvalidTransition" });
    });
});

describe("SessionsService.noShow", () => {
    it.each([
        ["one millisecond before start plus grace", STARTS + 10 * MINUTE - 1, "NoShowTooEarly"],
        ["exactly at start plus grace", STARTS + 10 * MINUTE, undefined],
    ])("should enforce the grace period %s", async (_label, nowMs, code) => {
        const { service } = setup(nowMs);
        if (code === undefined) await expect(service.noShow(doctor, 7, {})).resolves.toMatchObject({ status: "no_show" });
        else await expect(service.noShow(doctor, 7, {})).rejects.toMatchObject({ code });
    });

    it("should let an admin mark a waiting consultation, audit the role and notify the listener so the interval is released", async () => {
        const { service, rows, record } = setup(STARTS + 11 * MINUTE);
        rows.find.mockResolvedValue(consultation({ status: ConsultationStatus.Waiting }));
        rows.lockForUpdate.mockResolvedValue(consultation({ status: ConsultationStatus.Waiting }));
        await service.noShow(admin, 7, {});
        expect(rows.transition).toHaveBeenCalledWith(expect.anything(), ["booked", "waiting"], "no_show", { no_show_marked_at: new Date(STARTS + 11 * MINUTE) }, expect.anything());
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "consultation.no_show", metadata: { byRole: "admin", fromStatus: "waiting" } }));
        expect(rows.notifyChanged).toHaveBeenCalledWith("no_show", expect.objectContaining({ id: 7 }));
    });

    it("should audit only the note length and never the note text, and omit it when blank", async () => {
        const { service, record } = setup(STARTS + 11 * MINUTE);
        await service.noShow(doctor, 7, { note: NOTE });
        await service.noShow(doctor, 7, { note: "   " });
        const metadata = record.mock.calls.map((call) => (call[1] as { metadata: Record<string, unknown> }).metadata);
        expect(metadata[0]).toEqual({ byRole: "doctor", fromStatus: "booked", noteLength: NOTE.length });
        expect(metadata[1]).toEqual({ byRole: "doctor", fromStatus: "booked" });
        expect(JSON.stringify(record.mock.calls)).not.toContain(NOTE);
    });

    it.each(["in_progress", "completed", "cancelled", "no_show"] as const)("should answer InvalidTransition for a %s consultation, before the grace check", async (status) => {
        const { service, rows } = setup(STARTS - 60 * MINUTE);
        rows.find.mockResolvedValue(consultation({ status: status as ConsultationStatus }));
        await expect(service.noShow(doctor, 7, {})).rejects.toMatchObject({ code: "InvalidTransition" });
    });

    it("should answer NotFound for a doctor other than the assigned one and for a missing row", async () => {
        const { service, rows } = setup(STARTS + 11 * MINUTE);
        await expect(service.noShow(otherDoctor, 7, {})).rejects.toMatchObject({ code: "NotFound" });
        rows.find.mockResolvedValue(undefined);
        await expect(service.noShow(admin, 7, {})).rejects.toMatchObject({ code: "NotFound" });
    });

    it("should re-check the grace period under the lock", async () => {
        const { service, rows, record } = setup(STARTS + 11 * MINUTE);
        rows.lockForUpdate.mockResolvedValue(consultation({ startsAt: new Date(STARTS + 3_600_000), endsAt: new Date(ENDS + 3_600_000) }));
        await expect(service.noShow(doctor, 7, {})).rejects.toMatchObject({ code: "NoShowTooEarly" });
        expect(record).not.toHaveBeenCalled();
    });
});
