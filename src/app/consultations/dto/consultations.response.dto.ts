import { toIsoInZone } from "../../../pkg/utils/time";
import type { Consultation } from "../entity/consultation.entity";
import type { ConsultationView, ConsultationViewer, ParticipantView } from "../types";

const MINUTE_MS = 60_000;

function iso(date: Date | null): string | null {
    return date === null ? null : date.toISOString();
}

export class ParticipantResponseDto {
    userId!: number;
    displayName!: string | null;
    avatarUrl!: string | null;
    profileHydrated!: boolean;

    static from(participant: ParticipantView): ParticipantResponseDto {
        return { userId: participant.userId, displayName: participant.displayName, avatarUrl: participant.avatarUrl, profileHydrated: participant.profileHydrated };
    }
}

export class ConsultationResponseDto {
    id!: number;
    status!: string;
    doctor!: ParticipantResponseDto;
    patient!: ParticipantResponseDto;
    consultationType!: { id: number; name: string; durationMinutes: number };
    startsAt!: string;
    endsAt!: string;
    startsAtLocal!: string;
    endsAtLocal!: string;
    timezone!: string;
    patientTimezone!: string;
    price!: { amount: number; currency: string };
    complaintText?: string;
    joinedAt!: string | null;
    startedAt!: string | null;
    completedAt!: string | null;
    cancelledAt!: string | null;
    cancelledBy!: string | null;
    cancelReason!: string | null;
    needsAdminFollowup!: boolean;
    followupReason!: string | null;
    followUpOfRecordId!: number | null;
    hasRecord!: boolean;
    createdAt!: string;
    updatedAt!: string;

    /**
     * Viewer-aware: an admin never receives `complaintText`, and neither does any viewer unless `view.detail` is set (get-one and
     * the actor's own write responses). A viewer who is neither participant nor admin is a programming error (the ownership
     * policy already answered 404). `room_id`, the idempotency columns, reminder marks and `cancelled_by_user_id` are never emitted.
     */
    static from(entity: Consultation, viewer: ConsultationViewer, view: ConsultationView): ConsultationResponseDto {
        const permitted = viewer.role === "admin" || (viewer.role === "patient" && viewer.userId === entity.patientUserId)
            || (viewer.role === "doctor" && viewer.userId === entity.doctorUserId);
        if (!permitted) throw new Error("consultation_viewer_not_permitted");
        const dto: ConsultationResponseDto = {
            id: entity.id, status: entity.status, doctor: ParticipantResponseDto.from(view.doctor), patient: ParticipantResponseDto.from(view.patient),
            consultationType: { id: entity.consultationTypeId, name: entity.consultationTypeName,
                durationMinutes: Math.round((entity.endsAt.getTime() - entity.startsAt.getTime()) / MINUTE_MS) },
            startsAt: entity.startsAt.toISOString(), endsAt: entity.endsAt.toISOString(),
            startsAtLocal: toIsoInZone(entity.startsAt.getTime(), view.timezone), endsAtLocal: toIsoInZone(entity.endsAt.getTime(), view.timezone),
            timezone: view.timezone, patientTimezone: entity.patientTimezone, price: { amount: entity.price, currency: entity.currency },
            joinedAt: iso(entity.joinedAt), startedAt: iso(entity.startedAt), completedAt: iso(entity.completedAt), cancelledAt: iso(entity.cancelledAt),
            cancelledBy: entity.cancelledBy, cancelReason: entity.cancelReason, needsAdminFollowup: entity.needsAdminFollowup,
            followupReason: entity.followupReason, followUpOfRecordId: entity.followUpOfRecordId, hasRecord: false,
            createdAt: entity.createdAt.toISOString(), updatedAt: entity.updatedAt.toISOString(),
        };
        if (view.detail && viewer.role !== "admin") dto.complaintText = entity.complaintText;
        return dto;
    }
}
