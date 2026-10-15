import "reflect-metadata";
import type { Knex } from "knex";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import { ConsultationStatus } from "../../../../src/app/consultations/enums";
import * as repo from "../../../../src/app/consultations/repository/consultations.repo";
import { ConsultationsService } from "../../../../src/app/consultations/service/consultations.service";
import type { BookInput } from "../../../../src/app/consultations/types";
import type { ConsultationType } from "../../../../src/app/schedules/entity/consultation-type.entity";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { Env } from "../../../../src/lib/config/types";
import type { Logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";
import type { OpenDay } from "../../../../src/pkg/slots/types";

const NOW = Date.parse("2030-01-01T08:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const otherPatient: AuthContext = { userId: 102, role: "patient", status: "active", emailVerified: true };
const doctor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
const otherDoctor: AuthContext = { userId: 204, role: "doctor", status: "active", emailVerified: true };
const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };
const REASON = "SYNTHETIC-REASON-4417";
const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";

const pgError = (code: string, constraint: string): Error => Object.assign(new Error("pg"), { code, constraint });
const exclusion = (): Error => pgError("23P01", "excl_consultations_doctor_no_overlap");
const uniqueKey = (): Error => pgError("23505", "uq_consultations_idempotency");

function consultation(changes: Partial<Consultation> = {}): Consultation {
    return new Consultation({
        id: 7, doctorUserId: 202, patientUserId: 101, consultationTypeId: 3, consultationTypeName: "Synthetic Visit",
        startsAt: new Date(NOW + 3 * DAY), endsAt: new Date(NOW + 3 * DAY + 30 * MINUTE), status: ConsultationStatus.Booked,
        complaintText: COMPLAINT, patientTimezone: "UTC", price: 15000, currency: "EGP", needsAdminFollowup: false, followupReason: null,
        idempotencyKey: "11111111-1111-4111-8111-111111111111", requestHash: "a".repeat(64), ...changes,
    });
}
const openDay = (startIso: string, endIso: string): OpenDay[] => [{ date: "2030-01-04", intervals: [{ startMs: Date.parse(startIso), endMs: Date.parse(endIso) }] }];
const type = (changes: Partial<ConsultationType> = {}): ConsultationType => ({ id: 3, name: "Synthetic Visit", durationMinutes: 30, price: 15000, currency: "EGP", ...changes }) as ConsultationType;
const bookInput = (changes: Partial<BookInput> = {}): BookInput => ({
    doctorId: 202, typeId: 3, startsAtMs: NOW + 3 * DAY, complaintText: COMPLAINT, patientTimezone: "america/new_york", ...changes,
});

/** Day with hours 06:00-14:00 UTC on the start date: 09:00 is a 30-minute grid point of the default fixtures. */
const WORKDAY = openDay("2030-01-04T06:00:00Z", "2030-01-04T14:00:00Z");

function setup(env: Partial<Env> = {}) {
    const events: string[] = [];
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => {
        const result = await callback(trx); events.push("commit"); return result;
    });
    const db = { id: "db", transaction } as unknown as Knex;
    const record = jest.fn().mockResolvedValue(undefined);
    const logError = jest.fn();
    const logger = { error: logError, warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const clock = { now: jest.fn(() => NOW) };
    const doctors = { lockBookingTarget: jest.fn().mockResolvedValue({ profileId: 9, userId: 202, timezone: "UTC", isBookable: true }) };
    const schedules = { findBookableType: jest.fn().mockResolvedValue(type()), resolveOpenDays: jest.fn().mockResolvedValue(WORKDAY) };
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const listener = { onConsultationChanged: jest.fn().mockImplementation(() => { events.push("listener"); return Promise.resolve(); }) };
    const service = new ConsultationsService(db, { record } as unknown as AuditRecorder,
        { BOOKING_HORIZON_DAYS: 60, CANCELLATION_POLICY_MINUTES: 120, ...env } as Env, logger, clock,
        doctors as never, schedules as never, { enqueue }, listener);
    const mocks = {
        findById: jest.spyOn(repo, "findById").mockResolvedValue(consultation()),
        findForUpdate: jest.spyOn(repo, "findByIdForUpdate").mockResolvedValue(consultation()),
        findByKey: jest.spyOn(repo, "findByIdempotencyKey").mockResolvedValue(undefined),
        insert: jest.spyOn(repo, "insertConsultation").mockImplementation((input) => Promise.resolve(consultation({
            doctorUserId: input.doctorUserId, patientUserId: input.patientUserId, startsAt: input.startsAt, endsAt: input.endsAt, price: input.price,
            currency: input.currency, patientTimezone: input.patientTimezone, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash }))),
        reschedule: jest.spyOn(repo, "rescheduleRow").mockImplementation((_row, startsAt, endsAt) => Promise.resolve(consultation({ startsAt, endsAt }))),
        transition: jest.spyOn(repo, "applyTransition").mockImplementation((row, _from, to) => Promise.resolve(consultation({ ...row, status: to }))),
    };
    return { service, db, transaction, trx, events, record, logger, logError, clock, doctors, schedules, enqueue, listener, mocks };
}

afterEach(() => { jest.restoreAllMocks(); });

describe("ConsultationsService.book", () => {
    it("should reject followUpOfRecordId before any database access", async () => {
        const { service, transaction } = setup();
        await expect(service.book(patient, bookInput({ followUpOfRecordId: 5 }), "k", "h")).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "followUpOfRecordId" }] });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should replay the stored consultation without any later check, write or listener call when the key and body match", async () => {
        const { service, mocks, doctors, enqueue, record, listener } = setup();
        mocks.findByKey.mockResolvedValue(consultation({ requestHash: "h1" }));
        const result = await service.book(patient, bookInput(), "key", "h1");
        expect(result.id).toBe(7);
        expect(mocks.findByKey).toHaveBeenCalledWith(101, "key", expect.anything());
        expect(doctors.lockBookingTarget).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(listener.onConsultationChanged).not.toHaveBeenCalled();
    });

    it("should throw IdempotencyConflict when the stored row has another request hash", async () => {
        const { service, mocks, doctors } = setup();
        mocks.findByKey.mockResolvedValue(consultation({ requestHash: "other" }));
        await expect(service.book(patient, bookInput(), "key", "h1")).rejects.toMatchObject({ code: "IdempotencyConflict", status: 422 });
        expect(doctors.lockBookingTarget).not.toHaveBeenCalled();
    });

    it("should check in order: profile, bookable, type, past, horizon, grid, then insert", async () => {
        const order: string[] = [];
        const { service, doctors, schedules, mocks } = setup();
        doctors.lockBookingTarget.mockImplementation(() => { order.push("profile"); return Promise.resolve({ profileId: 9, userId: 202, timezone: "UTC", isBookable: true }); });
        schedules.findBookableType.mockImplementation(() => { order.push("type"); return Promise.resolve(type()); });
        schedules.resolveOpenDays.mockImplementation(() => { order.push("grid"); return Promise.resolve(WORKDAY); });
        mocks.insert.mockImplementation(() => { order.push("insert"); return Promise.resolve(consultation()); });
        await service.book(patient, bookInput(), "k", "h");
        expect(order).toEqual(["profile", "type", "grid", "insert"]);
    });

    it("should throw NotFound for an unknown doctor before looking at the type", async () => {
        const { service, doctors, schedules } = setup();
        doctors.lockBookingTarget.mockResolvedValue(undefined);
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toMatchObject({ code: "NotFound", status: 404 });
        expect(schedules.findBookableType).not.toHaveBeenCalled();
    });

    it("should throw DoctorNotBookable before the type is read when the locked doctor is not bookable (suspended, unsynced, not accepting)", async () => {
        const { service, doctors, schedules } = setup();
        doctors.lockBookingTarget.mockResolvedValue({ profileId: 9, userId: 202, timezone: "UTC", isBookable: false });
        await expect(service.book(patient, bookInput({ startsAtMs: NOW - DAY }), "k", "h")).rejects.toMatchObject({ code: "DoctorNotBookable", status: 409 });
        expect(schedules.findBookableType).not.toHaveBeenCalled();
    });

    it("should throw NotFound for an unknown or inactive type before the time checks", async () => {
        const { service, schedules } = setup();
        schedules.findBookableType.mockResolvedValue(undefined);
        await expect(service.book(patient, bookInput({ startsAtMs: NOW - DAY }), "k", "h")).rejects.toMatchObject({ code: "NotFound" });
        expect(schedules.resolveOpenDays).not.toHaveBeenCalled();
    });

    it("should throw BookingInPast for a start at or before now and accept one millisecond later", async () => {
        const { service, schedules } = setup();
        schedules.resolveOpenDays.mockResolvedValue(openDay("2030-01-01T06:00:00Z", "2030-01-01T14:00:00Z"));
        for (const startsAtMs of [NOW, NOW - 1, NOW - DAY]) {
            await expect(service.book(patient, bookInput({ startsAtMs }), "k", "h")).rejects.toMatchObject({ code: "BookingInPast", status: 422 });
        }
        expect(schedules.resolveOpenDays).not.toHaveBeenCalled();
    });

    it("should allow a start exactly at the horizon and throw BeyondBookingHorizon one millisecond later", async () => {
        const { service, schedules } = setup({ BOOKING_HORIZON_DAYS: 10 });
        const horizon = NOW + 10 * DAY;
        schedules.resolveOpenDays.mockResolvedValue([{ date: "2030-01-11", intervals: [{ startMs: horizon, endMs: horizon + HOUR }] }]);
        await expect(service.book(patient, bookInput({ startsAtMs: horizon + 1 }), "k", "h")).rejects.toMatchObject({ code: "BeyondBookingHorizon", status: 422 });
        expect(schedules.resolveOpenDays).not.toHaveBeenCalled();
        await expect(service.book(patient, bookInput({ startsAtMs: horizon }), "k", "h")).resolves.toBeInstanceOf(Consultation);
    });

    it("should throw OutsideWorkingHours without inserting when the start is off the grid or outside every interval", async () => {
        const { service, mocks, schedules } = setup();
        await expect(service.book(patient, bookInput({ startsAtMs: NOW + 3 * DAY + 15 * MINUTE }), "k", "h")).rejects.toMatchObject({ code: "OutsideWorkingHours", status: 422 });
        schedules.resolveOpenDays.mockResolvedValue([]);
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toMatchObject({ code: "OutsideWorkingHours" });
        expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("should derive endsAt, price, currency and zone from the type and the server, enqueue two messages, audit and notify after commit", async () => {
        const { service, mocks, enqueue, record, listener, events, trx, schedules } = setup();
        schedules.findBookableType.mockResolvedValue(type({ durationMinutes: 45, price: 9900, currency: "USD" }));
        schedules.resolveOpenDays.mockResolvedValue(openDay("2030-01-04T08:00:00Z", "2030-01-04T14:00:00Z"));
        // The interval opens at 08:00 UTC and the type lasts 45 minutes: 09:00 is 60 minutes in (off grid), 08:45 is one step in.
        await expect(service.book(patient, bookInput({ startsAtMs: NOW + 3 * DAY + HOUR }), "k", "h")).rejects.toMatchObject({ code: "OutsideWorkingHours" });
        const onGrid = NOW + 3 * DAY + 45 * MINUTE;
        const result = await service.book(patient, bookInput({ startsAtMs: onGrid }), "key", "hash");
        const [inserted] = mocks.insert.mock.calls[0] ?? [];
        expect(inserted).toMatchObject({ doctorUserId: 202, patientUserId: 101, consultationTypeId: 3, price: 9900, currency: "USD",
            patientTimezone: "America/New_York", idempotencyKey: "key", requestHash: "hash" });
        expect((inserted?.endsAt.getTime() ?? 0) - (inserted?.startsAt.getTime() ?? 0)).toBe(45 * MINUTE);
        expect(mocks.insert.mock.calls[0]?.[1]).toBe(trx);
        expect(enqueue).toHaveBeenCalledTimes(1);
        const messages = enqueue.mock.calls[0]?.[1] as Array<{ kind: string; recipientUserId: number; payload: Record<string, unknown> }>;
        expect(messages.map((m) => [m.kind, m.recipientUserId])).toEqual([["booking_confirmed", 101], ["booking_confirmed", 202]]);
        expect(JSON.stringify(messages)).not.toContain(COMPLAINT);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "consultation.booked", entityType: "consultation", entityId: 7,
            actor: { kind: "user", userId: 101, role: "patient" } }));
        expect(JSON.stringify(record.mock.calls)).not.toContain(COMPLAINT);
        expect(listener.onConsultationChanged).toHaveBeenCalledWith({ kind: "booked", doctorUserId: 202, consultationId: 7 });
        expect(events).toEqual(["commit", "listener"]);
        expect(result.patientUserId).toBe(101);
    });

    it("should take patient_user_id from the actor and never from the input", async () => {
        const { service, mocks } = setup();
        await service.book(otherPatient, { ...bookInput(), patientUserId: 101 } as BookInput, "k", "h");
        expect(mocks.insert.mock.calls[0]?.[0].patientUserId).toBe(102);
    });

    it("should map an exclusion violation to SlotUnavailable and not notify the listener", async () => {
        const { service, mocks, listener } = setup();
        mocks.insert.mockRejectedValue(exclusion());
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toMatchObject({ code: "SlotUnavailable", status: 409 });
        expect(listener.onConsultationChanged).not.toHaveBeenCalled();
    });

    it("should rethrow an exclusion violation of another constraint and unknown errors unchanged", async () => {
        const { service, mocks } = setup();
        const other = pgError("23P01", "excl_something_else");
        mocks.insert.mockRejectedValue(other);
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toBe(other);
        const unknown = new Error("boom");
        mocks.insert.mockRejectedValue(unknown);
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toBe(unknown);
    });

    it("should answer from the row a concurrent request with the same key wrote (23505 on the key constraint)", async () => {
        const { service, mocks, db, listener } = setup();
        mocks.insert.mockRejectedValue(uniqueKey());
        mocks.findByKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce(consultation({ id: 55, requestHash: "h" }));
        const result = await service.book(patient, bookInput(), "k", "h");
        expect(result.id).toBe(55);
        expect(mocks.findByKey).toHaveBeenLastCalledWith(101, "k", db);
        expect(listener.onConsultationChanged).not.toHaveBeenCalled();
    });

    it("should throw IdempotencyConflict when the racing row has another body, and Conflict when it cannot be found", async () => {
        const { service, mocks } = setup();
        mocks.insert.mockRejectedValue(uniqueKey());
        mocks.findByKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce(consultation({ requestHash: "other" }));
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toMatchObject({ code: "IdempotencyConflict" });
        mocks.findByKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
        await expect(service.book(patient, bookInput(), "k", "h")).rejects.toMatchObject({ code: "Conflict", status: 409 });
    });

    it("should not fail the committed booking when the change listener throws, and log without data", async () => {
        const { service, listener, logError } = setup();
        listener.onConsultationChanged.mockRejectedValue(new Error(COMPLAINT));
        await expect(service.book(patient, bookInput(), "k", "h")).resolves.toBeInstanceOf(Consultation);
        expect(logError).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logError.mock.calls)).not.toContain(COMPLAINT);
    });
});

