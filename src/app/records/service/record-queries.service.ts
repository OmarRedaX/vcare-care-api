import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { Forbidden, NotFound } from "../../../lib/error/errors";
import { decodeTimestampCursor } from "../../../lib/http/pagination/cursor";
import { buildPage, resolveLimit } from "../../../lib/http/pagination/page";
import type { AuthContext } from "../../../lib/types/types";
import { PatientsService } from "../../patients/service/patients.service";
import { MEDICAL_RECORD_ENTITY_TYPE, PATIENT_RECORDS_ENTITY_TYPE } from "../constants";
import { RecordAuditAction } from "../enums";
import { listByRecordIds } from "../repository/medical-record-amendments.repo";
import { findById, listTimeline } from "../repository/medical-records.repo";
import type { PatientTimelineResult, RecordWithAmendments, TimelineQuery } from "../types";

/**
 * Read side of `records`. Every successful read writes its audit row in the read transaction BEFORE the response is built, and a failed
 * audit insert fails the read (`500`, no body): a clinical read that cannot be audited does not happen (Privacy and logging). A `404`
 * writes no row. The ownership resolver already decided who may ask; the checks here are defence in depth.
 */
@injectable()
export class RecordQueriesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.PatientsService) private readonly patients: PatientsService,
    ) {}

    async get(actor: AuthContext, recordId: number): Promise<RecordWithAmendments> {
        if (actor.role === "admin") throw Forbidden;
        return this.db.transaction(async (trx) => {
            const record = await findById(recordId, trx);
            if (record === undefined) throw NotFound;
            // The doctor relationship was decided once by the resolver; a patient is held to their own record again here.
            if (actor.role === "patient" && record.patientUserId !== actor.userId) throw NotFound;
            const amendments = (await listByRecordIds([record.id], trx)).get(record.id) ?? [];
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAuditAction.Read, entityType: MEDICAL_RECORD_ENTITY_TYPE,
                entityId: record.id, metadata: { consultationId: record.consultationId, patientUserId: record.patientUserId, viewerRole: actor.role,
                    viewerIsAuthor: record.doctorUserId === actor.userId, amendmentCount: amendments.length } });
            return { record, amendments };
        });
    }

    /** Four statements in one transaction (three on an empty page); the amendments of the whole page are ONE query. */
    async timeline(actor: AuthContext, patientUserId: number, query: TimelineQuery): Promise<PatientTimelineResult> {
        if (actor.role === "admin") throw Forbidden;
        if (actor.role === "patient" && actor.userId !== patientUserId) throw NotFound;
        const limit = resolveLimit(query.limit);
        // Decoded before the transaction opens: a malformed cursor is a 400 that touches no table.
        const after = query.cursor === undefined ? null : decodeTimestampCursor(query.cursor);
        return this.db.transaction(async (trx) => {
            const entries = await listTimeline({ patientUserId, after, fetch: limit + 1 }, trx);
            const page = buildPage(entries, limit, (entry) => [entry.cursorTimestamp, entry.record.id]);
            const amendments = await listByRecordIds(page.items.map((entry) => entry.record.id), trx);
            // Repeated on every page (R-D10); `null` when the patient has no profile row yet (booking needs none). No `patient_profile.read` row.
            const profile = await this.patients.findProfile(patientUserId, trx);
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: RecordAuditAction.TimelineListed, entityType: PATIENT_RECORDS_ENTITY_TYPE,
                entityId: patientUserId, metadata: { patientUserId, viewerRole: actor.role, recordCount: page.items.length, hasMore: page.meta.hasMore,
                    firstPage: query.cursor === undefined } });
            return {
                patient: profile ?? null,
                items: page.items.map((entry) => ({ record: entry.record, amendments: amendments.get(entry.record.id) ?? [] })),
                meta: page.meta,
            };
        });
    }
}
