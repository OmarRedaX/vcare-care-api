import "reflect-metadata";
import { CancelDto, ConsultationCreateDto, ListConsultationsQueryDto, RescheduleDto } from "../../../../src/app/consultations/dto/consultations.request.dto";
import { ConsultationResponseDto } from "../../../../src/app/consultations/dto/consultations.response.dto";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import type { ConsultationView } from "../../../../src/app/consultations/types";
import { buildConsultationView, hydratedParticipant, unhydratedParticipant, userIdsToHydrate } from "../../../../src/app/consultations/view";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";

const create = { doctorId: 202, typeId: 1, startsAt: "2030-03-01T10:00:00+02:00", complaintText: "SYNTHETIC-COMPLAINT", patientTimezone: "America/New_York" };

async function fields(run: () => Promise<unknown>): Promise<string[]> {
    try { await run(); } catch (error) { return (error as AppError).details.map((detail) => detail.field); }
    throw new Error("expected validation to fail");
}

describe("consultations request DTOs", () => {
    it("should map a valid booking body to an input with the instant in epoch milliseconds", async () => {
        const dto = await validateBody(ConsultationCreateDto, create);
        expect(dto.toInput()).toEqual({ doctorId: 202, typeId: 1, startsAtMs: Date.parse("2030-03-01T08:00:00Z"), complaintText: "SYNTHETIC-COMPLAINT",
            patientTimezone: "America/New_York", followUpOfRecordId: undefined });
    });

    it.each([
        ["doctorId", { doctorId: 0 }], ["doctorId", { doctorId: "202" }], ["typeId", { typeId: 1.5 }], ["startsAt", { startsAt: "2030-03-01T10:00:00" }],
        ["complaintText", { complaintText: "ab" }], ["complaintText", { complaintText: "   " }], ["complaintText", { complaintText: "a".repeat(4001) }],
        ["complaintText", { complaintText: "bad\u0000text" }], ["patientTimezone", { patientTimezone: "Mars/Olympus" }], ["followUpOfRecordId", { followUpOfRecordId: null }],
        ["endsAt", { endsAt: "2030-03-01T10:30:00+02:00" }],
    ])("should reject a booking body whose %s is invalid", async (field, change) => {
        expect(await fields(() => validateBody(ConsultationCreateDto, { ...create, ...change }))).toContain(field);
    });

    it("should accept newlines in the complaint and an optional followUpOfRecordId", async () => {
        const dto = await validateBody(ConsultationCreateDto, { ...create, complaintText: "line one\nline two", followUpOfRecordId: 9 });
        expect(dto.toInput()).toMatchObject({ followUpOfRecordId: 9 });
    });

    it("should validate reschedule and cancel reasons", async () => {
        expect((await validateBody(RescheduleDto, { startsAt: create.startsAt })).toInput().reason).toBeUndefined();
        expect(await fields(() => validateBody(RescheduleDto, { startsAt: create.startsAt, reason: "ab" }))).toContain("reason");
        expect(await fields(() => validateBody(RescheduleDto, {}))).toContain("startsAt");
        expect((await validateBody(CancelDto, {})).toInput()).toEqual({ reason: undefined });
        expect(await fields(() => validateBody(CancelDto, { reason: "   " }))).toContain("reason");
        expect(await fields(() => validateBody(CancelDto, { reason: "fine reason", extra: 1 }))).toContain("extra");
    });

    it("should default the list scope to upcoming, split and de-duplicate statuses and convert typed members", async () => {
        const query = (await validateQuery(ListConsultationsQueryDto, { status: "booked,booked,cancelled", doctorUserId: "5", needsAdminFollowup: "true", limit: "10" })).toQuery();
        expect(query).toMatchObject({ scope: "upcoming", statuses: ["booked", "cancelled"], doctorUserId: 5, needsAdminFollowup: true, limit: 10 });
    });

    it.each([
        ["scope", { scope: "soon" }], ["status", { status: "booked,bogus" }], ["status", { status: ["booked", "waiting"] }], ["status", { status: "a,b,c,d,e,f,g" }],
        ["from", { from: "2030-01-01" }], ["timezone", { timezone: "Nope/Zone" }], ["patientUserId", { patientUserId: "0" }], ["needsAdminFollowup", { needsAdminFollowup: "yes" }],
        ["unknown", { unknown: "1" }],
    ])("should reject a list query whose %s is invalid", async (field, change) => {
        expect(await fields(() => validateQuery(ListConsultationsQueryDto, change))).toContain(field);
    });
});