describe("ConsultationsService.reschedule", () => {
    const NEW_START = NOW + 4 * DAY;
    const newDay = openDay("2030-01-05T06:00:00Z", "2030-01-05T14:00:00Z");

    it("should require a non-blank reason from an admin before any database access", async () => {
        const { service, transaction } = setup();
        for (const reason of [undefined, "", "   "]) {
            await expect(service.reschedule(admin, 7, { startsAtMs: NEW_START, reason })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "reason" }] });
        }
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should throw NotFound for an absent row, a doctor and a patient who is not the owner, without taking the lock", async () => {
        const { service, mocks, doctors } = setup();
        mocks.findById.mockResolvedValueOnce(undefined);
        await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "NotFound" });
        await expect(service.reschedule(doctor, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "NotFound" });
        await expect(service.reschedule(otherPatient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "NotFound" });
        expect(doctors.lockBookingTarget).not.toHaveBeenCalled();
    });

    it("should lock the doctor profile before the consultation row", async () => {
        const { service, doctors, mocks, schedules } = setup();
        schedules.resolveOpenDays.mockResolvedValue(newDay);
        await service.reschedule(patient, 7, { startsAtMs: NEW_START });
        expect(doctors.lockBookingTarget.mock.invocationCallOrder[0]).toBeLessThan(mocks.findForUpdate.mock.invocationCallOrder[0] ?? 0);
        expect(doctors.lockBookingTarget).toHaveBeenCalledWith(202, expect.anything());
    });

    it.each([ConsultationStatus.Waiting, ConsultationStatus.InProgress, ConsultationStatus.Completed, ConsultationStatus.Cancelled, ConsultationStatus.NoShow])(
        "should throw InvalidTransition for a %s consultation", async (status) => {
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(consultation({ status }));
            await expect(service.reschedule(admin, 7, { startsAtMs: NEW_START, reason: REASON })).rejects.toMatchObject({ code: "InvalidTransition", status: 409 });
            expect(mocks.reschedule).not.toHaveBeenCalled();
        });

    describe("policy window", () => {
        it("should allow a patient at exactly 120:00 before the start", async () => {
            const { service, mocks, schedules } = setup();
            mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW + 120 * MINUTE), endsAt: new Date(NOW + 150 * MINUTE) }));
            schedules.resolveOpenDays.mockResolvedValue(newDay);
            await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).resolves.toBeInstanceOf(Consultation);
            expect(mocks.reschedule).toHaveBeenCalledTimes(1);
        });

        it("should block a patient at 119:59.999 before the start", async () => {
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW + 120 * MINUTE - 1), endsAt: new Date(NOW + 150 * MINUTE) }));
            await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "PolicyWindowViolation", status: 409 });
            expect(mocks.reschedule).not.toHaveBeenCalled();
        });

        it("should block a patient when the current start is already in the past", async () => {
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW - HOUR), endsAt: new Date(NOW - HOUR + 30 * MINUTE) }));
            await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "PolicyWindowViolation" });
        });

        it("should honour a configured policy window", async () => {
            const { service, mocks, schedules } = setup({ CANCELLATION_POLICY_MINUTES: 30 });
            schedules.resolveOpenDays.mockResolvedValue(newDay);
            mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW + 31 * MINUTE), endsAt: new Date(NOW + 61 * MINUTE) }));
            await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).resolves.toBeInstanceOf(Consultation);
        });

        it("should leave an admin unrestricted inside the window and even after the start", async () => {
            const { service, mocks, schedules } = setup();
            schedules.resolveOpenDays.mockResolvedValue(newDay);
            for (const startsAt of [new Date(NOW + MINUTE), new Date(NOW - HOUR)]) {
                mocks.findForUpdate.mockResolvedValue(consultation({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * MINUTE) }));
                await expect(service.reschedule(admin, 7, { startsAtMs: NEW_START, reason: REASON })).resolves.toBeInstanceOf(Consultation);
            }
        });
    });

    it("should return the row unchanged with no write, audit, outbox row or listener call when the start is the same", async () => {
        const { service, mocks, record, enqueue, listener, doctors } = setup();
        const row = consultation();
        mocks.findForUpdate.mockResolvedValue(row);
        doctors.lockBookingTarget.mockResolvedValue({ profileId: 9, userId: 202, timezone: "UTC", isBookable: false });
        const result = await service.reschedule(patient, 7, { startsAtMs: row.startsAt.getTime() });
        expect(result).toBe(row);
        expect(mocks.reschedule).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(listener.onConsultationChanged).not.toHaveBeenCalled();
    });

    it("should throw DoctorNotBookable, BookingInPast, BeyondBookingHorizon and OutsideWorkingHours in that order for a changed start", async () => {
        const { service, doctors, schedules, mocks } = setup();
        doctors.lockBookingTarget.mockResolvedValueOnce({ profileId: 9, userId: 202, timezone: "UTC", isBookable: false });
        await expect(service.reschedule(patient, 7, { startsAtMs: NOW - DAY })).rejects.toMatchObject({ code: "DoctorNotBookable" });
        await expect(service.reschedule(patient, 7, { startsAtMs: NOW - DAY })).rejects.toMatchObject({ code: "BookingInPast" });
        await expect(service.reschedule(patient, 7, { startsAtMs: NOW + 61 * DAY })).rejects.toMatchObject({ code: "BeyondBookingHorizon" });
        schedules.resolveOpenDays.mockResolvedValue([]);
        await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "OutsideWorkingHours" });
        expect(mocks.reschedule).not.toHaveBeenCalled();
    });

    it("should keep the stored interval length instead of the current type duration", async () => {
        const { service, mocks, schedules } = setup();
        mocks.findForUpdate.mockResolvedValue(consultation({ endsAt: new Date(NOW + 3 * DAY + 45 * MINUTE) }));
        schedules.findBookableType.mockResolvedValue(type({ durationMinutes: 30 }));
        schedules.resolveOpenDays.mockResolvedValue(openDay("2030-01-05T06:00:00Z", "2030-01-05T14:00:00Z"));
        // The interval opens at 06:00 UTC; 08:30 is on a 30 minute grid (the type) but not on the stored 45 minute grid, 08:15 is.
        await expect(service.reschedule(patient, 7, { startsAtMs: NOW + 4 * DAY + 30 * MINUTE })).rejects.toMatchObject({ code: "OutsideWorkingHours" });
        await service.reschedule(patient, 7, { startsAtMs: NOW + 4 * DAY + 15 * MINUTE });
        const [, startsAt, endsAt] = mocks.reschedule.mock.calls[0] ?? [];
        expect((endsAt?.getTime() ?? 0) - (startsAt?.getTime() ?? 0)).toBe(45 * MINUTE);
    });

    it("should throw InvalidTransition when the update touches zero rows and SlotUnavailable on an exclusion violation", async () => {
        const { service, mocks, schedules } = setup();
        schedules.resolveOpenDays.mockResolvedValue(newDay);
        mocks.reschedule.mockResolvedValueOnce(undefined);
        await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "InvalidTransition" });
        mocks.reschedule.mockRejectedValueOnce(exclusion());
        await expect(service.reschedule(patient, 7, { startsAtMs: NEW_START })).rejects.toMatchObject({ code: "SlotUnavailable" });
    });

    it("should enqueue two rescheduled messages, audit only the reason length and notify after commit", async () => {
        const { service, enqueue, record, listener, events, schedules } = setup();
        schedules.resolveOpenDays.mockResolvedValue(newDay);
        await service.reschedule(patient, 7, { startsAtMs: NEW_START, reason: REASON });
        const messages = enqueue.mock.calls[0]?.[1] as Array<{ kind: string; recipientUserId: number; payload: Record<string, unknown> }>;
        expect(messages.map((m) => [m.kind, m.recipientUserId])).toEqual([["rescheduled", 101], ["rescheduled", 202]]);
        expect(JSON.stringify(messages)).not.toContain(REASON);
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "consultation.rescheduled",
            metadata: expect.objectContaining({ byRole: "patient", reasonLength: REASON.length }) }));
        expect(JSON.stringify(record.mock.calls)).not.toContain(REASON);
        expect(listener.onConsultationChanged).toHaveBeenCalledWith({ kind: "rescheduled", doctorUserId: 202, consultationId: 7 });
        expect(events).toEqual(["commit", "listener"]);
    });
});

