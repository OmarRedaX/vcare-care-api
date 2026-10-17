import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { checkViolationConstraint, uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { AuthContext } from "../../../lib/types/types";
import { ConsultationStatus } from "../../consultations/enums";
import { ConsultationRowsService } from "../../consultations/service/consultation-rows.service";
import { MEDICAL_RECORD_ENTITY_TYPE, TRG_MEDICAL_RECORDS_FORBID_UPDATE_AFTER_LOCK, UQ_MEDICAL_RECORDS_CONSULTATION_ID } from "../constants";
import type { MedicalRecord } from "../entity/medical-record.entity";
import { RecordAuditAction } from "../enums";
import { NotAssignedDoctor, ReasonRequiredAfterLock, RecordAlreadyExists, RecordLocked, RecordRequiresCompleted } from "../errors";
import { insertAmendment } from "../repository/medical-record-amendments.repo";
import { findByIdForNoKeyUpdate, findLiveIdByConsultationId, insertRecord, updateRecordFields } from "../repository/medical-records.repo";
import { diffRecord, providedFields } from "../rules";
import type { RecordCreateInput, RecordUpdateInput, RecordUpdateResult } from "../types";

/**
 * Write side of `records` (Domain rules 13-15): create for a completed consultation and update-in-place-or-amend. Every write is ONE
 * transaction with its audit row. The lock is decided with DATABASE time under the row lock (R-D8); the unique index is the guarantee of
 * one live record per consultation and the trigger is the guarantee of the lock, so every check here only gives the precise error.
 * No Identity, storage or video call is made anywhere in this class.
 */
@injectable()
export class RecordsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.ConsultationRowsService) private readonly rows: ConsultationRowsService,
    ) {}

    /**
     * The creation gate (the order is part of the contract: the first failure wins). The caller already passed the role, account state,
     * suspension check and the visibility resolver. The status is read without a lock: `completed` is terminal, so only the unique
     * index can race (its loser gets `Conflict`).
     */
    async create(actor: AuthContext, consultationId: number, input: RecordCreateInput): Promise<MedicalRecord> {
        try {
            return await this.db.transaction(async (trx) => {
                const parties = await this.rows.findParties(consultationId, trx);
                if (parties === undefined) throw NotFound;
                // A related doctor who is not the assigned one is told so before the status is revealed.
                if (parties.doctorUserId !== actor.userId) throw NotAssignedDoctor;
                if (parties.status !== ConsultationStatus.Completed) throw RecordRequiresCompleted;
                if (await findLiveIdByConsultationId(consultationId, trx) !== undefined) throw RecordAlreadyExists;
                // Both user ids come from the consultation, never from the body.
                const record = await insertRecord({ consultationId, patientUserId: parties.patientUserId, doctorUserId: parties.doctorUserId, input }, trx);
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAuditAction.Created, entityType: MEDICAL_RECORD_ENTITY_TYPE,
                    entityId: record.id, metadata: { consultationId, patientUserId: record.patientUserId, doctorUserId: record.doctorUserId,
                        providedFields: providedFields(input).join(",") } });
                return record;
            });
        } catch (error) {
            // The failed insert aborted the transaction, which is already rolled back here.
            if (uniqueViolationConstraint(error) === UQ_MEDICAL_RECORDS_CONSULTATION_ID) throw RecordAlreadyExists;
            throw error;
        }
    }

    /**
     * Before the lock: update in place (values equal to the stored ones are a no-op, R-D7). After the lock: append an amendment, always;
     * the original row is never touched. `reason` is required only after the lock and is ignored before it.
     */
    async update(actor: AuthContext, recordId: number, input: RecordUpdateInput): Promise<RecordUpdateResult> {
        try {
            return await this.db.transaction(async (trx): Promise<RecordUpdateResult> => {
                const record = await findByIdForNoKeyUpdate(recordId, trx);
                if (record === undefined) throw NotFound;
                if (record.doctorUserId !== actor.userId) throw NotAssignedDoctor;
                if (!record.isLocked) {
                    const diff = diffRecord(record, input.changes);
                    if (diff.fields.length === 0) return { kind: "unchanged", record };
                    const updated = await updateRecordFields(record.id, diff.columns, trx);
                    await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAuditAction.Updated, entityType: MEDICAL_RECORD_ENTITY_TYPE,
                        entityId: record.id, metadata: { consultationId: record.consultationId, patientUserId: record.patientUserId, changedFields: diff.fields.join(",") } });
                    return { kind: "updated", record: updated };
                }
                if (input.reason === undefined) throw ReasonRequiredAfterLock;
                const amendment = await insertAmendment({ recordId: record.id, authorUserId: actor.userId, changes: input.changes, reason: input.reason }, trx);
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAuditAction.Amended, entityType: MEDICAL_RECORD_ENTITY_TYPE,
                    entityId: record.id, metadata: { consultationId: record.consultationId, patientUserId: record.patientUserId, amendmentId: amendment.id,
                        changedFields: providedFields(input.changes).join(","), reasonLength: [...input.reason].length } });
                return { kind: "amended", amendment };
            });
        } catch (error) {
            // Defence in depth: the trigger read the same NOW() as the lock flag, so this fires only if a row was altered outside the service.
            if (checkViolationConstraint(error) === TRG_MEDICAL_RECORDS_FORBID_UPDATE_AFTER_LOCK) throw RecordLocked;
            throw error;
        }
    }
}
