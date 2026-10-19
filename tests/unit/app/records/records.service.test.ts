import "reflect-metadata";
import type { Knex } from "knex";
import { ConsultationStatus } from "../../../../src/app/consultations/enums";
import type { RecordAttachmentSummary } from "../../../../src/app/record-attachments/types";
import * as amendmentsRepo from "../../../../src/app/records/repository/medical-record-amendments.repo";
import * as recordsRepo from "../../../../src/app/records/repository/medical-records.repo";
import { RecordsService } from "../../../../src/app/records/service/records.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { AppError } from "../../../../src/lib/error/AppError";
import { amendmentEntity, CHIEF, CLINICAL_MARKERS, doctor, DX_TEXT, NOTES, otherDoctor, pgError, PLAN, REASON, recordEntity } from "./records.fixtures";

const trx = { id: "trx", isTransaction: true } as unknown as Knex.Transaction;
const parties = (changes: Record<string, unknown> = {}) => ({ id: 7, doctorUserId: 202, patientUserId: 101, status: ConsultationStatus.Completed, ...changes });

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
    const rows = { findParties: jest.fn().mockResolvedValue(parties()) };
    const attachmentLinks = { listByRecordIds: jest.fn().mockImplementation(() => { events.push("attachments"); return Promise.resolve(new Map<number, RecordAttachmentSummary[]>()); }) };
    const service = new RecordsService(db, { record } as unknown as AuditRecorder, rows as never, attachmentLinks as never);
    const mocks = {
        findLive: jest.spyOn(recordsRepo, "findLiveIdByConsultationId").mockResolvedValue(undefined),
        insert: jest.spyOn(recordsRepo, "insertRecord").mockImplementation((input) => { events.push("insert"); return Promise.resolve(recordEntity({
            id: 9, consultationId: input.consultationId, patientUserId: input.patientUserId, doctorUserId: input.doctorUserId, chiefComplaint: input.input.chiefComplaint })); }),
        findForUpdate: jest.spyOn(recordsRepo, "findByIdForNoKeyUpdate").mockResolvedValue(recordEntity()),
        update: jest.spyOn(recordsRepo, "updateRecordFields").mockImplementation((id, columns) => { events.push("update"); return Promise.resolve(recordEntity({ id, chiefComplaint: columns.chief_complaint ?? CHIEF })); }),
        amend: jest.spyOn(amendmentsRepo, "insertAmendment").mockImplementation(() => { events.push("amend"); return Promise.resolve(amendmentEntity({ id: 31 })); }),
    };
    return { service, transaction, events, record, rows, mocks, attachmentLinks };
}

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

const codeOf = async (run: () => Promise<unknown>): Promise<AppError> => {
    try { await run(); } catch (error) { return error as AppError; }
    throw new Error("expected a rejection");
};

