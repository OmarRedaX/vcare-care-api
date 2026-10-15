import "reflect-metadata";
import type { Knex } from "knex";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import { ConsultationStatus } from "../../../../src/app/consultations/enums";
import { SessionQueriesService } from "../../../../src/app/sessions/service/session-queries.service";
import { ScheduleException } from "../../../../src/app/schedules/entity/schedule-exception.entity";
import type { Env } from "../../../../src/lib/config/types";
import type { AuthContext } from "../../../../src/lib/types/types";
import { fakeLogger } from "../../../helpers/fake-logger";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse("2030-01-01T10:00:00Z");
const doctor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const ENV = { WAITING_ROOM_OPEN_MINUTES: 10, SESSION_OVERRUN_MINUTES: 15 } as Env;

const row = (id: number, changes: Partial<Consultation> = {}): Consultation => new Consultation({
    id, doctorUserId: 202, patientUserId: 100 + id, consultationTypeId: 3, consultationTypeName: "Synthetic Visit", startsAt: new Date(NOW + id * 60 * MINUTE),
    endsAt: new Date(NOW + id * 60 * MINUTE + 30 * MINUTE), status: ConsultationStatus.Booked, complaintText: COMPLAINT, patientTimezone: "America/New_York",
    price: 15000, currency: "EGP", ...changes,
});

function setup() {
    const log = fakeLogger();
    const db = { id: "db" } as unknown as Knex;
    const getUsersBatch = jest.fn().mockResolvedValue({ users: new Map([[101, { displayName: "Synthetic Patient", avatarUrl: null, status: "active" }]]), degraded: false });
    const rows = { listWaitingRoom: jest.fn().mockResolvedValue([]), listCalendar: jest.fn().mockResolvedValue([]) };
    const doctors = { findTimezone: jest.fn().mockResolvedValue("Africa/Cairo") };
    const schedules = { listExceptionsForCalendar: jest.fn().mockResolvedValue({ timezone: "Africa/Cairo", exceptions: [] }) };
    const service = new SessionQueriesService(db, { now: () => NOW }, ENV, log.logger, { getUsersBatch } as never, rows as never, doctors as never, schedules as never);
    return { service, db, log, getUsersBatch, rows, doctors, schedules };
}

describe("SessionQueriesService.waitingRoom", () => {
    it("should query the caller's own rows with the configured window and render the patient hydrated, the doctor side not, without complaint text", async () => {
        const { service, rows, getUsersBatch } = setup();
        rows.listWaitingRoom.mockResolvedValue([row(1), row(2)]);
        const result = await service.waitingRoom(doctor);
        expect(rows.listWaitingRoom).toHaveBeenCalledWith({ doctorUserId: 202, nowMs: NOW, openMinutes: 10, overrunMinutes: 15, limit: 100 }, expect.anything());
        expect(getUsersBatch).toHaveBeenCalledTimes(1);
        expect(getUsersBatch.mock.calls[0]?.[0]).toEqual([101, 102]);
        expect(result[0]?.view).toMatchObject({ timezone: "Africa/Cairo", detail: false, doctor: { userId: 202, profileHydrated: false },
            patient: { userId: 101, displayName: "Synthetic Patient", profileHydrated: true } });
        expect(result[1]?.view.patient).toMatchObject({ userId: 102, displayName: null, profileHydrated: false });
    });

    it("should still return the rows, unhydrated, when Identity is down", async () => {
        const { service, rows, getUsersBatch, log } = setup();
        rows.listWaitingRoom.mockResolvedValue([row(1)]);
        getUsersBatch.mockRejectedValue(new Error("Synthetic Patient unreachable"));
        const result = await service.waitingRoom(doctor);
        expect(result).toHaveLength(1);
        expect(result[0]?.view.patient.profileHydrated).toBe(false);
        expect(log.text()).not.toContain("Synthetic Patient");
    });

    it("should not call Identity for an empty waiting room", async () => {
        const { service, getUsersBatch } = setup();
        expect(await service.waitingRoom(doctor)).toEqual([]);
        expect(getUsersBatch).not.toHaveBeenCalled();
    });
});

