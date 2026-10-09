import type { Knex } from "knex";
import type { StringCursorPosition } from "../../lib/http/pagination/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { LocalInterval } from "../../pkg/slots/types";
import type { ConsultationTypeField, ScheduleChangeKind, ScheduleExceptionType } from "./enums";

/** pg returns `TIME` as `HH:MM:SS` text and `DATE` as `YYYY-MM-DD` text (type parser overrides). */
export interface WorkingHoursRow { id: number; weekday: number; start_time: string; end_time: string }
export interface ScheduleExceptionRow {
    id: number; date: string; type: ScheduleExceptionType; start_time: string | null; end_time: string | null;
    reason: string | null; created_at: Date;
}
export interface ConsultationTypeRow {
    id: number; name: string; duration_minutes: number; price: number; currency: string; is_active: boolean;
    created_at: Date; updated_at: Date;
}

/** The doctor profile as `schedules` needs it (resolved through `doctors`, never its repository). */
export interface ScheduleOwner { profileId: number; userId: number; timezone: string; currency: string; isSuspended: boolean }

/** One working-hours row to insert: `HH:mm` (`24:00` allowed as an end). */
export interface WorkingHoursInsertRow { weekday: number; startTime: string; endTime: string }
export interface WorkingHoursDayInput { weekday: number; intervals: LocalInterval[] }
export interface WorkingHoursInput { days: WorkingHoursDayInput[]; confirmConflicts: boolean }
export interface TimeIntervalView { startTime: string; endTime: string }
export interface WorkingHoursDayView { weekday: number; intervals: TimeIntervalView[] }
export interface WorkingHoursView { timezone: string; days: WorkingHoursDayView[] }

export interface ExceptionInput {
    type: ScheduleExceptionType; date: string; endDate: string | null; startMinute: number | null; endMinute: number | null;
    reason: string | null; confirmConflicts: boolean;
}
export interface ExceptionInsertRow { date: string; type: ScheduleExceptionType; startTime: string | null; endTime: string | null; reason: string | null }
export interface ExceptionPageParams { fromDate: string; toDate: string | null; after: StringCursorPosition | null; fetch: number }

export interface ConsultationTypeInput { name: string; durationMinutes: number; price: number; currency: string }
export interface ConsultationTypeChanges { name?: string; durationMinutes?: number; price?: number; currency?: string; isActive?: boolean }
export interface ConsultationTypeColumnChanges { name?: string; duration_minutes?: number; price?: number; currency?: string; is_active?: boolean }
export interface ConsultationTypeDiff { fields: ConsultationTypeField[]; columns: ConsultationTypeColumnChanges }
export interface TypePageParams { isActive: boolean | null; afterId: number | null; fetch: number }

/** What changed, as seen by the impact provider. Dates are doctor-local `YYYY-MM-DD`. */
export type ScheduleChange =
    | { kind: "working_hours" }
    | { kind: "schedule_exception_created"; fromDate: string; toDate: string }
    | { kind: "schedule_exception_deleted"; date: string };

export interface ScheduleImpactContext {
    doctorProfileId: number;
    doctorUserId: number;
    timezone: string;
    now: Date;
    change: ScheduleChange;
}

export interface ScheduleChangedEvent { doctorProfileId: number; doctorUserId: number; kind: ScheduleChangeKind }

/**
 * Seam for `consultations` (default: no-op). Both calls run INSIDE the write's transaction; the rows are already
 * written, so `findAffected` reads the NEW state from `trx`. Never moves or cancels a consultation.
 */
export interface ScheduleImpactProvider {
    /** Future non-terminal consultations no longer inside the doctor's open intervals, ascending ids. */
    findAffected(ctx: ScheduleImpactContext, trx: Knex.Transaction): Promise<number[]>;
    flagAffected(ctx: ScheduleImpactContext, ids: readonly number[], trx: Knex.Transaction): Promise<void>;
}

/** Seam for `availability` (default: no-op), invoked after commit; its failure never fails the write. */
export interface ScheduleChangeListener {
    onScheduleChanged(event: ScheduleChangedEvent): Promise<void>;
}

/** Breaks the `doctors` <-> `schedules` constructor cycle: profile lookup/lock through `DoctorsService`, resolved lazily. */
export interface ScheduleOwnerResolver {
    find(userId: number, conn: Knex): Promise<ScheduleOwner | undefined>;
    lock(userId: number, trx: Knex.Transaction): Promise<ScheduleOwner | undefined>;
}

export type SchedulesRoute = "getWorkingHours" | "replaceWorkingHours" | "listExceptions" | "createException" | "deleteException"
    | "listTypes" | "createType" | "updateType";
export type SchedulesPolicies = Readonly<Record<SchedulesRoute, UserPolicy>>;