describe("RecordsService.create (the creation gate)", () => {
    it("should insert for the assigned doctor on a completed consultation, copy both user ids from the consultation and audit in the same transaction", async () => {
        const { service, events, record, mocks, transaction } = setup();
        const result = await service.create(doctor, 7, { chiefComplaint: CHIEF, examinationNotes: NOTES, followUpInDays: 3 });
        expect(result.id).toBe(9);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(events).toEqual(["begin", "insert", "audit", "commit"]);
        expect(mocks.insert).toHaveBeenCalledWith({ consultationId: 7, patientUserId: 101, doctorUserId: 202,
            input: { chiefComplaint: CHIEF, examinationNotes: NOTES, followUpInDays: 3 } }, trx);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "record.created", entityType: "medical_record", entityId: 9,
            metadata: { consultationId: 7, patientUserId: 101, doctorUserId: 202, providedFields: "chiefComplaint,examinationNotes,followUpInDays" } });
    });

    it("should take the patient and doctor ids from the consultation even when the input smuggles other ids", async () => {
        const { service, mocks } = setup();
        await service.create(doctor, 7, { chiefComplaint: CHIEF, patientUserId: 999, doctorUserId: 998 } as never);
        expect(mocks.insert.mock.calls[0]?.[0]).toMatchObject({ patientUserId: 101, doctorUserId: 202, consultationId: 7 });
    });

    it("should keep every clinical string out of the audit entry", async () => {
        const { service, record } = setup();
        await service.create(doctor, 7, { chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisText: DX_TEXT, diagnosisCode: "A00.1", treatmentPlan: PLAN, followUpInDays: 5 });
        const logged = JSON.stringify(record.mock.calls);
        for (const marker of CLINICAL_MARKERS) expect(logged).not.toContain(marker);
        expect(logged).not.toContain("A00.1");
        expect(record.mock.calls[0]?.[1].metadata.providedFields).toBe("chiefComplaint,examinationNotes,diagnosisText,diagnosisCode,treatmentPlan,followUpInDays");
    });

    it("should answer NotFound first, before any other check, when the consultation row is gone", async () => {
        const { service, rows, mocks, record } = setup();
        rows.findParties.mockResolvedValue(undefined);
        expect((await codeOf(() => service.create(doctor, 7, { chiefComplaint: CHIEF }))).code).toBe("NotFound");
        expect(mocks.findLive).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should read the consultation inside the transaction with the transaction handle", async () => {
        const { service, rows } = setup();
        await service.create(doctor, 7, { chiefComplaint: CHIEF });
        expect(rows.findParties).toHaveBeenCalledWith(7, trx);
    });

    it.each(["booked", "completed", "cancelled"] as const)("should answer NotFound, never NotAssignedDoctor and never the status error, to a doctor who is not the assigned one on a %s consultation (M1 defence in depth)", async (status) => {
        const { service, rows, mocks, record } = setup();
        rows.findParties.mockResolvedValue(parties({ status }));
        const err = await codeOf(() => service.create(otherDoctor, 7, { chiefComplaint: CHIEF }));
        expect([err.code, err.status]).toEqual(["NotFound", 404]);
        expect(mocks.findLive).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it.each(["booked", "waiting", "in_progress", "cancelled", "no_show"] as const)("should answer RecordRequiresCompleted for a %s consultation and write nothing", async (status) => {
        const { service, rows, mocks, record } = setup();
        rows.findParties.mockResolvedValue(parties({ status }));
        const err = await codeOf(() => service.create(doctor, 7, { chiefComplaint: CHIEF }));
        expect([err.code, err.status]).toEqual(["RecordRequiresCompleted", 409]);
        expect(mocks.findLive).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should answer RecordRequiresCompleted before Conflict when a not-completed row already has a record id", async () => {
        const { service, rows, mocks } = setup();
        rows.findParties.mockResolvedValue(parties({ status: ConsultationStatus.Booked }));
        mocks.findLive.mockResolvedValue(5);
        expect((await codeOf(() => service.create(doctor, 7, { chiefComplaint: CHIEF }))).code).toBe("RecordRequiresCompleted");
    });

    it("should answer Conflict from the courtesy pre-check when a live record exists and write nothing", async () => {
        const { service, mocks, record } = setup();
        mocks.findLive.mockResolvedValue(5);
        const err = await codeOf(() => service.create(doctor, 7, { chiefComplaint: CHIEF }));
        expect([err.code, err.status]).toEqual(["Conflict", 409]);
        expect(mocks.findLive).toHaveBeenCalledWith(7, trx);
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should map the unique violation on uq_medical_records_consultation_id to Conflict (the concurrent loser)", async () => {
        const { service, record } = setup();
        jest.spyOn(recordsRepo, "insertRecord").mockRejectedValue(pgError("23505", "uq_medical_records_consultation_id"));
        const err = await codeOf(() => service.create(doctor, 7, { chiefComplaint: CHIEF }));
        expect([err.code, err.status]).toEqual(["Conflict", 409]);
        expect(record).not.toHaveBeenCalled();
    });

    it("should rethrow a unique violation on any other constraint and any non-database error", async () => {
        const { service } = setup();
        const other = pgError("23505", "uq_something_else");
        jest.spyOn(recordsRepo, "insertRecord").mockRejectedValue(other);
        await expect(service.create(doctor, 7, { chiefComplaint: CHIEF })).rejects.toBe(other);
        const boom = new Error("connection reset");
        jest.spyOn(recordsRepo, "insertRecord").mockRejectedValue(boom);
        await expect(service.create(doctor, 7, { chiefComplaint: CHIEF })).rejects.toBe(boom);
    });

    it("should fail the create and never commit when the audit insert fails", async () => {
        const { service, events, record } = setup();
        const failure = new Error("audit unavailable");
        record.mockImplementation(() => { events.push("audit"); return Promise.reject(failure); });
        await expect(service.create(doctor, 7, { chiefComplaint: CHIEF })).rejects.toBe(failure);
        expect(events).toEqual(["begin", "insert", "audit"]);
    });

    it("should run the transaction in Knex's handler form (no hand-rolled commit or rollback)", async () => {
        const { service, transaction } = setup();
        await service.create(doctor, 7, { chiefComplaint: CHIEF });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(typeof transaction.mock.calls[0]?.[0]).toBe("function");
    });
});

