import * as errors from "../../../src/app/sessions/errors";
import { CALENDAR_MAX_WINDOW_DAYS, NO_SHOW_NOTE_MAX_LENGTH } from "../../../src/app/sessions/constants";
import { ERROR_CODES } from "../../../src/lib/error/types";
import { contractErrorCodes, contractOperationBlock, contractResponseCodes, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";

type Method = "get" | "patch";
/** [operationId, path, method, roles, ownership, response codes] */
const OPERATIONS: Array<[string, string, Method, string[], string, string[]]> = [
    ["joinConsultation", "/api/consultations/{id}/join", "patch", ["patient", "doctor"], "participant", ["200", "401", "403", "404", "409", "429", "500", "503"]],
    ["startConsultation", "/api/consultations/{id}/start", "patch", ["doctor"], "assigned-doctor", ["200", "401", "403", "404", "409", "429", "500", "503"]],
    ["completeConsultation", "/api/consultations/{id}/complete", "patch", ["doctor"], "assigned-doctor", ["200", "401", "403", "404", "409", "429", "500"]],
    ["markNoShow", "/api/consultations/{id}/no-show", "patch", ["doctor", "admin"], "assigned-doctor-or-admin", ["200", "400", "401", "403", "404", "409", "429", "500"]],
    ["getWaitingRoom", "/api/consultations/waiting-room", "get", ["doctor"], "self", ["200", "401", "403", "429", "500"]],
    ["getCalendar", "/api/consultations/calendar", "get", ["doctor"], "self", ["200", "400", "401", "403", "429", "500"]],
];

describe("sessions contract", () => {
    it.each(OPERATIONS)("should declare %s with its roles, ownership and response set and no Idempotency-Key", (operationId, path, method, roles, ownership, codes) => {
        const block = contractOperationBlock(path, method);
        expect(block).toContain(`operationId: ${operationId}`);
        expect(block).toContain("bearerUser");
        expect(inlineLists(block, "x-roles")).toEqual([roles]);
        expect(block).toContain(`x-ownership: ${ownership}`);
        expect([...contractResponseCodes(path, method)].sort()).toEqual([...codes].sort());
        expect(block).not.toContain("Idempotency");
    });

    it("should declare the audit actions of the status changes and the no-show audit class", () => {
        const actions = (path: string): string[] => inlineLists(contractOperationBlock(path, "patch"), "x-audit-actions")[0] ?? [];
        expect(actions("/api/consultations/{id}/join")).toEqual(["consultation.waiting"]);
        expect(actions("/api/consultations/{id}/start")).toEqual(["consultation.started"]);
        expect(actions("/api/consultations/{id}/complete")).toEqual(["consultation.completed"]);
        expect(actions("/api/consultations/{id}/no-show")).toEqual(["consultation.no_show"]);
        expect(contractOperationBlock("/api/consultations/{id}/no-show", "patch")).toContain("x-audit: admin-action");
    });

    it("should declare the 503 VideoUnavailable response on join and start only, and list the code", () => {
        for (const path of ["/api/consultations/{id}/join", "/api/consultations/{id}/start"]) {
            expect(contractOperationBlock(path, "patch")).toContain("#/components/responses/VideoUnavailable");
        }
        expect(responseBlock("VideoUnavailable")).toContain("code: VideoUnavailable");
        expect(contractErrorCodes()).toContain("VideoUnavailable");
        expect(ERROR_CODES).toContain("VideoUnavailable");
    });

    it("should keep the ErrorCode enum and the runtime code list identical", () => {
        expect([...contractErrorCodes()].sort()).toEqual([...ERROR_CODES].sort());
    });

    it("should declare every error owned by sessions in the ErrorCode enum with the contract status", () => {
        const declared = contractErrorCodes();
        for (const value of Object.values(errors)) {
            const code = (value as { code?: string }).code;
            if (code !== undefined) expect(declared).toContain(code);
        }
        expect(errors.RoomNotOpen.status).toBe(409);
        expect(errors.NoShowTooEarly.status).toBe(409);
        expect(errors.VideoUnavailable.status).toBe(503);
    });

    it("should document the half-open window, the check order and the doctor join on booked", () => {
        const join = contractOperationBlock("/api/consultations/{id}/join", "patch");
        expect(join).toContain("opensAt <= now < closesAt");
        expect(join).toContain("terminal → `409");
        expect(join).toContain("A doctor joining a `booked`");
        const start = contractOperationBlock("/api/consultations/{id}/start", "patch");
        expect(start).toContain("opensAt <= now < closesAt");
        expect(start).toContain("before the window check");
        expect(contractOperationBlock("/api/consultations/waiting-room", "get")).toContain("opensAt <= now < closesAt");
    });

    it("should document the calendar window and require from and to", () => {
        const block = contractOperationBlock("/api/consultations/calendar", "get");
        for (const name of ["from", "to", "timezone"]) expect(block).toContain(`name: ${name}`);
        expect(block).toContain(`${CALENDAR_MAX_WINDOW_DAYS} days inclusive`);
        expect(block).toContain("[from, to)");
        expect(block).toContain("doctor-local");
    });

    it("should declare the SessionJoin, NoShow and CalendarView shapes the DTOs produce", () => {
        expect(inlineLists(schemaBlock("SessionJoin"), "required")[0]).toEqual(["consultation", "roomId", "joinToken", "joinTokenExpiresAt", "windowOpensAt", "windowClosesAt"]);
        expect(inlineLists(schemaBlock("CalendarView"), "required")[0]).toEqual(["from", "to", "timezone", "consultations", "exceptions"]);
        const noShow = schemaBlock("NoShow");
        expect(noShow).toContain("additionalProperties: false");
        expect(noShow).toContain(`maxLength: ${NO_SHOW_NOTE_MAX_LENGTH}`);
        expect(noShow).not.toContain("required:");
        expect(schemaBlock("Consultation")).toContain("Session responses");
    });

    it("should send no-store on the session success responses", () => {
        expect(responseBlock("SessionJoinOk")).toContain("CacheControlNoStore");
        expect(responseBlock("ConsultationOk")).toContain("CacheControlNoStore");
        expect(contractOperationBlock("/api/consultations/waiting-room", "get")).toContain("CacheControlNoStore");
        expect(contractOperationBlock("/api/consultations/calendar", "get")).toContain("CacheControlNoStore");
    });
});
