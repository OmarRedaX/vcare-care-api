import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { Conflict, IdempotencyConflict, NotFound } from "../../../lib/error/errors";
import { exclusionViolationConstraint, uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { Logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { AuthContext, Clock } from "../../../lib/types/types";
import { canonicalIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { addDays, localDateOf } from "../../../pkg/slots/local-date";
import { isSlotOnGrid } from "../../../pkg/slots/slot-fit";
import { toMs } from "../../../pkg/utils/time";
import { DoctorsService } from "../../doctors/service/doctors.service";
import { OutboxKind } from "../../notifications/enums";
import { NotificationsService } from "../../notifications/service/notifications.service";
import type { OutboxMessage, OutboxPayload } from "../../notifications/types";
import type { PatientRelationshipChecker } from "../../patients/types";
import { SchedulesService } from "../../schedules/service/schedules.service";
import {
    CONSULTATION_ENTITY_TYPE, EXCL_CONSULTATIONS_DOCTOR_NO_OVERLAP, OPEN_DAYS_MARGIN, UQ_CONSULTATIONS_IDEMPOTENCY,
} from "../constants";
import type { Consultation } from "../entity/consultation.entity";
import { CancelledBy, ConsultationAuditAction, ConsultationChangeKind, ConsultationStatus } from "../enums";
import {
    BeyondBookingHorizon, BookingInPast, DoctorNotBookable, FollowUpNotSupported, InvalidTransition, OutsideWorkingHours, PolicyWindowViolation,
    ReasonRequiredOnCancel, ReasonRequiredOnReschedule, SlotUnavailable,
} from "../errors";
import {
    applyTransition, findById, findByIdempotencyKey, findByIdForUpdate, hasRelationship, insertConsultation, rescheduleRow,
} from "../repository/consultations.repo";
import type { BookInput, CancelInput, ConsultationChangeListener, RescheduleInput, WriteResult } from "../types";

const MINUTE_MS = 60_000;

function hasReason(reason: string | undefined): reason is string {
    return reason !== undefined && reason.trim().length > 0;
}

/**
 * Book, reschedule and cancel (Domain rules 1-5, 8-10). Every write is ONE transaction with its audit row and its outbox rows;
 * the exclusion constraint is the overlap guarantee and every check here is a courtesy. Writes make no Identity call. Cache
 * and listener work happens after the commit.
 */
@injectable()
export class ConsultationsService implements PatientRelationshipChecker {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.Clock) private readonly clock: Clock,
        @inject(TOKENS.DoctorsService) private readonly doctors: DoctorsService,
        @inject(TOKENS.SchedulesService) private readonly schedules: SchedulesService,
        @inject(TOKENS.NotificationsService) private readonly notifications: NotificationsService,
        @inject(TOKENS.ConsultationChangeListener) private readonly listener: ConsultationChangeListener,
    ) {}

    async book(actor: AuthContext, input: BookInput, idempotencyKey: string, requestHash: string): Promise<Consultation> {
        if (input.followUpOfRecordId !== undefined) throw FollowUpNotSupported;
        let result: WriteResult;
        try {
            result = await this.bookOnce(actor, input, idempotencyKey, requestHash);
        } catch (error) {
            // The failed statement aborted the transaction, which is already rolled back here.
            if (exclusionViolationConstraint(error) === EXCL_CONSULTATIONS_DOCTOR_NO_OVERLAP) throw SlotUnavailable;
            if (uniqueViolationConstraint(error) !== UQ_CONSULTATIONS_IDEMPOTENCY) throw error;
            result = { consultation: await this.replayAfterRace(actor.userId, idempotencyKey, requestHash), changed: false };
        }
        if (result.changed) await this.notifyChanged(ConsultationChangeKind.Booked, result.consultation);
        return result.consultation;
    }

    private bookOnce(actor: AuthContext, input: BookInput, idempotencyKey: string, requestHash: string): Promise<WriteResult> {
        return this.db.transaction(async (trx): Promise<WriteResult> => {
            const existing = await findByIdempotencyKey(actor.userId, idempotencyKey, trx);
            if (existing !== undefined) return { consultation: this.replayOf(existing, requestHash), changed: false };
            // Everything below is read AFTER this share lock, which serializes with suspension and schedule writes (both FOR UPDATE).
            const doctor = await this.doctors.lockBookingTarget(input.doctorId, trx);
            if (doctor === undefined) throw NotFound;
            if (!doctor.isBookable) throw DoctorNotBookable;
            const type = await this.schedules.findBookableType(doctor.profileId, input.typeId, trx);
            if (type === undefined) throw NotFound;
            this.assertBookableStart(input.startsAtMs);
            await this.assertOnGrid(doctor.profileId, doctor.timezone, input.startsAtMs, type.durationMinutes, trx);
            const startsAt = new Date(input.startsAtMs);
            const endsAt = new Date(input.startsAtMs + type.durationMinutes * MINUTE_MS);
            const created = await insertConsultation({
                doctorUserId: doctor.userId, patientUserId: actor.userId, consultationTypeId: type.id, typeName: type.name, startsAt, endsAt,
                complaintText: input.complaintText, patientTimezone: canonicalIanaTimezone(input.patientTimezone), price: type.price,
                currency: type.currency, idempotencyKey, requestHash,
            }, trx);
            await this.notifications.enqueue(trx, this.partyMessages(OutboxKind.BookingConfirmed, created,
                { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }));
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Booked, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: created.id, metadata: { doctorUserId: created.doctorUserId, patientUserId: created.patientUserId,
                    consultationTypeId: created.consultationTypeId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } });
            return { consultation: created, changed: true };
        });
    }

    /** Same key and same body replays the stored consultation; the same key with another body is an idempotency conflict. */
    private replayOf(existing: Consultation, requestHash: string): Consultation {
        if (existing.requestHash !== requestHash) throw IdempotencyConflict;
        return existing;
    }

    /** A concurrent request with the same key committed first (Redis lost or bypassed): answer from the row it wrote. */
    private async replayAfterRace(patientUserId: number, idempotencyKey: string, requestHash: string): Promise<Consultation> {
        const existing = await findByIdempotencyKey(patientUserId, idempotencyKey, this.db);
        if (existing === undefined) throw Conflict;
        return this.replayOf(existing, requestHash);
    }

    async reschedule(actor: AuthContext, id: number, input: RescheduleInput): Promise<Consultation> {
        if (actor.role === "admin" && !hasReason(input.reason)) throw ReasonRequiredOnReschedule;
        let result: WriteResult;
        try {
            result = await this.rescheduleOnce(actor, id, input);
        } catch (error) {
            if (exclusionViolationConstraint(error) === EXCL_CONSULTATIONS_DOCTOR_NO_OVERLAP) throw SlotUnavailable;
            throw error;
        }
        if (result.changed) await this.notifyChanged(ConsultationChangeKind.Rescheduled, result.consultation);
        return result.consultation;
    }

    private rescheduleOnce(actor: AuthContext, id: number, input: RescheduleInput): Promise<WriteResult> {
        return this.db.transaction(async (trx): Promise<WriteResult> => {
            const seen = await findById(id, trx);
            if (seen === undefined || actor.role === "doctor" || (actor.role === "patient" && seen.patientUserId !== actor.userId)) throw NotFound;
            // Lock order profile -> consultation, the same as schedule writes, so the two can never deadlock.
            const doctor = await this.doctors.lockBookingTarget(seen.doctorUserId, trx);
            if (doctor === undefined) throw NotFound;
            const row = await findByIdForUpdate(id, trx);
            if (row === undefined) throw NotFound;
            if (row.status !== ConsultationStatus.Booked) throw InvalidTransition;
            if (actor.role === "patient") this.assertOutsidePolicyWindow(row);
            if (input.startsAtMs === row.startsAt.getTime()) return { consultation: row, changed: false };
            if (!doctor.isBookable) throw DoctorNotBookable;
            this.assertBookableStart(input.startsAtMs);
            // The interval length is the stored snapshot: later edits of the type never change an existing consultation.
            const durationMs = row.endsAt.getTime() - row.startsAt.getTime();
            await this.assertOnGrid(doctor.profileId, doctor.timezone, input.startsAtMs, durationMs / MINUTE_MS, trx);
            const startsAt = new Date(input.startsAtMs);
            const endsAt = new Date(input.startsAtMs + durationMs);
            const updated = await rescheduleRow(row, startsAt, endsAt, trx);
            if (updated === undefined) throw InvalidTransition;
            await this.notifications.enqueue(trx, this.partyMessages(OutboxKind.Rescheduled, updated, {
                previousStartsAt: row.startsAt.toISOString(), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), byRole: actor.role }));
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Rescheduled, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: updated.id, metadata: { byRole: actor.role, fromStartsAt: row.startsAt.toISOString(), toStartsAt: startsAt.toISOString(),
                    ...this.reasonMetadata(input.reason) } });
            return { consultation: updated, changed: true };
        });
    }

    async cancel(actor: AuthContext, id: number, input: CancelInput): Promise<Consultation> {
        if (actor.role !== "patient" && !hasReason(input.reason)) throw ReasonRequiredOnCancel;
        const result = await this.db.transaction(async (trx): Promise<WriteResult> => {
            const row = await findByIdForUpdate(id, trx);
            const participant = row !== undefined && (actor.role === "admin" || (actor.role === "patient" && row.patientUserId === actor.userId)
                || (actor.role === "doctor" && row.doctorUserId === actor.userId));
            if (row === undefined || !participant) throw NotFound;
            if (row.status !== ConsultationStatus.Booked && row.status !== ConsultationStatus.Waiting) throw InvalidTransition;
            if (actor.role === "patient") this.assertOutsidePolicyWindow(row);
            const cancelledBy = actor.role === "patient" ? CancelledBy.Patient : actor.role === "doctor" ? CancelledBy.Doctor : CancelledBy.Admin;
            const updated = await applyTransition(row, [ConsultationStatus.Booked, ConsultationStatus.Waiting], ConsultationStatus.Cancelled,
                { cancelled_at: new Date(this.clock.now()), cancelled_by: cancelledBy, cancelled_by_user_id: actor.userId,
                    cancel_reason: input.reason ?? null }, trx);
            if (updated === undefined) throw InvalidTransition;
            await this.notifications.enqueue(trx, this.partyMessages(OutboxKind.Cancelled, updated, {
                startsAt: updated.startsAt.toISOString(), endsAt: updated.endsAt.toISOString(), byRole: actor.role }));
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Cancelled, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: updated.id, metadata: { byRole: actor.role, fromStatus: row.status, ...this.reasonMetadata(input.reason) } });
            return { consultation: updated, changed: true };
        });
        await this.notifyChanged(ConsultationChangeKind.Cancelled, result.consultation);
        return result.consultation;
    }

    /** Relationship port for `patients`: a booked/waiting/in_progress/completed consultation links a doctor to a patient. */
    hasConsultationRelationship(doctorUserId: number, patientUserId: number): Promise<boolean> {
        return hasRelationship(doctorUserId, patientUserId, this.db);
    }

    /** Domain rule 3: not in the past, not beyond the horizon. */
    private assertBookableStart(startsAtMs: number): void {
        const now = this.clock.now();
        if (startsAtMs <= now) throw BookingInPast;
        if (startsAtMs > now + toMs(this.env.BOOKING_HORIZON_DAYS, "d")) throw BeyondBookingHorizon;
    }

    /** Domain rule 2: the start is on the grid of one open interval of the doctor-local date (zone and exceptions applied). */
    private async assertOnGrid(profileId: number, timezone: string, startsAtMs: number, durationMinutes: number, trx: Knex.Transaction): Promise<void> {
        const date = localDateOf(startsAtMs, timezone);
        const days = await this.schedules.resolveOpenDays(profileId, timezone, addDays(date, -OPEN_DAYS_MARGIN), addDays(date, OPEN_DAYS_MARGIN), trx);
        if (!isSlotOnGrid(days, startsAtMs, durationMinutes)) throw OutsideWorkingHours;
    }

    /** Domain rule 10: a patient may not change a consultation starting in less than the policy window (a past start included). */
    private assertOutsidePolicyWindow(row: Consultation): void {
        if (row.startsAt.getTime() - this.clock.now() < this.env.CANCELLATION_POLICY_MINUTES * MINUTE_MS) throw PolicyWindowViolation;
    }

    /** Audit metadata never holds reason text, only its length. */
    private reasonMetadata(reason: string | undefined): { reasonLength?: number } {
        return reason === undefined ? {} : { reasonLength: [...reason].length };
    }

    /** One message per party; the payload carries ids, instants and roles only (never reasons, complaint text or emails). */
    private partyMessages(kind: OutboxKind, consultation: Consultation, payload: OutboxPayload): OutboxMessage[] {
        return [
            { kind, consultationId: consultation.id, recipientUserId: consultation.patientUserId, payload: { ...payload, recipientRole: "patient" } },
            { kind, consultationId: consultation.id, recipientUserId: consultation.doctorUserId, payload: { ...payload, recipientRole: "doctor" } },
        ];
    }

    /** After commit; a listener failure is logged (no data) and never fails the committed write. */
    private async notifyChanged(kind: ConsultationChangeKind, consultation: Consultation): Promise<void> {
        try {
            await this.listener.onConsultationChanged({ kind, doctorUserId: consultation.doctorUserId, consultationId: consultation.id });
        } catch {
            this.logger.error("consultation_change_listener_failed", { requestId: currentRequestId(), consultationId: consultation.id, kind });
        }
    }
}