describe("RecordsService.update", () => {
    it("should answer NotFound when the record is gone", async () => {
        const { service, mocks, record } = setup();
        mocks.findForUpdate.mockResolvedValue(undefined);
        expect((await codeOf(() => service.update(doctor, 9, { changes: { treatmentPlan: PLAN } }))).code).toBe("NotFound");
        expect(record).not.toHaveBeenCalled();
    });

    it("should lock the record row FOR NO KEY UPDATE through the transaction handle", async () => {
        const { service, mocks } = setup();
        await service.update(doctor, 9, { changes: { treatmentPlan: PLAN } });
        expect(mocks.findForUpdate).toHaveBeenCalledWith(9, trx);
    });

    it("should answer NotAssignedDoctor for a doctor who is not the author before it looks at the lock or the reason", async () => {
        const { service, mocks, record } = setup();
        mocks.findForUpdate.mockResolvedValue(recordEntity({ isLocked: true }));
        const err = await codeOf(() => service.update(otherDoctor, 9, { changes: { treatmentPlan: PLAN } }));
        expect([err.code, err.status]).toEqual(["NotAssignedDoctor", 403]);
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.amend).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    describe("before the lock", () => {
        it("should update in place, audit record.updated with the changed field names and return the updated record", async () => {
            const { service, mocks, record, events } = setup();
            const result = await service.update(doctor, 9, { changes: { treatmentPlan: PLAN, followUpInDays: 7 } });
            expect(result.kind).toBe("updated");
            expect(mocks.update).toHaveBeenCalledWith(9, { treatment_plan: PLAN, follow_up_in_days: 7 }, trx);
            expect(mocks.amend).not.toHaveBeenCalled();
            expect(events).toEqual(["begin", "update", "attachments", "audit", "commit"]);
            expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "record.updated", entityType: "medical_record", entityId: 9,
                metadata: { consultationId: 7, patientUserId: 101, changedFields: "treatmentPlan,followUpInDays" } });
            expect(JSON.stringify(record.mock.calls)).not.toContain(PLAN);
        });

        it("should return unchanged with no record write and exactly one record.read audit row when every provided value equals the stored one (R-D7 as amended by M3)", async () => {
            const { service, mocks, record, events } = setup();
            const result = await service.update(doctor, 9, { changes: { chiefComplaint: CHIEF, examinationNotes: NOTES } });
            expect(result.kind).toBe("unchanged");
            expect(result.kind === "unchanged" && result.record.id).toBe(9);
            expect(mocks.update).not.toHaveBeenCalled();
            expect(mocks.amend).not.toHaveBeenCalled();
            expect(events).toEqual(["begin", "attachments", "audit", "commit"]);
            expect(record).toHaveBeenCalledTimes(1);
            expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "record.read", entityType: "medical_record", entityId: 9,
                metadata: { consultationId: 7, patientUserId: 101, viewerRole: "doctor", viaNoopPatch: true } });
            const logged = JSON.stringify(record.mock.calls);
            for (const marker of CLINICAL_MARKERS) expect(logged).not.toContain(marker);
        });

        it("should return the live attachment metadata of the record on the in-place and the no-op result, read once in the transaction", async () => {
            const { service, attachmentLinks } = setup();
            const attachment: RecordAttachmentSummary = { id: 4, recordId: 9, fileType: "image/png", sizeBytes: 3, attachmentDescription: null, createdAt: new Date(0) };
            attachmentLinks.listByRecordIds.mockResolvedValue(new Map([[9, [attachment]]]));
            const updated = await service.update(doctor, 9, { changes: { treatmentPlan: PLAN } });
            const unchanged = await service.update(doctor, 9, { changes: { chiefComplaint: CHIEF } });
            expect([updated.kind, updated.kind === "updated" && updated.attachments]).toEqual(["updated", [attachment]]);
            expect([unchanged.kind, unchanged.kind === "unchanged" && unchanged.attachments]).toEqual(["unchanged", [attachment]]);
            expect(attachmentLinks.listByRecordIds).toHaveBeenCalledTimes(2);
            expect(attachmentLinks.listByRecordIds).toHaveBeenCalledWith([9], trx);
        });

        it("should write only the field that differs when one value is equal and one is different", async () => {
            const { service, mocks, record } = setup();
            await service.update(doctor, 9, { changes: { chiefComplaint: CHIEF, treatmentPlan: PLAN } });
            expect(mocks.update).toHaveBeenCalledWith(9, { treatment_plan: PLAN }, trx);
            expect(record.mock.calls[0]?.[1].metadata.changedFields).toBe("treatmentPlan");
        });

        it("should ignore a reason before the lock: it is not written and not audited", async () => {
            const { service, mocks, record } = setup();
            await service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON });
            expect(mocks.update).toHaveBeenCalledWith(9, { treatment_plan: PLAN }, trx);
            expect(mocks.amend).not.toHaveBeenCalled();
            expect(JSON.stringify(record.mock.calls)).not.toContain(REASON);
            expect(record.mock.calls[0]?.[1].metadata).not.toHaveProperty("reasonLength");
        });

        it("should treat a reason-only difference as no change: an equal value with a reason is still a no-op", async () => {
            const { service, mocks, record } = setup();
            const result = await service.update(doctor, 9, { changes: { chiefComplaint: CHIEF }, reason: REASON });
            expect(result.kind).toBe("unchanged");
            expect(mocks.update).not.toHaveBeenCalled();
            expect(record.mock.calls.map((call) => call[1].action)).toEqual(["record.read"]);
            expect(JSON.stringify(record.mock.calls)).not.toContain(REASON);
        });
    });

    describe("after the lock", () => {
        const locked = () => recordEntity({ isLocked: true, lockedAt: new Date(0) });

        it("should append an amendment with only the provided fields, never touch the original, and audit record.amended with ids, names and the reason length", async () => {
            const { service, mocks, record, events } = setup();
            mocks.findForUpdate.mockResolvedValue(locked());
            const result = await service.update(doctor, 9, { changes: { diagnosisText: DX_TEXT, followUpInDays: 10 }, reason: REASON });
            expect(result.kind).toBe("amended");
            expect(mocks.amend).toHaveBeenCalledWith({ recordId: 9, authorUserId: 202, changes: { diagnosisText: DX_TEXT, followUpInDays: 10 }, reason: REASON }, trx);
            expect(mocks.update).not.toHaveBeenCalled();
            expect(events).toEqual(["begin", "amend", "audit", "commit"]);
            expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "record.amended", entityType: "medical_record", entityId: 9,
                metadata: { consultationId: 7, patientUserId: 101, amendmentId: 31, changedFields: "diagnosisText,followUpInDays", reasonLength: [...REASON].length } });
            const logged = JSON.stringify(record.mock.calls);
            for (const marker of CLINICAL_MARKERS) expect(logged).not.toContain(marker);
        });

        it("should not read the attachments on the amendment path (its 201 carries the amendment only)", async () => {
            const { service, mocks, attachmentLinks } = setup();
            mocks.findForUpdate.mockResolvedValue(locked());
            await service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON });
            expect(attachmentLinks.listByRecordIds).not.toHaveBeenCalled();
        });

        it("should count the reason length in code points", async () => {
            const { service, mocks, record } = setup();
            mocks.findForUpdate.mockResolvedValue(locked());
            await service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: "\u{1F600}\u{1F600}\u{1F600}" });
            expect(record.mock.calls[0]?.[1].metadata.reasonLength).toBe(3);
        });

        it("should answer ValidationFailed on the reason field and write nothing when the reason is missing", async () => {
            const { service, mocks, record } = setup();
            mocks.findForUpdate.mockResolvedValue(locked());
            const err = await codeOf(() => service.update(doctor, 9, { changes: { treatmentPlan: PLAN } }));
            expect([err.code, err.status, err.details]).toEqual(["ValidationFailed", 400, [{ field: "reason", issue: "is required after the record is locked" }]]);
            expect(mocks.amend).not.toHaveBeenCalled();
            expect(mocks.update).not.toHaveBeenCalled();
            expect(record).not.toHaveBeenCalled();
        });

        it("should still append an amendment when the value equals the stored one (no diff after the lock, R-D7)", async () => {
            const { service, mocks, record } = setup();
            mocks.findForUpdate.mockResolvedValue(locked());
            const result = await service.update(doctor, 9, { changes: { chiefComplaint: CHIEF }, reason: REASON });
            expect(result.kind).toBe("amended");
            expect(mocks.amend).toHaveBeenCalledTimes(1);
            expect(record).toHaveBeenCalledTimes(1);
        });

        it("should fail the amendment and never commit when the audit insert fails", async () => {
            const { service, mocks, record, events } = setup();
            mocks.findForUpdate.mockResolvedValue(locked());
            const failure = new Error("audit unavailable");
            record.mockRejectedValue(failure);
            await expect(service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON })).rejects.toBe(failure);
            expect(events).toEqual(["begin", "amend"]);
        });
    });

    describe("lock decision (the database clock, never Node's)", () => {
        it("should update in place when the row says unlocked even though Node's clock is far past the lock", async () => {
            jest.useFakeTimers({ now: Date.parse("2099-01-01T00:00:00Z") });
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(recordEntity({ isLocked: false, lockedAt: new Date("2030-01-02T10:00:00Z") }));
            expect((await service.update(doctor, 9, { changes: { treatmentPlan: PLAN } })).kind).toBe("updated");
            expect(mocks.amend).not.toHaveBeenCalled();
        });

        it("should amend when the row says locked even though Node's clock is before locked_at", async () => {
            jest.useFakeTimers({ now: Date.parse("2000-01-01T00:00:00Z") });
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(recordEntity({ isLocked: true, lockedAt: new Date("2030-01-02T10:00:00Z") }));
            expect((await service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON })).kind).toBe("amended");
            expect(mocks.update).not.toHaveBeenCalled();
        });
    });

    describe("the trigger as defence in depth", () => {
        it("should map a check violation from trg_medical_records_forbid_update_after_lock to RecordLocked", async () => {
            const { service, mocks } = setup();
            mocks.update.mockRejectedValue(pgError("23514", "trg_medical_records_forbid_update_after_lock"));
            const err = await codeOf(() => service.update(doctor, 9, { changes: { treatmentPlan: PLAN } }));
            expect([err.code, err.status]).toEqual(["RecordLocked", 409]);
        });

        it("should rethrow any other check violation and any non-database error untouched", async () => {
            const { service, mocks } = setup();
            const other = pgError("23514", "chk_medical_records_follow_up");
            mocks.update.mockRejectedValue(other);
            await expect(service.update(doctor, 9, { changes: { followUpInDays: 5 } })).rejects.toBe(other);
            const boom = new Error("deadlock");
            mocks.update.mockRejectedValue(boom);
            await expect(service.update(doctor, 9, { changes: { followUpInDays: 5 } })).rejects.toBe(boom);
            mocks.update.mockRejectedValue(pgError("23514"));
            await expect(service.update(doctor, 9, { changes: { followUpInDays: 5 } })).rejects.toMatchObject({ code: "23514" });
        });

        it("should map the trigger refusal raised by the amendment path too", async () => {
            const { service, mocks } = setup();
            mocks.findForUpdate.mockResolvedValue(recordEntity({ isLocked: true }));
            mocks.amend.mockRejectedValue(pgError("23514", "trg_medical_records_forbid_update_after_lock"));
            expect((await codeOf(() => service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON }))).code).toBe("RecordLocked");
        });
    });

    it("should take the amendment author from the actor, never from the input", async () => {
        const { service, mocks } = setup();
        mocks.findForUpdate.mockResolvedValue(recordEntity({ isLocked: true }));
        await service.update(doctor, 9, { changes: { treatmentPlan: PLAN }, reason: REASON, authorUserId: 1 } as never);
        expect(mocks.amend.mock.calls[0]?.[0].authorUserId).toBe(202);
    });
});
