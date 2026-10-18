import "reflect-metadata";
import type { Knex } from "knex";
import { ConsultationResponseDto } from "../../../../src/app/consultations/dto/consultations.response.dto";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import { ConsultationStatus } from "../../../../src/app/consultations/enums";
import * as repo from "../../../../src/app/consultations/repository/consultations.repo";
import { ConsultationQueriesService } from "../../../../src/app/consultations/service/consultation-queries.service";
import type { ConsultationListQuery } from "../../../../src/app/consultations/types";
import { buildConsultationView, NO_RECORDS } from "../../../../src/app/consultations/view";
import { SessionQueriesService } from "../../../../src/app/sessions/service/session-queries.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { Env } from "../../../../src/lib/config/types";
import type { Logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";
import { fakeLogger } from "../../../helpers/fake-logger";

const NOW = Date.parse("2030-01-01T08:00:00Z");
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const doctor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };
const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const CHIEF = "SYNTHETIC-CHIEF-6601";

const row = (id: number, status: ConsultationStatus): Consultation => new Consultation({
    id, doctorUserId: 202, patientUserId: 101, consultationTypeId: 3, consultationTypeName: "Synthetic Visit", startsAt: new Date(NOW + id * 3_600_000),
    endsAt: new Date(NOW + id * 3_600_000 + 1_800_000), status, complaintText: COMPLAINT, patientTimezone: "UTC", price: 100, currency: "EGP",
    createdAt: new Date(NOW - 86_400_000), updatedAt: new Date(NOW - 3_600_000), needsAdminFollowup: false, followupReason: null, followUpOfRecordId: null,
    joinedAt: null, startedAt: null, completedAt: null, cancelledAt: null, cancelReason: null, cancelledBy: null, roomId: null,
});
const query = (): ConsultationListQuery => ({ scope: "upcoming" as never, statuses: undefined, fromMs: undefined, toMs: undefined, doctorUserId: undefined, patientUserId: undefined,
    needsAdminFollowup: undefined, timezone: undefined, cursor: undefined, limit: undefined });

describe("buildConsultationView hasRecord", () => {
    const context = { timezone: undefined, doctorTimezone: "Africa/Cairo" };
    const viewer = { userId: 101, role: "patient" as const };

    it("should default to false when no record set is supplied", () => {
        expect(buildConsultationView(row(1, ConsultationStatus.Completed), viewer, context, new Map(), false).hasRecord).toBe(false);
        expect(NO_RECORDS.size).toBe(0);
    });

    it("should be true exactly for the ids in the supplied set", () => {
        const recorded = new Set([2]);
        expect([1, 2, 3].map((id) => buildConsultationView(row(id, ConsultationStatus.Completed), viewer, context, new Map(), false, recorded).hasRecord)).toEqual([false, true, false]);
    });

    it("should emit the flag for every viewer role, admin included, and no record content in the response", () => {
        for (const role of ["patient", "doctor", "admin"] as const) {
            const asViewer = { userId: role === "doctor" ? 202 : role === "admin" ? 303 : 101, role };
            const view = buildConsultationView(row(2, ConsultationStatus.Completed), asViewer, context, new Map(), role !== "admin", new Set([2]));
            const dto = ConsultationResponseDto.from(row(2, ConsultationStatus.Completed), asViewer, view);
            expect(dto.hasRecord).toBe(true);
            expect(JSON.stringify(dto)).not.toContain(CHIEF);
        }
    });

    it("should leave the flag false for a row whose id is not in the set", () => {
        expect(buildConsultationView(row(3, ConsultationStatus.Booked), viewer, context, new Map(), false, new Set([9])).hasRecord).toBe(false);
    });
});

