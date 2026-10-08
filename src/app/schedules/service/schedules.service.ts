import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { Forbidden, NotFound, ValidationFailed } from "../../../lib/error/errors";
import { decodeCursor, decodeTextCursor } from "../../../lib/http/pagination/cursor";
import { buildPage, resolveLimit } from "../../../lib/http/pagination/page";
import type { Page, StringCursorPosition } from "../../../lib/http/pagination/types";
import { uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { Logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { AuthContext } from "../../../lib/types/types";
import { formatTimeOfDay } from "../../../pkg/slots/local-time";
import { isCalendarDate, localDateOf } from "../../../pkg/slots/local-date";
import {
    AUDIT_CONFLICT_IDS_MAX, CONSULTATION_TYPE_ENTITY_TYPE, DATE_CURSOR_LENGTH, DOCTOR_PROFILE_ENTITY_TYPE, MAX_CONSULTATION_TYPES_PER_DOCTOR,
    SCHEDULE_EXCEPTION_ENTITY_TYPE, UQ_CONSULTATION_TYPE_NAME, UQ_SCHEDULE_EXCEPTION_DATE,
} from "../constants";
import type { ListExceptionsQueryDto, ListTypesQueryDto } from "../dto/schedules.request.dto";
import type { ConsultationType } from "../entity/consultation-type.entity";
import type { ScheduleException } from "../entity/schedule-exception.entity";
import { ConsultationTypeAuditAction, ScheduleAuditAction, ScheduleChangeKind, ScheduleExceptionType } from "../enums";
import {
    ConsultationTypeLimitReached, ConsultationTypeNameTaken, DateRangeReversed, ExceptionDateTaken, ExceptionInPast, scheduleConflictsUnconfirmed,
    TypeCurrencyMismatch,
} from "../errors";
import { countLiveTypes, findTypeById, hasActiveType, insertType, listTypesPage, updateType } from "../repository/consultation-types.repo";
import { findExceptionById, insertExceptions, listExceptionsPage, softDeleteException } from "../repository/schedule-exceptions.repo";
import { insertHours, listLiveHours, softDeleteLiveHours } from "../repository/working-hours.repo";
import { assertExceptionShape, assertValidHours, diffConsultationType, expandExceptionDates, groupHours, normalizeHours, sameHours } from "../rules";
import type {
    ConsultationTypeChanges, ConsultationTypeInput, ExceptionInput, ScheduleChange, ScheduleChangeListener, ScheduleChangedEvent,
    ScheduleImpactContext, ScheduleImpactProvider, ScheduleOwner, ScheduleOwnerResolver, WorkingHoursInput, WorkingHoursView,
} from "../types";

const INVALID_CURSOR = ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);

@injectable()
export class SchedulesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.ScheduleOwnerResolver) private readonly owners: ScheduleOwnerResolver,
        @inject(TOKENS.ScheduleImpactProvider) private readonly impact: ScheduleImpactProvider,
        @inject(TOKENS.ScheduleChangeListener) private readonly listener: ScheduleChangeListener,
    ) {}

    async getWorkingHours(actor: AuthContext): Promise<WorkingHoursView> {
        const owner = await this.findOwner(actor);
        return { timezone: owner.timezone, days: groupHours(await listLiveHours(owner.profileId, this.db)) };
    }

    async replaceWorkingHours(actor: AuthContext, input: WorkingHoursInput): Promise<WorkingHoursView> {
        assertValidHours(input.days);
        const rows = normalizeHours(input.days);
        const now = new Date();
        const result = await this.db.transaction(async (trx) => {
            const owner = await this.lockOwner(actor, trx);
            const current = await listLiveHours(owner.profileId, trx);
            if (sameHours(current, rows)) return { owner, hours: current, changed: false };
            await softDeleteLiveHours(owner.profileId, trx);
            const hours = await insertHours(owner.profileId, rows, trx);
            const affected = await this.checkImpact(actor, owner, { kind: "working_hours" }, now, input.confirmConflicts, trx);
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ScheduleAuditAction.HoursReplaced,
                entityType: DOCTOR_PROFILE_ENTITY_TYPE, entityId: owner.profileId,
                metadata: { dayCount: new Set(rows.map((row) => row.weekday)).size, intervalCount: rows.length, confirmed: affected > 0 } });
            return { owner, hours, changed: true };
        });
        if (result.changed) await this.notifyChanged(result.owner, ScheduleChangeKind.WorkingHours);
        return { timezone: result.owner.timezone, days: groupHours(result.hours) };
    }

    async listExceptions(actor: AuthContext, query: ListExceptionsQueryDto): Promise<Page<ScheduleException>> {
        const owner = await this.findOwner(actor);
        const limit = resolveLimit(query.limit);
        const fromDate = query.fromDate ?? localDateOf(Date.now(), owner.timezone);
        if (query.toDate !== undefined && fromDate > query.toDate) throw DateRangeReversed;
        let after: StringCursorPosition | null = null;
        if (query.cursor !== undefined) {
            after = decodeTextCursor(query.cursor, DATE_CURSOR_LENGTH);
            if (!isCalendarDate(after.sortValue)) throw INVALID_CURSOR;
        }
        const rows = await listExceptionsPage(owner.profileId, { fromDate, toDate: query.toDate ?? null, after, fetch: limit + 1 }, this.db);
        return buildPage(rows, limit, (row) => [row.date, row.id]);
    }

    async createExceptions(actor: AuthContext, input: ExceptionInput): Promise<ScheduleException[]> {
        assertExceptionShape(input);
        const dates = expandExceptionDates(input.date, input.endDate);
        const fromDate = dates[0] ?? input.date;
        const toDate = dates[dates.length - 1] ?? input.date;
        const now = new Date();
        const result = await this.db.transaction(async (trx) => {
            const owner = await this.lockOwner(actor, trx);
            if (fromDate < localDateOf(now.getTime(), owner.timezone)) throw ExceptionInPast;
            const rows = dates.map((date) => ({
                date, type: input.type,
                startTime: input.startMinute === null ? null : formatTimeOfDay(input.startMinute),
                endTime: input.endMinute === null ? null : formatTimeOfDay(input.endMinute),
                reason: input.reason,
            }));
            let created: ScheduleException[];
            try {
                created = await insertExceptions(owner.profileId, rows, trx);
            } catch (error) {
                if (uniqueViolationConstraint(error) === UQ_SCHEDULE_EXCEPTION_DATE) throw ExceptionDateTaken;
                throw error;
            }
            await this.checkImpact(actor, owner, { kind: "schedule_exception_created", fromDate, toDate }, now, input.confirmConflicts, trx);
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ScheduleAuditAction.ExceptionCreated,
                entityType: DOCTOR_PROFILE_ENTITY_TYPE, entityId: owner.profileId,
                metadata: { type: input.type, fromDate, toDate, count: created.length } });
            return { owner, created };
        });
        await this.notifyChanged(result.owner, ScheduleChangeKind.ScheduleException);
        return result.created;
    }

    async deleteException(actor: AuthContext, id: number, confirmConflicts: boolean): Promise<void> {
        const now = new Date();
        const owner = await this.db.transaction(async (trx) => {
            const locked = await this.lockOwner(actor, trx);
            const exception = await findExceptionById(locked.profileId, id, trx);
            if (exception === undefined) throw NotFound;
            await softDeleteException(exception.id, trx);
            if (exception.type === ScheduleExceptionType.CustomHours && exception.date >= localDateOf(now.getTime(), locked.timezone)) {
                await this.checkImpact(actor, locked, { kind: "schedule_exception_deleted", date: exception.date }, now, confirmConflicts, trx);
            }
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ScheduleAuditAction.ExceptionDeleted,
                entityType: SCHEDULE_EXCEPTION_ENTITY_TYPE, entityId: exception.id, metadata: { type: exception.type, date: exception.date } });
            return locked;
        });
        await this.notifyChanged(owner, ScheduleChangeKind.ScheduleException);
    }

    async listConsultationTypes(actor: AuthContext, query: ListTypesQueryDto): Promise<Page<ConsultationType>> {
        const owner = await this.findOwner(actor);
        const limit = resolveLimit(query.limit);
        let afterId: number | null = null;
        if (query.cursor !== undefined) {
            const position = decodeCursor(query.cursor);
            if (position.sortValue !== position.id) throw INVALID_CURSOR;
            afterId = position.id;
        }
        const rows = await listTypesPage(owner.profileId, { isActive: query.isActive ?? null, afterId, fetch: limit + 1 }, this.db);
        return buildPage(rows, limit, (row) => [row.id, row.id]);
    }

    async createConsultationType(actor: AuthContext, input: ConsultationTypeInput): Promise<ConsultationType> {
        this.assertCurrencyAllowed(input.currency);
        const result = await this.db.transaction(async (trx) => {
            const owner = await this.lockOwner(actor, trx);
            if (input.currency !== owner.currency) throw TypeCurrencyMismatch;
            if (await countLiveTypes(owner.profileId, trx) >= MAX_CONSULTATION_TYPES_PER_DOCTOR) throw ConsultationTypeLimitReached;
            let created: ConsultationType;
            try {
                created = await insertType(owner.profileId, input, trx);
            } catch (error) {
                if (uniqueViolationConstraint(error) === UQ_CONSULTATION_TYPE_NAME) throw ConsultationTypeNameTaken;
                throw error;
            }
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationTypeAuditAction.Created,
                entityType: CONSULTATION_TYPE_ENTITY_TYPE, entityId: created.id,
                metadata: { durationMinutes: created.durationMinutes, price: created.price, currency: created.currency } });
            return { owner, created };
        });
        await this.notifyChanged(result.owner, ScheduleChangeKind.ConsultationType);
        return result.created;
    }

    async updateConsultationType(actor: AuthContext, id: number, changes: ConsultationTypeChanges): Promise<ConsultationType> {
        if (changes.currency !== undefined) this.assertCurrencyAllowed(changes.currency);
        const result = await this.db.transaction(async (trx) => {
            const owner = await this.lockOwner(actor, trx);
            const current = await findTypeById(owner.profileId, id, trx);
            if (current === undefined) throw NotFound;
            if (changes.currency !== undefined && changes.currency !== owner.currency) throw TypeCurrencyMismatch;
            const diff = diffConsultationType(current, changes);
            if (diff.fields.length === 0) return { owner, type: current, changed: false };
            let updated: ConsultationType;
            try {
                updated = await updateType(current.id, diff.columns, trx);
            } catch (error) {
                if (uniqueViolationConstraint(error) === UQ_CONSULTATION_TYPE_NAME) throw ConsultationTypeNameTaken;
                throw error;
            }
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationTypeAuditAction.Updated,
                entityType: CONSULTATION_TYPE_ENTITY_TYPE, entityId: updated.id, metadata: { changedFields: diff.fields.join(",") } });
            return { owner, type: updated, changed: true };
        });
        if (result.changed) await this.notifyChanged(result.owner, ScheduleChangeKind.ConsultationType);
        return result.type;
    }

    /** Domain rule 6 term for `doctors`' `isBookable`; the caller passes its own connection or transaction. */
    hasActiveConsultationType(profileId: number, conn: Knex = this.db): Promise<boolean> {
        return hasActiveType(profileId, conn);
    }

    /** The caller's live profile without a lock (reads); absent -> 404. */
    private async findOwner(actor: AuthContext): Promise<ScheduleOwner> {
        const owner = await this.owners.find(actor.userId, this.db);
        if (owner === undefined) throw NotFound;
        return owner;
    }

    /** First statement of every write: serializes the doctor's writes and re-reads suspension under the lock. */
    private async lockOwner(actor: AuthContext, trx: Knex.Transaction): Promise<ScheduleOwner> {
        const owner = await this.owners.lock(actor.userId, trx);
        if (owner === undefined) throw NotFound;
        if (owner.isSuspended) throw Forbidden;
        return owner;
    }

    /**
     * Impact check inside the write's transaction (rows already written): affected consultations without
     * `confirmConflicts` roll the write back with a 409; with it they are flagged and one audit row is written.
     * Returns the number of affected consultations.
     */
    private async checkImpact(actor: AuthContext, owner: ScheduleOwner, change: ScheduleChange, now: Date, confirmConflicts: boolean,
        trx: Knex.Transaction): Promise<number> {
        const ctx: ScheduleImpactContext = { doctorProfileId: owner.profileId, doctorUserId: owner.userId, timezone: owner.timezone, now, change };
        const ids = [...await this.impact.findAffected(ctx, trx)].sort((a, b) => a - b);
        if (ids.length === 0) return 0;
        if (!confirmConflicts) throw scheduleConflictsUnconfirmed(ids);
        await this.impact.flagAffected(ctx, ids, trx);
        await this.audit.record(trx, { actor: actorFromAuth(actor), action: ScheduleAuditAction.ConflictsConfirmed,
            entityType: DOCTOR_PROFILE_ENTITY_TYPE, entityId: owner.profileId,
            metadata: { change: change.kind, count: ids.length, consultationIds: ids.slice(0, AUDIT_CONFLICT_IDS_MAX).join(","),
                idsTruncated: ids.length > AUDIT_CONFLICT_IDS_MAX } });
        return ids.length;
    }

    /** After commit; a listener failure is logged (no data) and never fails the committed write. */
    private async notifyChanged(owner: ScheduleOwner, kind: ScheduleChangeKind): Promise<void> {
        const event: ScheduleChangedEvent = { doctorProfileId: owner.profileId, doctorUserId: owner.userId, kind };
        try {
            await this.listener.onScheduleChanged(event);
        } catch {
            this.logger.error("schedule_change_listener_failed", { requestId: currentRequestId(), doctorProfileId: owner.profileId, kind });
        }
    }

    private assertCurrencyAllowed(currency: string): void {
        if (!this.env.ALLOWED_CURRENCIES.includes(currency)) throw TypeCurrencyMismatch;
    }
}