describe("ConsultationsService.cancel", () => {
    it("should require a non-blank reason from a doctor and an admin before any database access, and not from a patient", async () => {
        const { service, transaction } = setup();
        for (const actor of [doctor, admin]) {
            for (const reason of [undefined, "", "  \n "]) {
                await expect(service.cancel(actor, 7, { reason })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "reason" }] });
            }
        }
        expect(transaction).not.toHaveBeenCalled();
        await expect(service.cancel(patient, 7, {})).resolves.toBeInstanceOf(Consultation);
    });

    it("should throw NotFound for an absent row, another patient and a doctor who is not assigned, and let an admin through", async () => {
        const { service, mocks } = setup();
        await expect(service.cancel(otherPatient, 7, {})).rejects.toMatchObject({ code: "NotFound", status: 404 });
        await expect(service.cancel(otherDoctor, 7, { reason: REASON })).rejects.toMatchObject({ code: "NotFound" });
        mocks.findForUpdate.mockResolvedValueOnce(undefined);
        await expect(service.cancel(patient, 7, {})).rejects.toMatchObject({ code: "NotFound" });
        expect(mocks.transition).not.toHaveBeenCalled();
        await expect(service.cancel(admin, 7, { reason: REASON })).resolves.toBeInstanceOf(Consultation);
    });

    it.each([ConsultationStatus.InProgress, ConsultationStatus.Completed, ConsultationStatus.Cancelled, ConsultationStatus.NoShow])(
        "should throw InvalidTransition for a %s consultation whoever asks", async (status) => {
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(consultation({ status }));
            for (const [actor, input] of [[patient, {}], [doctor, { reason: REASON }], [admin, { reason: REASON }]] as const) {
                await expect(service.cancel(actor, 7, input)).rejects.toMatchObject({ code: "InvalidTransition", status: 409 });
            }
            expect(mocks.transition).not.toHaveBeenCalled();
        });

    it("should cancel a waiting consultation and pass only booked and waiting as the allowed source states", async () => {
        const { service, mocks } = setup();
        mocks.findForUpdate.mockResolvedValue(consultation({ status: ConsultationStatus.Waiting }));
        const result = await service.cancel(patient, 7, {});
        expect(result.status).toBe("cancelled");
        expect(mocks.transition.mock.calls[0]?.[1]).toEqual(["booked", "waiting"]);
        expect(mocks.transition.mock.calls[0]?.[2]).toBe("cancelled");
    });

    it("should allow a patient at exactly 120:00, block at 119:59.999, and leave doctor and admin unrestricted inside the window", async () => {
        const { service, mocks } = setup();
        mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW + 120 * MINUTE) }));
        await expect(service.cancel(patient, 7, {})).resolves.toBeInstanceOf(Consultation);
        mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW + 120 * MINUTE - 1) }));
        await expect(service.cancel(patient, 7, {})).rejects.toMatchObject({ code: "PolicyWindowViolation", status: 409 });
        mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW + MINUTE) }));
        await expect(service.cancel(doctor, 7, { reason: REASON })).resolves.toBeInstanceOf(Consultation);
        await expect(service.cancel(admin, 7, { reason: REASON })).resolves.toBeInstanceOf(Consultation);
        mocks.findForUpdate.mockResolvedValue(consultation({ startsAt: new Date(NOW - HOUR) }));
        await expect(service.cancel(patient, 7, {})).rejects.toMatchObject({ code: "PolicyWindowViolation" });
        await expect(service.cancel(admin, 7, { reason: REASON })).resolves.toBeInstanceOf(Consultation);
    });

    it("should throw InvalidTransition when a racing transition leaves zero rows to update", async () => {
        const { service, mocks, enqueue, record, listener } = setup();
        mocks.transition.mockResolvedValue(undefined);
        await expect(service.cancel(patient, 7, {})).rejects.toMatchObject({ code: "InvalidTransition" });
        expect(enqueue).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(listener.onConsultationChanged).not.toHaveBeenCalled();
    });

    it("should stamp the cancellation with the clock, role and user id and store a null reason when a patient gives none", async () => {
        const { service, mocks } = setup();
        await service.cancel(patient, 7, {});
        expect(mocks.transition.mock.calls[0]?.[3]).toEqual({ cancelled_at: new Date(NOW), cancelled_by: "patient", cancelled_by_user_id: 101, cancel_reason: null });
        await service.cancel(doctor, 7, { reason: REASON });
        expect(mocks.transition.mock.calls[1]?.[3]).toMatchObject({ cancelled_by: "doctor", cancelled_by_user_id: 202, cancel_reason: REASON });
    });

    it("should enqueue two cancelled messages, audit the reason length only and notify after commit", async () => {
        const { service, enqueue, record, listener, events } = setup();
        await service.cancel(doctor, 7, { reason: REASON });
        const messages = enqueue.mock.calls[0]?.[1] as Array<{ kind: string; recipientUserId: number }>;
        expect(messages.map((m) => [m.kind, m.recipientUserId])).toEqual([["cancelled", 101], ["cancelled", 202]]);
        expect(JSON.stringify(messages)).not.toContain(REASON);
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "consultation.cancelled",
            metadata: { byRole: "doctor", fromStatus: "booked", reasonLength: REASON.length } }));
        expect(JSON.stringify(record.mock.calls)).not.toContain(REASON);
        expect(listener.onConsultationChanged).toHaveBeenCalledWith({ kind: "cancelled", doctorUserId: 202, consultationId: 7 });
        expect(events).toEqual(["commit", "listener"]);
    });
});
