import "reflect-metadata";
import type { Knex } from "knex";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import * as repo from "../../../../src/app/consultations/repository/consultations.repo";
import { ConsultationQueriesService } from "../../../../src/app/consultations/service/consultation-queries.service";
import type { ConsultationListQuery } from "../../../../src/app/consultations/types";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { Logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";

const NOW = Date.parse("2030-01-01T08:00:00Z");
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const doctor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };
const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const query = (changes: Partial<ConsultationListQuery> = {}): ConsultationListQuery => ({
    scope: "upcoming" as never, statuses: undefined, fromMs: undefined, toMs: undefined, doctorUserId: undefined, patientUserId: undefined,
    needsAdminFollowup: undefined, timezone: undefined, cursor: undefined, limit: undefined, ...changes,
});
const row = (id: number, changes: Partial<Consultation> = {}): Consultation => new Consultation({
    id, doctorUserId: 202, patientUserId: 101, consultationTypeId: 3, consultationTypeName: "Synthetic Visit", startsAt: new Date(NOW + id * 3_600_000),
    endsAt: new Date(NOW + id * 3_600_000 + 1_800_000), status: "booked" as never, complaintText: COMPLAINT, patientTimezone: "UTC", price: 100, currency: "EGP", ...changes,
});

function setup() {
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn((callback: (conn: Knex.Transaction) => Promise<unknown>) => callback(trx));
    const db = { id: "db", transaction } as unknown as Knex;
    const record = jest.fn().mockResolvedValue(undefined);
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const getUsersBatch = jest.fn().mockResolvedValue({ users: new Map(), degraded: false });
    const doctors = { findTimezone: jest.fn().mockResolvedValue("Africa/Cairo") };
    const records = { recordedConsultationIds: jest.fn().mockResolvedValue(new Set<number>()) };
    const service = new ConsultationQueriesService(db, { record } as unknown as AuditRecorder, { now: () => NOW }, logger, { getUsersBatch } as never, doctors as never, records as never);
    const mocks = {
        listPage: jest.spyOn(repo, "listPage").mockResolvedValue([]),
        findById: jest.spyOn(repo, "findById").mockResolvedValue(row(1)),
    };
    return { service, db, transaction, trx, record, logger, getUsersBatch, doctors, records, mocks };
}

afterEach(() => { jest.restoreAllMocks(); });

describe("ConsultationQueriesService.list", () => {
    it.each([{ doctorUserId: 202 }, { patientUserId: 101 }, { needsAdminFollowup: true }, { needsAdminFollowup: false }])(
        "should answer Forbidden for %j from a non-admin before any query", async (filter) => {
            const { service, mocks, doctors } = setup();
            for (const actor of [patient, doctor]) {
                await expect(service.list(actor, query(filter))).rejects.toMatchObject({ code: "Forbidden", status: 403 });
            }
            expect(mocks.listPage).not.toHaveBeenCalled();
            expect(doctors.findTimezone).not.toHaveBeenCalled();
        });

    it("should reject from >= to before any query", async () => {
        const { service, mocks } = setup();
        await expect(service.list(patient, query({ fromMs: 10, toMs: 10 }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "from" }] });
        expect(mocks.listPage).not.toHaveBeenCalled();
    });

    it("should build the participant predicate from the verified principal for each role", async () => {
        const { service, mocks } = setup();
        await service.list(patient, query());
        await service.list(doctor, query());
        await service.list(admin, query({ doctorUserId: 5, patientUserId: 6, needsAdminFollowup: true }));
        await service.list(admin, query());
        const filters = mocks.listPage.mock.calls.map(([filter]) => [filter.doctorUserId, filter.patientUserId, filter.needsAdminFollowup]);
        expect(filters).toEqual([[null, 101, null], [202, null, null], [5, 6, true], [null, null, null]]);
        expect(mocks.listPage.mock.calls[0]?.[0].now).toEqual(new Date(NOW));
    });

    it("should fetch limit plus one rows", async () => {
        const { service, mocks } = setup();
        await service.list(patient, query({ limit: 5 }));
        expect(mocks.listPage.mock.calls[0]?.[0].fetch).toBe(6);
    });

    it("should hydrate the distinct counterparts with exactly one batched Identity call per page", async () => {
        const { service, mocks, getUsersBatch } = setup();
        mocks.listPage.mockResolvedValue([1, 2, 3].map((id) => ({ consultation: row(id), cursorTimestamp: `t${id}` })));
        await service.list(patient, query());
        expect(getUsersBatch).toHaveBeenCalledTimes(1);
        expect(getUsersBatch.mock.calls[0]?.[0]).toEqual([202]);
        mocks.listPage.mockResolvedValue([row(1), row(2, { doctorUserId: 204, patientUserId: 102 })].map((consultation) => ({ consultation, cursorTimestamp: "t" })));
        await service.list(admin, query());
        expect(getUsersBatch).toHaveBeenCalledTimes(2);
        expect([...(getUsersBatch.mock.calls[1]?.[0] as number[])].sort()).toEqual([101, 102, 202, 204]);
    });

    it("should make no Identity call for an empty page", async () => {
        const { service, getUsersBatch } = setup();
        const page = await service.list(patient, query());
        expect(page.items).toEqual([]);
        expect(getUsersBatch).not.toHaveBeenCalled();
    });

    it("should serve the page with unhydrated participants and log without data when the Identity client throws", async () => {
        const { service, mocks, getUsersBatch, logger } = setup();
        mocks.listPage.mockResolvedValue([{ consultation: row(1), cursorTimestamp: "t" }]);
        getUsersBatch.mockRejectedValue(new Error(COMPLAINT));
        const page = await service.list(patient, query());
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.view.doctor).toEqual({ userId: 202, displayName: null, avatarUrl: null, profileHydrated: false });
        expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(COMPLAINT);
    });

    it("should mark a participant hydrated from the Identity result and leave the viewer's own side unhydrated", async () => {
        const { service, mocks, getUsersBatch } = setup();
        mocks.listPage.mockResolvedValue([{ consultation: row(1), cursorTimestamp: "t" }]);
        getUsersBatch.mockResolvedValue({ users: new Map([[202, { id: 202, displayName: "Dr Synthetic", avatarUrl: null, status: "active" }]]), degraded: false });
        const [item] = (await service.list(patient, query())).items;
        expect(item?.view.doctor).toMatchObject({ displayName: "Dr Synthetic", profileHydrated: true });
        expect(item?.view.patient).toMatchObject({ userId: 101, displayName: null, profileHydrated: false });
        expect(item?.view.detail).toBe(false);
    });

    it("should look up the doctor's own timezone only for a doctor viewer and canonicalise an explicit zone", async () => {
        const { service, doctors, mocks } = setup();
        mocks.listPage.mockResolvedValue([{ consultation: row(1), cursorTimestamp: "t" }]);
        await service.list(patient, query());
        expect(doctors.findTimezone).not.toHaveBeenCalled();
        const [own] = (await service.list(doctor, query())).items;
        expect(doctors.findTimezone).toHaveBeenCalledWith(202, expect.anything());
        expect(own?.view.timezone).toBe("Africa/Cairo");
        const [explicit] = (await service.list(admin, query({ timezone: "asia/tokyo" }))).items;
        expect(explicit?.view.timezone).toBe("Asia/Tokyo");
    });
});