describe("SessionQueriesService.calendar", () => {
    const from = NOW;
    const query = (changes: Partial<{ fromMs: number; toMs: number; timezone: string | undefined }> = {}) => ({ fromMs: from, toMs: from + DAY, timezone: undefined, ...changes });

    it.each([[from], [from - 1]])("should reject a window whose end is not after its start (%i)", async (toMs) => {
        const { service, schedules, rows } = setup();
        await expect(service.calendar(doctor, query({ toMs }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "from" }] });
        expect(schedules.listExceptionsForCalendar).not.toHaveBeenCalled();
        expect(rows.listCalendar).not.toHaveBeenCalled();
    });

    it("should allow exactly seven days and reject seven days plus one millisecond", async () => {
        const { service } = setup();
        await expect(service.calendar(doctor, query({ toMs: from + 7 * DAY }))).resolves.toBeDefined();
        await expect(service.calendar(doctor, query({ toMs: from + 7 * DAY + 1 }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "to", issue: "window is at most 7 days" }] });
    });

    it("should default the render zone to the doctor's zone, honour an explicit zone, and keep exceptions keyed by the doctor-local date", async () => {
        const { service, schedules, rows, getUsersBatch } = setup();
        const exception = new ScheduleException({ id: 4, date: "2030-01-01", type: "day_off" as never, startTime: null, endTime: null, reason: null, createdAt: new Date(NOW) });
        schedules.listExceptionsForCalendar.mockResolvedValue({ timezone: "Africa/Cairo", exceptions: [exception] });
        rows.listCalendar.mockResolvedValue([row(1, { status: ConsultationStatus.Cancelled }), row(2, { status: ConsultationStatus.NoShow })]);
        const defaulted = await service.calendar(doctor, query());
        expect(defaulted.timezone).toBe("Africa/Cairo");
        expect(defaulted.exceptions).toEqual([exception]);
        expect(defaulted.items).toHaveLength(2);
        expect(defaulted.items[0]?.view.timezone).toBe("Africa/Cairo");
        const overridden = await service.calendar(doctor, query({ timezone: "America/New_York" }));
        expect(overridden.timezone).toBe("America/New_York");
        expect(overridden.items[0]?.view.timezone).toBe("America/New_York");
        expect(schedules.listExceptionsForCalendar).toHaveBeenCalledWith(202, from, from + DAY, expect.anything());
        expect(rows.listCalendar).toHaveBeenCalledWith({ doctorUserId: 202, fromMs: from, toMs: from + DAY, limit: 1000 }, expect.anything());
        expect(getUsersBatch).toHaveBeenCalledTimes(2);
    });

    it("should return rows with profileHydrated false when Identity fails", async () => {
        const { service, rows, getUsersBatch } = setup();
        rows.listCalendar.mockResolvedValue([row(1)]);
        getUsersBatch.mockRejectedValue(new Error("down"));
        const result = await service.calendar(doctor, query());
        expect(result.items[0]?.view.patient.profileHydrated).toBe(false);
    });

    it("should log a truncation with counts only when the cap is reached", async () => {
        const { service, rows, log } = setup();
        rows.listCalendar.mockResolvedValue(Array.from({ length: 1000 }, (_unused, index) => row(index + 1)));
        await service.calendar(doctor, query());
        expect(log.messages("warn")).toContain("calendar_truncated");
        expect(log.text()).not.toContain(COMPLAINT);
    });
});

describe("SessionQueriesService.renderOwn", () => {
    it("should render both participants unhydrated with no clinical detail, in the doctor's zone for a doctor", async () => {
        const { service, getUsersBatch } = setup();
        const rendered = await service.renderOwn(doctor, row(1));
        expect(rendered.view).toMatchObject({ timezone: "Africa/Cairo", detail: false, doctor: { profileHydrated: false }, patient: { profileHydrated: false } });
        expect(getUsersBatch).not.toHaveBeenCalled();
    });

    it("should render a patient in the patient's snapshot zone and an admin in UTC without a doctor lookup", async () => {
        const { service, doctors } = setup();
        expect((await service.renderOwn(patient, row(1))).view.timezone).toBe("America/New_York");
        expect((await service.renderOwn({ ...doctor, userId: 303, role: "admin" }, row(1))).view.timezone).toBe("UTC");
        expect(doctors.findTimezone).not.toHaveBeenCalled();
    });
});
