import type { HydratedUser } from "../../lib/identity-client/types";
import type { Consultation } from "./entity/consultation.entity";
import type { ConsultationView, ConsultationViewer, ParticipantView, ViewContext } from "./types";

/** A participant Care knows only by id: no name, no avatar, `profileHydrated: false`. */
export function unhydratedParticipant(userId: number): ParticipantView {
    return { userId, displayName: null, avatarUrl: null, profileHydrated: false };
}

/** Identity's `fullName` is exposed as `displayName` (Case 2 mapping); `status` is never exposed. A miss degrades to unhydrated. */
export function hydratedParticipant(userId: number, users: ReadonlyMap<number, HydratedUser>): ParticipantView {
    const user = users.get(userId);
    return user === undefined ? unhydratedParticipant(userId)
        : { userId, displayName: user.displayName, avatarUrl: user.avatarUrl, profileHydrated: true };
}

/** The counterpart's user id for a patient or doctor viewer; both ids for an admin (hydrated for the user ids returned). */
export function userIdsToHydrate(viewer: ConsultationViewer, consultation: Consultation): number[] {
    if (viewer.role === "patient") return [consultation.doctorUserId];
    if (viewer.role === "doctor") return [consultation.patientUserId];
    return [consultation.doctorUserId, consultation.patientUserId];
}

/**
 * How one consultation is rendered for one viewer. Zone: the `timezone` query when given, else the patient's snapshot for a
 * patient, the doctor's own zone for a doctor, `UTC` for an admin. The viewer's own side is never hydrated (decision 1.5.5).
 */
export function buildConsultationView(consultation: Consultation, viewer: ConsultationViewer, context: ViewContext,
    users: ReadonlyMap<number, HydratedUser>, detail: boolean): ConsultationView {
    const defaultZone = viewer.role === "patient" ? consultation.patientTimezone : viewer.role === "doctor" ? context.doctorTimezone ?? "UTC" : "UTC";
    return {
        timezone: context.timezone ?? defaultZone, detail,
        doctor: viewer.role === "doctor" ? unhydratedParticipant(consultation.doctorUserId) : hydratedParticipant(consultation.doctorUserId, users),
        patient: viewer.role === "patient" ? unhydratedParticipant(consultation.patientUserId) : hydratedParticipant(consultation.patientUserId, users),
    };
}