describe("ConsultationResponseDto and view", () => {
    const consultation = new Consultation({
        id: 7, doctorUserId: 202, patientUserId: 101, consultationTypeId: 1, consultationTypeName: "Synthetic Visit", startsAt: new Date("2026-10-25T00:30:00Z"),
        endsAt: new Date("2026-10-25T01:00:00Z"), status: "booked" as never, complaintText: "SYNTHETIC-COMPLAINT", patientTimezone: "America/New_York", price: 100,
        currency: "EGP", roomId: "ROOM-SECRET", joinedAt: null, startedAt: null, completedAt: null, cancelledAt: null, cancelReason: null, cancelledBy: null,
        cancelledByUserId: null, noShowMarkedAt: null, needsAdminFollowup: false, followupReason: null, followUpOfRecordId: null, reminder24hSentAt: null,
        reminder1hSentAt: null, idempotencyKey: "00000000-0000-4000-8000-000000000001", requestHash: "h".repeat(64), createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const users = new Map([[202, { displayName: "Dr Synthetic", avatarUrl: null, status: "active" as const }]]);
    const view = (viewer: { userId: number; role: "patient" | "doctor" | "admin" }, detail: boolean, timezone?: string): ConsultationView =>
        buildConsultationView(consultation, viewer, { timezone, doctorTimezone: "Europe/Berlin" }, users, detail);

    it("should omit complaint text for an admin and for list items, and include it for a participant with detail", () => {
        const patient = { userId: 101, role: "patient" as const };
        expect(ConsultationResponseDto.from(consultation, patient, view(patient, true))).toHaveProperty("complaintText", "SYNTHETIC-COMPLAINT");
        expect(ConsultationResponseDto.from(consultation, patient, view(patient, false))).not.toHaveProperty("complaintText");
        const admin = { userId: 303, role: "admin" as const };
        expect(ConsultationResponseDto.from(consultation, admin, view(admin, true))).not.toHaveProperty("complaintText");
    });

    it("should never emit the room, idempotency, hash or reminder columns", () => {
        const doctor = { userId: 202, role: "doctor" as const };
        const text = JSON.stringify(ConsultationResponseDto.from(consultation, doctor, view(doctor, true)));
        for (const secret of ["ROOM-SECRET", "idempotency", "requestHash", "h".repeat(64), "reminder", "cancelledByUserId", "roomId"]) expect(text).not.toContain(secret);
    });

    it("should default the render zone per role and honour an explicit zone for every role", () => {
        expect(view({ userId: 101, role: "patient" }, false).timezone).toBe("America/New_York");
        expect(view({ userId: 202, role: "doctor" }, false).timezone).toBe("Europe/Berlin");
        expect(view({ userId: 303, role: "admin" }, false).timezone).toBe("UTC");
        expect(view({ userId: 101, role: "patient" }, false, "Asia/Tokyo").timezone).toBe("Asia/Tokyo");
        const dto = ConsultationResponseDto.from(consultation, { userId: 202, role: "doctor" }, view({ userId: 202, role: "doctor" }, false));
        expect(dto.startsAtLocal).toBe("2026-10-25T02:30:00+02:00");
        expect(dto.endsAtLocal).toBe("2026-10-25T02:00:00+01:00");
        expect(dto.consultationType.durationMinutes).toBe(30);
    });

    it("should hydrate only the counterpart for a participant and both sides for an admin", () => {
        expect(view({ userId: 101, role: "patient" }, false)).toMatchObject({ doctor: { displayName: "Dr Synthetic", profileHydrated: true }, patient: { profileHydrated: false } });
        expect(view({ userId: 202, role: "doctor" }, false)).toMatchObject({ doctor: { profileHydrated: false }, patient: { userId: 101, profileHydrated: false } });
        expect(userIdsToHydrate({ userId: 101, role: "patient" }, consultation)).toEqual([202]);
        expect(userIdsToHydrate({ userId: 202, role: "doctor" }, consultation)).toEqual([101]);
        expect(userIdsToHydrate({ userId: 303, role: "admin" }, consultation)).toEqual([202, 101]);
        expect(hydratedParticipant(5, new Map())).toEqual(unhydratedParticipant(5));
    });

    it("should refuse a viewer who is neither participant nor admin", () => {
        expect(() => ConsultationResponseDto.from(consultation, { userId: 999, role: "patient" }, view({ userId: 999, role: "patient" }, false))).toThrow("consultation_viewer_not_permitted");
        expect(() => ConsultationResponseDto.from(consultation, { userId: 999, role: "doctor" }, view({ userId: 999, role: "doctor" }, false))).toThrow("consultation_viewer_not_permitted");
    });
});