describe("ConsultationQueriesService.get", () => {
    it("should audit a participant read in the read transaction with the viewer role only", async () => {
        const { service, record, trx, mocks, transaction } = setup();
        const result = await service.get(patient, 1, undefined);
        expect(mocks.findById).toHaveBeenCalledWith(1, trx);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "consultation.read", entityType: "consultation", entityId: 1,
            actor: { kind: "user", userId: 101, role: "patient" }, metadata: { viewerRole: "patient" } }));
        expect(JSON.stringify(record.mock.calls)).not.toContain(COMPLAINT);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(result.view.detail).toBe(true);
    });

    it("should audit the assigned doctor's read too", async () => {
        const { service, record } = setup();
        await service.get(doctor, 1, undefined);
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata: { viewerRole: "doctor" } }));
    });

    it("should answer NotFound without an audit row for a stranger, an unassigned doctor and an absent row", async () => {
        const { service, record, mocks } = setup();
        await expect(service.get({ ...patient, userId: 999 }, 1, undefined)).rejects.toMatchObject({ code: "NotFound" });
        await expect(service.get({ ...doctor, userId: 999 }, 1, undefined)).rejects.toMatchObject({ code: "NotFound" });
        mocks.findById.mockResolvedValue(undefined);
        await expect(service.get(patient, 1, undefined)).rejects.toMatchObject({ code: "NotFound" });
        expect(record).not.toHaveBeenCalled();
    });

    it("should read as an admin without a transaction or an audit row, and answer NotFound for an absent row", async () => {
        const { service, record, transaction, mocks } = setup();
        await expect(service.get(admin, 1, undefined)).resolves.toBeDefined();
        expect(record).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        mocks.findById.mockResolvedValue(undefined);
        await expect(service.get(admin, 9, undefined)).rejects.toMatchObject({ code: "NotFound" });
    });

    it("should hydrate the counterpart once and degrade to unhydrated when Identity throws", async () => {
        const { service, getUsersBatch } = setup();
        getUsersBatch.mockRejectedValue(new Error("down"));
        const result = await service.get(patient, 1, undefined);
        expect(getUsersBatch).toHaveBeenCalledTimes(1);
        expect(result.view.doctor.profileHydrated).toBe(false);
    });
});

describe("ConsultationQueriesService.renderOwn", () => {
    it("should render both participants unhydrated with detail for the actor's own write response and make no Identity call", async () => {
        const { service, getUsersBatch } = setup();
        const result = await service.renderOwn(patient, row(1));
        expect(result.view.doctor).toEqual({ userId: 202, displayName: null, avatarUrl: null, profileHydrated: false });
        expect(result.view.patient).toEqual({ userId: 101, displayName: null, avatarUrl: null, profileHydrated: false });
        expect(result.view.detail).toBe(true);
        expect(getUsersBatch).not.toHaveBeenCalled();
    });
});
