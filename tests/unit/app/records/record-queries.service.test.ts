import "reflect-metadata";
import type { Knex } from "knex";
import { PatientProfile } from "../../../../src/app/patients/entity/patient-profile.entity";
import * as amendmentsRepo from "../../../../src/app/records/repository/medical-record-amendments.repo";
import * as recordsRepo from "../../../../src/app/records/repository/medical-records.repo";
import { RecordQueriesService } from "../../../../src/app/records/service/record-queries.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import { decodeTimestampCursor, encodeCursor } from "../../../../src/lib/http/pagination/cursor";
import type { AppError } from "../../../../src/lib/error/AppError";
import { admin, amendmentEntity, CLINICAL_MARKERS, doctor, NOW, otherDoctor, otherPatient, patient, recordEntity } from "./records.fixtures";

const trx = { id: "trx", isTransaction: true } as unknown as Knex.Transaction;
const stamp = (index: number): string => new Date(NOW - index * 3_600_000).toISOString().replace("Z", "000Z");
const entry = (id: number) => ({ record: recordEntity({ id, consultationId: 100 + id }), cursorTimestamp: stamp(id) });

function setup() {
    const events: string[] = [];
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => {
        events.push("begin");
        const result = await callback(trx);
        events.push("commit");
        return result;
    });
    const db = { id: "db", transaction } as unknown as Knex;
    const record = jest.fn().mockImplementation(() => { events.push("audit"); return Promise.resolve(); });
    const patients = { findProfile: jest.fn().mockImplementation(() => { events.push("profile"); return Promise.resolve(undefined); }) };
    const service = new RecordQueriesService(db, { record } as unknown as AuditRecorder, patients as never);
    const mocks = {
        findById: jest.spyOn(recordsRepo, "findById").mockImplementation(() => { events.push("record"); return Promise.resolve(recordEntity()); }),
        listTimeline: jest.spyOn(recordsRepo, "listTimeline").mockImplementation(() => { events.push("page"); return Promise.resolve([]); }),
        amendments: jest.spyOn(amendmentsRepo, "listByRecordIds").mockImplementation(() => { events.push("amendments"); return Promise.resolve(new Map()); }),
    };
    return { service, transaction, events, record, patients, mocks };
}

afterEach(() => { jest.restoreAllMocks(); });

const rejection = async (run: () => Promise<unknown>): Promise<AppError> => {
    try { await run(); } catch (error) { return error as AppError; }
    throw new Error("expected a rejection");
};

describe("RecordQueriesService.get", () => {
    it("should read the record and its amendments, then write the record.read audit row as the last statement before the commit", async () => {
        const { service, events, record, mocks } = setup();
        mocks.amendments.mockImplementation(() => { events.push("amendments"); return Promise.resolve(new Map([[9, [amendmentEntity({ id: 1 }), amendmentEntity({ id: 2 })]]])); });
        const result = await service.get(doctor, 9);
        expect(result.record.id).toBe(9);
        expect(result.amendments.map((amendment) => amendment.id)).toEqual([1, 2]);
        expect(events).toEqual(["begin", "record", "amendments", "audit", "commit"]);
        expect(mocks.findById).toHaveBeenCalledWith(9, trx);
        expect(mocks.amendments).toHaveBeenCalledWith([9], trx);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "record.read", entityType: "medical_record", entityId: 9,
            metadata: { consultationId: 7, patientUserId: 101, viewerRole: "doctor", viewerIsAuthor: true, amendmentCount: 2 } });
    });

    it("should mark a consulted doctor who is not the author and a patient in the audit metadata", async () => {
        const { service, record } = setup();
        await service.get(otherDoctor, 9);
        await service.get(patient, 9);
        expect(record.mock.calls.map(([, audit]) => [audit.metadata.viewerRole, audit.metadata.viewerIsAuthor, audit.metadata.amendmentCount])).toEqual([["doctor", false, 0], ["patient", false, 0]]);
    });

    it("should keep every clinical string out of the audit entry", async () => {
        const { service, record, mocks } = setup();
        mocks.amendments.mockResolvedValue(new Map([[9, [amendmentEntity()]]]));
        await service.get(doctor, 9);
        for (const marker of CLINICAL_MARKERS) expect(JSON.stringify(record.mock.calls)).not.toContain(marker);
    });

    it("should answer NotFound and write no audit row when the record is absent", async () => {
        const { service, record, mocks } = setup();
        mocks.findById.mockResolvedValue(undefined);
        expect((await rejection(() => service.get(doctor, 9))).code).toBe("NotFound");
        expect(record).not.toHaveBeenCalled();
        expect(mocks.amendments).not.toHaveBeenCalled();
    });

    it("should answer NotFound, with no amendment read and no audit row, for a patient who is not the record's patient", async () => {
        const { service, record, mocks } = setup();
        expect((await rejection(() => service.get(otherPatient, 9))).code).toBe("NotFound");
        expect(mocks.amendments).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should refuse an admin actor before any database access", async () => {
        const { service, transaction, mocks, record } = setup();
        const err = await rejection(() => service.get(admin, 9));
        expect([err.code, err.status]).toEqual(["Forbidden", 403]);
        expect(transaction).not.toHaveBeenCalled();
        expect(mocks.findById).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should fail the read, return nothing and never commit when the audit insert fails", async () => {
        const { service, record, events } = setup();
        const failure = new Error("audit unavailable");
        record.mockRejectedValue(failure);
        await expect(service.get(doctor, 9)).rejects.toBe(failure);
        expect(events).toEqual(["begin", "record", "amendments"]);
    });
});

