import type { Page, StringCursorPosition } from "../../lib/http/pagination/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { Role } from "../../lib/types/types";
import type { NotificationsService } from "../notifications/service/notifications.service";
import type { SchedulesService } from "../schedules/service/schedules.service";
import type { Consultation } from "./entity/consultation.entity";
import type { CancelledBy, ConsultationChangeKind, ConsultationScope, ConsultationStatus, FollowupReason } from "./enums";

/** pg returns `TIMESTAMPTZ` as `Date`, `BIGINT` as number (type parser override) and `UUID`/`CHAR` as text. */
export interface ConsultationRow {
    id: number; doctor_user_id: number; patient_user_id: number; consultation_type_id: number; starts_at: Date; ends_at: Date;
    status: ConsultationStatus; complaint_text: string; patient_timezone: string; price: number; currency: string;
    room_id: string | null; joined_at: Date | null; started_at: Date | null; completed_at: Date | null; cancelled_at: Date | null;
    cancel_reason: string | null; cancelled_by: CancelledBy | null; cancelled_by_user_id: number | null; no_show_marked_at: Date | null;
    needs_admin_followup: boolean; followup_reason: FollowupReason | null; follow_up_of_record_id: number | null;
    reminder_24h_sent_at: Date | null; reminder_1h_sent_at: Date | null; idempotency_key: string; request_hash: string;
    created_at: Date; updated_at: Date;
    /** Joined from `consultation_types` by primary key; absent on a plain `RETURNING` row. */
    type_name?: string;
}
/** A list row with the microsecond cursor text of `starts_at`. */
/** Columns a list item never needs (`CONSULTATION_LIST_COLUMNS` leaves them out); `toEntity` defaults them. */
type ListOmittedColumn = "complaint_text" | "room_id" | "no_show_marked_at" | "cancelled_by_user_id" | "reminder_24h_sent_at" | "reminder_1h_sent_at"
    | "idempotency_key" | "request_hash";
export type ConsultationListRow = Omit<ConsultationRow, ListOmittedColumn> & Partial<Pick<ConsultationRow, ListOmittedColumn>>;
export interface ConsultationListDbRow extends ConsultationListRow { starts_at_cursor: string }
export interface CandidateRow { id: number; starts_at: Date; ends_at: Date }
export interface FlaggedRow { id: number; patient_user_id: number; starts_at: Date; ends_at: Date }
/** `newly_flagged` = the row did not already carry this follow-up reason before the statement (flag-once notification). */
export interface FutureFlaggedRow extends FlaggedRow { newly_flagged: boolean }
export interface DeliveryDbRow {
    id: number; status: string; starts_at: Date; ends_at: Date; patient_user_id: number; doctor_user_id: number; patient_timezone: string;
    doctor_timezone: string | null; deleted_at: Date | null;
}
export interface ReminderDbRow { id: number; patient_user_id: number; doctor_user_id: number; starts_at: Date; ends_at: Date; created_at: Date }

/** What the booking transaction inserts; `ends_at`, price and currency are already server-derived. */
export interface NewConsultation {
    doctorUserId: number; patientUserId: number; consultationTypeId: number; typeName: string; startsAt: Date; endsAt: Date;
    complaintText: string; patientTimezone: string; price: number; currency: string; idempotencyKey: string; requestHash: string;
    /** An already ownership-checked medical record id (the booking transaction verifies it); `undefined` for an ordinary booking. */
    followUpOfRecordId?: number;
}
/** Who is on a consultation and where it stands: no clinical text. The `records` module's creation gate and resolvers read it. */
export interface ConsultationParties { id: number; doctorUserId: number; patientUserId: number; status: ConsultationStatus }
export interface TransitionChanges {
    cancelled_at?: Date; cancelled_by?: CancelledBy; cancelled_by_user_id?: number; cancel_reason?: string | null;
    room_id?: string; joined_at?: Date; started_at?: Date; completed_at?: Date; no_show_marked_at?: Date;
}
/** Parameters of the doctor waiting-room query (`listWaitingRoomQuery`): instants are UTC milliseconds. */
export interface WaitingRoomParams { doctorUserId: number; nowMs: number; openMinutes: number; overrunMinutes: number; limit: number }
/** Parameters of the doctor calendar query (`listCalendarQuery`): the window is `[fromMs, toMs)`. */
export interface CalendarParams { doctorUserId: number; fromMs: number; toMs: number; limit: number }

export interface BookInput {
    doctorId: number; typeId: number; startsAtMs: number; complaintText: string; patientTimezone: string; followUpOfRecordId?: number;
}
export interface RescheduleInput { startsAtMs: number; reason?: string }
export interface CancelInput { reason?: string }

/** A validated `GET /consultations` query (admin-only members are checked by the service). */
export interface ConsultationListQuery {
    scope: ConsultationScope; statuses: ConsultationStatus[] | undefined; fromMs: number | undefined; toMs: number | undefined;
    doctorUserId: number | undefined; patientUserId: number | undefined; needsAdminFollowup: boolean | undefined;
    timezone: string | undefined; cursor: string | undefined; limit: number | undefined;
}
/** The repository `WHERE`, built from the verified principal and the validated query — never from raw input. */
export interface ConsultationListFilter {
    doctorUserId: number | null; patientUserId: number | null; scope: ConsultationScope; statuses: ConsultationStatus[] | null;
    from: Date | null; to: Date | null; needsAdminFollowup: boolean | null; now: Date; after: StringCursorPosition | null; fetch: number;
}
export interface ConsultationListEntry { consultation: Consultation; cursorTimestamp: string }

export interface ConsultationViewer { userId: number; role: Role }
export interface ParticipantView { userId: number; displayName: string | null; avatarUrl: string | null; profileHydrated: boolean }
/** How one consultation is rendered for one viewer: zone, participants, and whether clinical detail is allowed. */
export interface ConsultationView { timezone: string; doctor: ParticipantView; patient: ParticipantView; detail: boolean; hasRecord: boolean }
/** Per-request rendering inputs: the explicit `timezone` query (canonical) and the viewing doctor's own zone. */
export interface ViewContext { timezone: string | undefined; doctorTimezone: string | undefined }
export interface RenderedConsultation { consultation: Consultation; view: ConsultationView }
export type RenderedConsultationPage = Page<RenderedConsultation>;

export interface ConsultationChangeEvent { kind: ConsultationChangeKind; doctorUserId: number; consultationId: number }
/** Seam for the discovery cache invalidation (default no-op); invoked after commit, its failure never fails the write. */
export interface ConsultationChangeListener {
    onConsultationChanged(event: ConsultationChangeEvent): Promise<void>;
}

/** A booking that may have been replayed: only a newly created or changed row notifies the listener. */
export interface WriteResult { consultation: Consultation; changed: boolean }

/** UTC window `[fromMs, toMs)` that limits which consultations the schedule impact check considers. */
export interface CandidateWindow { fromMs: number; toMs: number }

/** What the schedule impact provider needs; `getSchedules` is lazy because `SchedulesService` injects the provider. */
export interface ScheduleImpactDeps { getSchedules: () => SchedulesService; notifications: NotificationsService }

export type ConsultationsRoute = "book" | "list" | "get" | "reschedule" | "cancel";
export type ConsultationsPolicies = Readonly<Record<ConsultationsRoute, UserPolicy>>;
