import "reflect-metadata";
import { ConsultationResponseDto } from "../../../../src/app/consultations/dto/consultations.response.dto";
import { Consultation } from "../../../../src/app/consultations/entity/consultation.entity";
import { ConsultationStatus } from "../../../../src/app/consultations/enums";
import { buildConsultationView } from "../../../../src/app/consultations/view";
import { CalendarQueryDto, NoShowDto } from "../../../../src/app/sessions/dto/sessions.request.dto";
import { CalendarViewResponseDto, SessionJoinResponseDto } from "../../../../src/app/sessions/dto/sessions.response.dto";
import { ScheduleException } from "../../../../src/app/schedules/entity/schedule-exception.entity";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";

const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const TOKEN = "SYNTHETIC-TOKEN-9917";
const STARTS = Date.parse("2030-01-01T10:00:00Z");

async function fields(run: () => Promise<unknown>): Promise<string[]> {
    try { await run(); } catch (error) { return (error as AppError).details.map((detail) => detail.field); }
    throw new Error("expected validation to fail");
}

const entity = (): Consultation => new Consultation({
    id: 7, doctorUserId: 202, patientUserId: 101, consultationTypeId: 3, consultationTypeName: "Synthetic Visit", startsAt: new Date(STARTS),
    endsAt: new Date(STARTS + 1_800_000), status: ConsultationStatus.Waiting, complaintText: COMPLAINT, patientTimezone: "America/New_York", price: 15000,
    currency: "EGP", roomId: "room-7", joinedAt: new Date(STARTS - 120_000), startedAt: null, completedAt: null, cancelledAt: null, cancelReason: null, cancelledBy: null, needsAdminFollowup: false, followupReason: null, followUpOfRecordId: null,
    createdAt: new Date(STARTS - 86_400_000), updatedAt: new Date(STARTS - 60_000),
});

describe("NoShowDto", () => {
    it.each([[{}], [{ note: "" }], [{ note: "   " }], [{ note: "a".repeat(1000) }], [{ note: "م".repeat(1000) }]])("should accept %j", async (body) => {
        await expect(validateBody(NoShowDto, body)).resolves.toBeDefined();
    });

    it.each([
        ["note", { note: "a".repeat(1001) }], ["note", { note: "bad\u0000note" }], ["note", { note: 5 }], ["note", { note: null }], ["reason", { reason: "x" }],
    ])("should reject a body whose %s is invalid or unknown", async (field, body) => {
        expect(await fields(() => validateBody(NoShowDto, body))).toContain(field);
    });

    it("should pass the note through untouched", async () => {
        expect((await validateBody(NoShowDto, { note: "SYNTHETIC-NOTE" })).toInput()).toEqual({ note: "SYNTHETIC-NOTE" });
        expect((await validateBody(NoShowDto, {})).toInput()).toEqual({ note: undefined });
    });
});

describe("CalendarQueryDto", () => {
    const valid = { from: "2030-01-01T00:00:00+02:00", to: "2030-01-02T00:00:00+02:00" };

    it("should map the instants to milliseconds and canonicalize the zone", async () => {
        const dto = await validateQuery(CalendarQueryDto, { ...valid, timezone: "america/new_york" });
        expect(dto.toQuery()).toEqual({ fromMs: Date.parse("2029-12-31T22:00:00Z"), toMs: Date.parse("2030-01-01T22:00:00Z"), timezone: "America/New_York" });
        expect((await validateQuery(CalendarQueryDto, valid)).toQuery().timezone).toBeUndefined();
    });

    it.each([
        ["from", { from: undefined }], ["to", { to: undefined }], ["from", { from: "2030-01-01T00:00:00" }], ["to", { to: "not-a-date" }],
        ["timezone", { timezone: "Mars/Olympus" }], ["limit", { limit: "5" }],
    ])("should reject a query whose %s is missing, invalid or unknown", async (field, change) => {
        expect(await fields(() => validateQuery(CalendarQueryDto, { ...valid, ...change }))).toContain(field);
    });
});

describe("session response DTOs", () => {
    const patientViewer = { userId: 101, role: "patient" as const };
    const doctorViewer = { userId: 202, role: "doctor" as const };
    const unhydrated = (viewer: typeof patientViewer | typeof doctorViewer) => buildConsultationView(entity(), viewer, { timezone: undefined, doctorTimezone: "Africa/Cairo" }, new Map(), false);

    it("should render the join result with ISO instants, no complaint text and unhydrated participants", () => {
        const dto = SessionJoinResponseDto.from({ consultation: entity(), roomId: "room-7", joinToken: TOKEN, joinTokenExpiresAt: new Date(STARTS + 300_000),
            windowOpensAt: new Date(STARTS - 600_000), windowClosesAt: new Date(STARTS + 2_700_000) }, patientViewer, unhydrated(patientViewer));
        expect(dto).toMatchObject({ roomId: "room-7", joinToken: TOKEN, joinTokenExpiresAt: "2030-01-01T10:05:00.000Z", windowOpensAt: "2030-01-01T09:50:00.000Z",
            windowClosesAt: "2030-01-01T10:45:00.000Z" });
        expect(dto.consultation).not.toHaveProperty("complaintText");
        expect(dto.consultation.doctor).toEqual({ userId: 202, displayName: null, avatarUrl: null, profileHydrated: false });
        expect(JSON.stringify(dto)).not.toContain(COMPLAINT);
        expect(dto.consultation.timezone).toBe("America/New_York");
    });

    it("should never emit the room id, idempotency columns or reminder marks on a consultation", () => {
        const json = JSON.stringify(ConsultationResponseDto.from(entity(), doctorViewer, unhydrated(doctorViewer)));
        expect(json).not.toContain("room-7");
        expect(json).not.toMatch(/roomId|idempotency|requestHash|reminder|noShowMarkedAt|cancelledByUserId/);
    });

    it("should render the calendar with from and to echoed in the render zone and exceptions on their doctor-local date", () => {
        const exception = new ScheduleException({ id: 4, date: "2030-01-01", type: "day_off" as never, startTime: null, endTime: null, reason: null, createdAt: new Date(STARTS) });
        const dto = CalendarViewResponseDto.from({ fromMs: Date.parse("2029-12-31T22:00:00Z"), toMs: Date.parse("2030-01-01T22:00:00Z"), timezone: "Africa/Cairo",
            items: [{ consultation: entity(), view: unhydrated(doctorViewer) }], exceptions: [exception] }, doctorViewer);
        expect(dto.from).toBe("2030-01-01T00:00:00+02:00");
        expect(dto.to).toBe("2030-01-02T00:00:00+02:00");
        expect(dto.timezone).toBe("Africa/Cairo");
        expect(dto.exceptions[0]).toMatchObject({ id: 4, date: "2030-01-01" });
        expect(dto.consultations[0]).not.toHaveProperty("complaintText");
    });
});
