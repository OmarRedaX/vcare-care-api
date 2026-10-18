import * as errors from "../../../src/app/consultations/errors";
import { CancelledBy, ConsultationStatus, FollowupReason } from "../../../src/app/consultations/enums";
import {
    COMPLAINT_MAX_LENGTH, COMPLAINT_MIN_LENGTH, REASON_MAX_LENGTH, REASON_MIN_LENGTH, TIMEZONE_MAX_LENGTH,
} from "../../../src/app/consultations/constants";
import { contractErrorCodes, contractOperationBlock, contractResponseCodes, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";

type Method = "get" | "post" | "patch";
/** [operationId, path, method, roles, ownership, audit class, response codes, idempotency key required] */
const OPERATIONS: Array<[string, string, Method, string[], string, string, string[], boolean]> = [
    ["bookConsultation", "/api/consultations", "post", ["patient"], "self", "", ["201", "400", "401", "403", "404", "409", "422", "429", "500"], true],
    ["listConsultations", "/api/consultations", "get", ["patient", "doctor", "admin"], "participant-or-admin", "", ["200", "400", "401", "403", "429", "500"], false],
    ["getConsultation", "/api/consultations/{id}", "get", ["patient", "doctor", "admin"], "participant-or-admin", "clinical-read", ["200", "400", "401", "403", "404", "429", "500"], false],
    ["rescheduleConsultation", "/api/consultations/{id}/reschedule", "patch", ["patient", "admin"], "patient-owner-or-admin", "admin-action", ["200", "400", "401", "403", "404", "409", "422", "429", "500"], true],
    ["cancelConsultation", "/api/consultations/{id}/cancel", "patch", ["patient", "doctor", "admin"], "participant-or-admin", "admin-action", ["200", "400", "401", "403", "404", "409", "422", "429", "500"], true],
    ["getPatientProfile", "/api/patients/{patientUserId}", "get", ["patient", "doctor"], "consulted-patient-or-self", "clinical-read", ["200", "401", "403", "404", "429", "500"], false],
];

describe("consultations contract", () => {
    it.each(OPERATIONS)("should declare %s with its roles, ownership, audit class and response set", (operationId, path, method, roles, ownership, audit, codes, keyRequired) => {
        const block = contractOperationBlock(path, method);
        expect(block).toContain(`operationId: ${operationId}`);
        expect(block).toContain("bearerUser");
        expect(inlineLists(block, "x-roles")).toEqual([roles]);
        expect(block).toContain(`x-ownership: ${ownership}`);
        if (audit === "") expect(block).not.toContain("x-audit: ");
        else expect(block).toContain(`x-audit: ${audit}`);
        expect([...contractResponseCodes(path, method)].sort()).toEqual([...codes].sort());
        expect(block.includes("IdempotencyKeyRequired")).toBe(keyRequired);
        expect(block).not.toContain("IdempotencyKeyOptional");
    });

    it("should declare the audit actions per operation", () => {
        const actions = (path: string, method: Method): string[] => inlineLists(contractOperationBlock(path, method), "x-audit-actions")[0] ?? [];
        expect(actions("/api/consultations", "post")).toEqual(["consultation.booked"]);
        expect(actions("/api/consultations/{id}", "get")).toEqual(["consultation.read"]);
        expect(actions("/api/consultations/{id}/reschedule", "patch")).toEqual(["consultation.rescheduled"]);
        expect(actions("/api/consultations/{id}/cancel", "patch")).toEqual(["consultation.cancelled"]);
        expect(actions("/api/patients/{patientUserId}", "get")).toEqual(["patient_profile.read"]);
    });

    it("should require an email-verified active patient to book", () => {
        expect(contractOperationBlock("/api/consultations", "post")).toContain("x-account-state: 'status active; emailVerified true'");
    });

    it("should mark the three write responses and the conflicts as carrying Retry-After for the in-flight Conflict", () => {
        for (const name of ["BookingConflict", "RescheduleConflict", "CancelConflict"]) {
            const block = responseBlock(name);
            expect(block).toContain("Retry-After");
            expect(block).toContain("`Conflict`");
        }
        expect(responseBlock("BookingConflict")).toContain("DoctorNotBookable");
        expect(responseBlock("BookingConflict")).toContain("SlotUnavailable");
        expect(responseBlock("RescheduleConflict")).toContain("PolicyWindowViolation");
        expect(responseBlock("RescheduleConflict")).toContain("InvalidTransition");
        expect(responseBlock("CancelConflict")).toContain("PolicyWindowViolation");
        expect(responseBlock("BookingUnprocessable")).toContain("OutsideWorkingHours");
        expect(responseBlock("BookingUnprocessable")).toContain("BookingInPast");
        expect(responseBlock("BookingUnprocessable")).toContain("BeyondBookingHorizon");
        expect(responseBlock("BookingForbidden")).toContain("EmailNotVerified");
    });

    it("should send no-store on every success response of the consultation operations", () => {
        expect(responseBlock("ConsultationOk")).toContain("CacheControlNoStore");
        expect(responseBlock("PatientProfileOk")).toContain("CacheControlNoStore");
        for (const [, path, method, , , , codes] of OPERATIONS.filter(([id]) => id === "bookConsultation" || id === "listConsultations")) {
            const success = codes[0] ?? "";
            expect(contractOperationBlock(path, method)).toMatch(new RegExp(`'${success}':[\\s\\S]*?CacheControlNoStore`));
        }
    });

    it("should declare the Consultation required members and the Participant shape", () => {
        expect(inlineLists(schemaBlock("Consultation"), "required")[0]).toEqual([
            "id", "status", "doctor", "patient", "consultationType", "startsAt", "endsAt", "startsAtLocal", "endsAtLocal", "timezone",
            "patientTimezone", "price", "joinedAt", "startedAt", "completedAt", "cancelledAt", "cancelledBy", "cancelReason", "needsAdminFollowup", "followupReason",
            "followUpOfRecordId", "hasRecord", "createdAt", "updatedAt"]);
        expect(schemaBlock("Participant")).toContain("#/components/schemas/HydratedUserFields");
        expect(inlineLists(schemaBlock("Participant"), "required")[0]).toEqual(["userId"]);
        expect(inlineLists(schemaBlock("HydratedUserFields"), "required")[0]).toEqual(["displayName", "avatarUrl", "profileHydrated"]);
    });

    it("should keep the contract enums identical to the database-backed code enums", () => {
        expect(inlineLists(schemaBlock("ConsultationStatus"), "enum")[0]).toEqual(Object.values(ConsultationStatus));
        const consultation = schemaBlock("Consultation");
        expect(inlineLists(consultation, "enum")).toContainEqual([...Object.values(CancelledBy), "null"]);
        expect(inlineLists(consultation, "enum")).toContainEqual([...Object.values(FollowupReason), "null"]);
    });

    it("should reject unknown request members and agree with the validators on lengths", () => {
        for (const name of ["ConsultationCreate", "Reschedule", "Cancel"]) expect(schemaBlock(name)).toContain("additionalProperties: false");
        expect(inlineLists(schemaBlock("ConsultationCreate"), "required")[0]).toEqual(["doctorId", "typeId", "startsAt", "complaintText", "patientTimezone"]);
        expect(inlineLists(schemaBlock("Reschedule"), "required")[0]).toEqual(["startsAt"]);
        expect(schemaBlock("Cancel")).not.toContain("required:");
        const create = schemaBlock("ConsultationCreate");
        expect(create).toContain(`minLength: ${COMPLAINT_MIN_LENGTH}`);
        expect(create).toContain(`maxLength: ${COMPLAINT_MAX_LENGTH}`);
        expect(create).toContain(`maxLength: ${TIMEZONE_MAX_LENGTH}`);
        for (const name of ["Reschedule", "Cancel"]) {
            expect(schemaBlock(name)).toContain(`minLength: ${REASON_MIN_LENGTH}`);
            expect(schemaBlock(name)).toContain(`maxLength: ${REASON_MAX_LENGTH}`);
        }
    });

    it("should declare every Care-owned consultation error code in the ErrorCode enum", () => {
        const declared = contractErrorCodes();
        for (const value of Object.values(errors)) {
            const code = (value as { code?: string }).code;
            if (code !== undefined) expect(declared).toContain(code);
        }
    });

    it("should document the list query parameters and the admin-only filters", () => {
        const block = contractOperationBlock("/api/consultations", "get");
        for (const name of ["scope", "status", "from", "to", "doctorUserId", "patientUserId", "needsAdminFollowup", "timezone"]) expect(block).toContain(`name: ${name}`);
        expect(inlineLists(block, "enum")[0]).toEqual(["upcoming", "past", "all"]);
        expect(block).toContain("`403 Forbidden`");
    });
});