describe("RecordQueriesService.timeline", () => {
    it("should refuse an admin actor and hide another patient's timeline before any database access", async () => {
        const { service, transaction } = setup();
        expect((await rejection(() => service.timeline(admin, 101, { cursor: undefined, limit: undefined }))).code).toBe("Forbidden");
        expect((await rejection(() => service.timeline(otherPatient, 101, { cursor: undefined, limit: undefined }))).code).toBe("NotFound");
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should answer ValidationFailed on the cursor field before the transaction opens when the cursor is malformed", async () => {
        const { service, transaction, mocks } = setup();
        for (const cursor of ["not-a-cursor", encodeCursor("2030-01-01T00:00:00Z", 5), encodeCursor("2030-01-01T00:00:00.123456Z", 0), Buffer.from("[1]").toString("base64url")]) {
            const err = await rejection(() => service.timeline(patient, 101, { cursor, limit: undefined }));
            expect([err.code, err.details]).toEqual(["ValidationFailed", [{ field: "cursor", issue: "is invalid" }]]);
        }
        expect(transaction).not.toHaveBeenCalled();
        expect(mocks.listTimeline).not.toHaveBeenCalled();
    });

    it("should fetch limit plus one rows, default 20, and decode the cursor into the keyset position", async () => {
        const { service, mocks } = setup();
        await service.timeline(patient, 101, { cursor: undefined, limit: undefined });
        await service.timeline(patient, 101, { cursor: undefined, limit: 5 });
        const cursor = encodeCursor("2030-01-01T09:00:00.123456Z", 77);
        await service.timeline(doctor, 101, { cursor, limit: 3 });
        expect(mocks.listTimeline.mock.calls.map(([filter]) => [filter.patientUserId, filter.fetch, filter.after])).toEqual([
            [101, 21, null], [101, 6, null], [101, 4, decodeTimestampCursor(cursor)],
        ]);
        expect(mocks.listTimeline.mock.calls.every(([, conn]) => conn === trx)).toBe(true);
    });

    it("should build the page: hasMore, count and a nextCursor at the last returned row, and drop the probe row", async () => {
        const { service, mocks } = setup();
        mocks.listTimeline.mockResolvedValue([entry(30), entry(20), entry(10)]);
        const result = await service.timeline(doctor, 101, { cursor: undefined, limit: 2 });
        expect(result.items.map((item) => item.record.id)).toEqual([30, 20]);
        expect(result.meta).toEqual({ nextCursor: encodeCursor(stamp(20), 20), hasMore: true, count: 2 });
        expect(decodeTimestampCursor(result.meta.nextCursor ?? "")).toEqual({ sortValue: stamp(20), id: 20 });
    });

    it("should report the last page with no cursor and hasMore false when the rows fit exactly", async () => {
        const { service, mocks } = setup();
        mocks.listTimeline.mockResolvedValue([entry(30), entry(20)]);
        const result = await service.timeline(doctor, 101, { cursor: undefined, limit: 2 });
        expect(result.meta).toEqual({ nextCursor: null, hasMore: false, count: 2 });
    });

    it("should load the amendments of exactly the returned records in ONE call and group them in order under their record", async () => {
        const { service, mocks } = setup();
        mocks.listTimeline.mockResolvedValue([entry(30), entry(20), entry(10)]);
        mocks.amendments.mockResolvedValue(new Map([[30, [amendmentEntity({ id: 1, recordId: 30 }), amendmentEntity({ id: 2, recordId: 30 })]], [10, [amendmentEntity({ id: 3, recordId: 10 })]]]));
        const result = await service.timeline(doctor, 101, { cursor: undefined, limit: 2 });
        expect(mocks.amendments).toHaveBeenCalledTimes(1);
        expect(mocks.amendments).toHaveBeenCalledWith([30, 20], trx);
        expect(result.items.map((item) => item.amendments.map((amendment) => amendment.id))).toEqual([[1, 2], []]);
    });

    it("should return patient undefined-as-null when the patient has no profile and the profile otherwise", async () => {
        const { service, patients } = setup();
        expect((await service.timeline(doctor, 101, { cursor: undefined, limit: undefined })).patient).toBeNull();
        const profile = new PatientProfile({ id: 4, userId: 101, timezone: "UTC" });
        patients.findProfile.mockResolvedValue(profile);
        expect((await service.timeline(doctor, 101, { cursor: undefined, limit: undefined })).patient).toBe(profile);
        expect(patients.findProfile).toHaveBeenCalledWith(101, trx);
    });

    it("should read the profile once on every page, including a continuation page", async () => {
        const { service, patients } = setup();
        await service.timeline(doctor, 101, { cursor: undefined, limit: undefined });
        await service.timeline(doctor, 101, { cursor: encodeCursor(stamp(3), 3), limit: undefined });
        expect(patients.findProfile).toHaveBeenCalledTimes(2);
    });

    it("should write exactly one patient_records.listed audit row per call, after the reads and inside the transaction, with counts and no clinical text", async () => {
        const { service, mocks, record, events } = setup();
        mocks.listTimeline.mockImplementation(() => { events.push("page"); return Promise.resolve([entry(30), entry(20), entry(10)]); });
        mocks.amendments.mockImplementation(() => { events.push("amendments"); return Promise.resolve(new Map([[30, [amendmentEntity({ recordId: 30 })]]])); });
        await service.timeline(doctor, 101, { cursor: undefined, limit: 2 });
        expect(events).toEqual(["begin", "page", "amendments", "profile", "audit", "commit"]);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "patient_records.listed", entityType: "patient_records", entityId: 101,
            metadata: { patientUserId: 101, viewerRole: "doctor", recordCount: 2, hasMore: true, firstPage: true } });
        for (const marker of CLINICAL_MARKERS) expect(JSON.stringify(record.mock.calls)).not.toContain(marker);
    });

    it("should flag a continuation page as not the first page", async () => {
        const { service, record } = setup();
        await service.timeline(patient, 101, { cursor: encodeCursor(stamp(3), 3), limit: undefined });
        expect(record.mock.calls[0]?.[1].metadata).toMatchObject({ firstPage: false, viewerRole: "patient" });
    });

    it("should audit an empty page too, with a zero count, and still read the profile", async () => {
        const { service, record, patients } = setup();
        const result = await service.timeline(patient, 101, { cursor: undefined, limit: undefined });
        expect(result.items).toEqual([]);
        expect(result.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        expect(record).toHaveBeenCalledTimes(1);
        expect(record.mock.calls[0]?.[1].metadata).toMatchObject({ recordCount: 0, hasMore: false });
        expect(patients.findProfile).toHaveBeenCalledTimes(1);
    });

    it("should fail the read, return nothing and never commit when the audit insert fails", async () => {
        const { service, record, events } = setup();
        const failure = new Error("audit unavailable");
        record.mockRejectedValue(failure);
        await expect(service.timeline(doctor, 101, { cursor: undefined, limit: undefined })).rejects.toBe(failure);
        expect(events).not.toContain("commit");
    });
});

describe("medical-record-amendments repository", () => {
    it("should issue no query for an empty id list and return an empty map", async () => {
        const conn = jest.fn(() => { throw new Error("must not be queried"); }) as unknown as Knex;
        expect((await amendmentsRepo.listByRecordIds([], conn)).size).toBe(0);
        expect(conn).not.toHaveBeenCalled();
    });
});
