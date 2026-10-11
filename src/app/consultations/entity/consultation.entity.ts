import type { CancelledBy, ConsultationStatus, FollowupReason } from "../enums";

export class Consultation {
    id!: number;
    doctorUserId!: number;
    patientUserId!: number;
    consultationTypeId!: number;
    /** Current name of the type, joined by primary key. */
    consultationTypeName!: string;
    startsAt!: Date;
    endsAt!: Date;
    status!: ConsultationStatus;
    /** Clinical free text; never logged, never in admin or list output. */
    complaintText!: string;
    patientTimezone!: string;
    /** Minor units; snapshot of the type price at booking. */
    price!: number;
    currency!: string;
    roomId!: string | null;
    joinedAt!: Date | null;
    startedAt!: Date | null;
    completedAt!: Date | null;
    cancelledAt!: Date | null;
    cancelReason!: string | null;
    cancelledBy!: CancelledBy | null;
    cancelledByUserId!: number | null;
    noShowMarkedAt!: Date | null;
    needsAdminFollowup!: boolean;
    followupReason!: FollowupReason | null;
    followUpOfRecordId!: number | null;
    reminder24hSentAt!: Date | null;
    reminder1hSentAt!: Date | null;
    idempotencyKey!: string;
    requestHash!: string;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<Consultation>) { Object.assign(this, data); }
}