describe("ConsultationQueriesService hasRecord batch", () => {
    function setup() {
        const trx = { id: "trx" } as unknown as Knex.Transaction;
        const transaction = jest.fn((callback: (conn: Knex.Transaction) => Promise<unknown>) => callback(trx));
        const db = { id: "db", transaction } as unknown as Knex;
        const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;
        const records = { recordedConsultationIds: jest.fn().mockResolvedValue(new Set<number>()) };
        const service = new ConsultationQueriesService(db, { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditRecorder, { now: () => NOW }, logger,
            { getUsersBatch: jest.fn().mockResolvedValue({ users: new Map(), degraded: false }) } as never, { findTimezone: jest.fn().mockResolvedValue("Africa/Cairo") } as never, records as never);
        const mocks = { listPage: jest.spyOn(repo, "listPage").mockResolvedValue([]), findById: jest.spyOn(repo, "findById").mockResolvedValue(row(1, ConsultationStatus.Completed)) };
        return { service, db, records, mocks };
    }
    afterEach(() => { jest.restoreAllMocks(); });

    it("should ask once per page, with only the completed ids, and mark the rows the batch returns", async () => {
        const { service, records, mocks, db } = setup();
        mocks.listPage.mockResolvedValue([row(1, ConsultationStatus.Completed), row(2, ConsultationStatus.Booked), row(3, ConsultationStatus.Completed), row(4, ConsultationStatus.Cancelled)]
            .map((consultation) => ({ consultation, cursorTimestamp: "t" })));
        records.recordedConsultationIds.mockResolvedValue(new Set([3]));
        const page = await service.list(patient, query());
        expect(records.recordedConsultationIds).toHaveBeenCalledTimes(1);
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([1, 3], db);
        expect(page.items.map((item) => item.view.hasRecord)).toEqual([false, false, true, false]);
    });

    it("should pass an empty id list (which the links service answers without a query) for a page with no completed row", async () => {
        const { service, records, mocks } = setup();
        mocks.listPage.mockResolvedValue([row(1, ConsultationStatus.Booked), row(2, ConsultationStatus.Waiting), row(3, ConsultationStatus.NoShow)].map((consultation) => ({ consultation, cursorTimestamp: "t" })));
        const page = await service.list(doctor, query());
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([], expect.anything());
        expect(page.items.every((item) => !item.view.hasRecord)).toBe(true);
    });

    it("should look the flag up once for a completed row on get and mark it, for a patient and for an admin", async () => {
        const { service, records } = setup();
        records.recordedConsultationIds.mockResolvedValue(new Set([1]));
        expect((await service.get(patient, 1, undefined)).view.hasRecord).toBe(true);
        expect((await service.get(admin, 1, undefined)).view.hasRecord).toBe(true);
        expect(records.recordedConsultationIds).toHaveBeenCalledTimes(2);
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([1], expect.anything());
    });

    it("should look up nothing on get for a row that is not completed", async () => {
        const { service, records, mocks } = setup();
        mocks.findById.mockResolvedValue(row(1, ConsultationStatus.Booked));
        const result = await service.get(patient, 1, undefined);
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([], expect.anything());
        expect(result.view.hasRecord).toBe(false);
    });

    it.each([ConsultationStatus.Booked, ConsultationStatus.Cancelled])("should render a %s write response with hasRecord false and look nothing up", async (status) => {
        const { service, records } = setup();
        const result = await service.renderOwn(doctor, row(1, status));
        expect(result.view.hasRecord).toBe(false);
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([], expect.anything());
    });

    it("should report hasRecord true when a booking replay through the database idempotency path lands on a completed, recorded row (M9)", async () => {
        const { service, records } = setup();
        records.recordedConsultationIds.mockResolvedValue(new Set([1]));
        const result = await service.renderOwn(patient, row(1, ConsultationStatus.Completed));
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([1], expect.anything());
        expect(result.view.hasRecord).toBe(true);
    });

    it("should report hasRecord false for a replayed completed row that has no record yet", async () => {
        const { service, records } = setup();
        records.recordedConsultationIds.mockResolvedValue(new Set());
        expect((await service.renderOwn(patient, row(1, ConsultationStatus.Completed))).view.hasRecord).toBe(false);
    });

    it("should let a lookup failure fail the read like any database error (no degrade)", async () => {
        const { service, records, mocks } = setup();
        mocks.listPage.mockResolvedValue([{ consultation: row(1, ConsultationStatus.Completed), cursorTimestamp: "t" }]);
        records.recordedConsultationIds.mockRejectedValue(new Error("db down"));
        await expect(service.list(patient, query())).rejects.toThrow("db down");
    });
});

describe("SessionQueriesService hasRecord batch", () => {
    const ENV = { WAITING_ROOM_OPEN_MINUTES: 10, SESSION_OVERRUN_MINUTES: 15 } as Env;
    function setup() {
        const log = fakeLogger();
        const db = { id: "db" } as unknown as Knex;
        const rows = { listWaitingRoom: jest.fn().mockResolvedValue([]), listCalendar: jest.fn().mockResolvedValue([]) };
        const records = { recordedConsultationIds: jest.fn().mockResolvedValue(new Set<number>()) };
        const service = new SessionQueriesService(db, { now: () => NOW }, ENV, log.logger, { getUsersBatch: jest.fn().mockResolvedValue({ users: new Map(), degraded: false }) } as never,
            rows as never, { findTimezone: jest.fn().mockResolvedValue("Africa/Cairo") } as never,
            { listExceptionsForCalendar: jest.fn().mockResolvedValue({ timezone: "Africa/Cairo", exceptions: [] }) } as never, records as never);
        return { service, rows, records, db };
    }

    it("should batch only the completed ids of the calendar window in one call and mark the recorded rows", async () => {
        const { service, rows, records, db } = setup();
        rows.listCalendar.mockResolvedValue([row(1, ConsultationStatus.Completed), row(2, ConsultationStatus.Booked), row(3, ConsultationStatus.Completed), row(4, ConsultationStatus.NoShow)]);
        records.recordedConsultationIds.mockResolvedValue(new Set([1]));
        const result = await service.calendar(doctor, { fromMs: NOW, toMs: NOW + 86_400_000, timezone: undefined });
        expect(records.recordedConsultationIds).toHaveBeenCalledTimes(1);
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([1, 3], db);
        expect(result.items.map((item) => item.view.hasRecord)).toEqual([true, false, false, false]);
    });

    it("should pass an empty list for a calendar window without completed rows", async () => {
        const { service, rows, records } = setup();
        rows.listCalendar.mockResolvedValue([row(2, ConsultationStatus.Booked)]);
        await service.calendar(doctor, { fromMs: NOW, toMs: NOW + 86_400_000, timezone: undefined });
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([], expect.anything());
    });

    it("should hand the lookup an empty id list for the waiting room, whose rows can never be completed (so no query is issued)", async () => {
        const { service, rows, records } = setup();
        rows.listWaitingRoom.mockResolvedValue([row(1, ConsultationStatus.Booked), row(2, ConsultationStatus.Waiting)]);
        const result = await service.waitingRoom(doctor);
        expect(records.recordedConsultationIds).toHaveBeenCalledTimes(1);
        expect(records.recordedConsultationIds).toHaveBeenCalledWith([], expect.anything());
        expect(result.every((item) => !item.view.hasRecord)).toBe(true);
    });

    it("should render the own-write response with hasRecord false and no lookup", async () => {
        const { service, records } = setup();
        const result = await service.renderOwn(doctor, row(1, ConsultationStatus.Completed));
        expect(result.view.hasRecord).toBe(false);
        expect(records.recordedConsultationIds).not.toHaveBeenCalled();
    });
});
