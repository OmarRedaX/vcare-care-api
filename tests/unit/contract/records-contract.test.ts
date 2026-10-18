import "reflect-metadata";
import { MedicalRecordAmendmentResponseDto, MedicalRecordResponseDto, PatientTimelineResponseDto } from "../../../src/app/records/dto/records.response.dto";
import * as constants from "../../../src/app/records/constants";
import * as errors from "../../../src/app/records/errors";
import { RecordAuditAction } from "../../../src/app/records/enums";
import { ERROR_CODES } from "../../../src/lib/error/types";
import { amendmentEntity, recordEntity } from "../app/records/records.fixtures";
import { contractErrorCodes, contractOperationBlock, contractResponseCodes, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";

type Method = "get" | "post" | "patch";
/** [operationId, path, method, roles, ownership, response codes, audit class, audit actions] */
const OPERATIONS: Array<[string, string, Method, string[], string, string[], string, string[]]> = [
    ["createMedicalRecord", "/api/consultations/{id}/record", "post", ["doctor"], "assigned-doctor", ["201", "400", "401", "403", "404", "409", "429", "500"], "clinical-write", ["record.created"]],
    ["getMedicalRecord", "/api/records/{id}", "get", ["patient", "doctor"], "consulted-patient-or-self", ["200", "400", "401", "403", "404", "429", "500"], "clinical-read", ["record.read"]],
    ["updateMedicalRecord", "/api/records/{id}", "patch", ["doctor"], "assigned-doctor", ["200", "201", "400", "401", "403", "404", "409", "429", "500"], "clinical-write", ["record.updated", "record.amended"]],
    ["listPatientRecords", "/api/patients/{patientUserId}/records", "get", ["patient", "doctor"], "consulted-patient-or-self", ["200", "400", "401", "403", "404", "429", "500"], "clinical-read", ["patient_records.listed"]],
];

/** Property names declared one level under `properties:` of a schema block. */
function propertyNames(block: string): string[] {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex((line) => line === "      properties:");
    if (start < 0) throw new Error("no properties block");
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim().length > 0 && !line.startsWith("        ")) break;
        const match = /^ {8}([A-Za-z]+):\s*$/.exec(line);
        if (match?.[1] !== undefined) names.push(match[1]);
    }
    return names;
}

describe("records contract", () => {
    it.each(OPERATIONS)("should declare %s with its roles, ownership, response set, audit class and no Idempotency-Key parameter", (operationId, path, method, roles, ownership, codes, auditClass, actions) => {
        const block = contractOperationBlock(path, method);
        expect(block).toContain(`operationId: ${operationId}`);
        expect(block).toContain("bearerUser");
        expect(inlineLists(block, "x-roles")).toEqual([roles]);
        expect(block).toContain(`x-ownership: ${ownership}`);
        expect([...contractResponseCodes(path, method)].sort()).toEqual([...codes].sort());
        expect(block).toContain(`x-audit: ${auditClass}`);
        expect(inlineLists(block, "x-audit-actions")).toEqual([actions]);
        expect(block).not.toContain("components/parameters/IdempotencyKey");
        expect(contractResponseCodes(path, method)).not.toContain("422");
    });

    it("should never list the admin role on any record operation", () => {
        for (const [, path, method] of OPERATIONS) expect(inlineLists(contractOperationBlock(path, method), "x-roles")[0]).not.toContain("admin");
    });

    it("should declare the account state of the reads (a locally suspended doctor gets 404) and of the writes (not locally suspended)", () => {
        expect(contractOperationBlock("/api/records/{id}", "get")).toContain("x-account-state: 'status active; a locally suspended doctor receives 404'");
        expect(contractOperationBlock("/api/patients/{patientUserId}/records", "get")).toContain("x-account-state: 'status active; a locally suspended doctor receives 404'");
        expect(contractOperationBlock("/api/consultations/{id}/record", "post")).toContain("x-account-state: 'status active; not locally suspended'");
        expect(contractOperationBlock("/api/records/{id}", "patch")).toContain("x-account-state: 'status active; not locally suspended'");
    });

    it("should state the per-user rate limits the limiters enforce", () => {
        expect(contractOperationBlock("/api/consultations/{id}/record", "post")).toContain(`Rate limit ${constants.RECORDS_WRITE_USER_LIMIT} record writes/min per user`);
        expect(contractOperationBlock("/api/records/{id}", "patch")).toContain(`Rate limit ${constants.RECORDS_WRITE_USER_LIMIT} record writes/min per user`);
        expect(contractOperationBlock("/api/records/{id}", "get")).toContain(`Rate limit ${constants.RECORDS_READ_USER_LIMIT} record reads/min per user`);
        expect(contractOperationBlock("/api/patients/{patientUserId}/records", "get")).toContain(`Rate limit ${constants.RECORDS_TIMELINE_USER_LIMIT} timeline reads/min per user`);
    });

    it("should document the check order of create and patch, the no-op, the amendment, the lock and the trigger refusal", () => {
        const create = contractOperationBlock("/api/consultations/{id}/record", "post");
        for (const text of ["`403 NotAssignedDoctor`", "`409 RecordRequiresCompleted`", "`409 Conflict`", "a retried create after a lost response is", "locked_at = created_at + 24 h"]) expect(create).toContain(text);
        const patch = contractOperationBlock("/api/records/{id}", "patch");
        for (const text of ["no-op", "no write and no audit row", "`reason` is ignored", "always appended", "a `reason`-only or empty body is `400`", "cannot be cleared to null", "`409 RecordLocked`"]) expect(patch).toContain(text);
    });

    it("should document the timeline: newest first, one audit row per call, failing audit fails the read, nullable patient", () => {
        const block = contractOperationBlock("/api/patients/{patientUserId}/records", "get");
        for (const text of ["newest first", "`patient_records.listed`", "if it fails the read fails", "`data.patient` is `null`", "`me` or any non-numeric id"]) expect(block).toContain(text);
        expect(block).toContain("components/parameters/Cursor");
        expect(block).toContain("components/parameters/Limit");
        expect(block).toContain("CacheControlNoStore");
        expect(block).toContain("components/schemas/PaginationMeta");
    });

    it("should declare 409 RecordLocked on the patch and the recorded-write conflict set on create, with no in-flight Retry-After", () => {
        expect(contractOperationBlock("/api/records/{id}", "patch")).toContain("#/components/responses/RecordLocked");
        expect(responseBlock("RecordLocked")).toContain("code: RecordLocked");
        expect(responseBlock("RecordLocked")).toContain("an in-place edit was refused");
        const conflict = responseBlock("RecordCreateConflict");
        expect(conflict).toContain("RecordRequiresCompleted");
        expect(conflict).toContain("`Conflict`");
        expect(conflict).not.toContain("Retry-After");
        expect(conflict).not.toContain("in-flight");
        expect(responseBlock("RecordWriteForbidden")).toContain("NotAssignedDoctor");
    });

    it("should send no-store on the success responses that carry clinical text", () => {
        for (const name of ["MedicalRecordOk", "MedicalRecordCreated"]) expect(responseBlock(name)).toContain("CacheControlNoStore");
        expect(contractOperationBlock("/api/records/{id}", "patch")).toContain("CacheControlNoStore");
    });

    it("should declare every error owned by records in the ErrorCode enum with the contract status", () => {
        const declared = contractErrorCodes();
        for (const value of Object.values(errors)) {
            const code = (value as { code?: string }).code;
            if (code !== undefined) expect(declared).toContain(code);
        }
        expect([errors.NotAssignedDoctor.status, errors.RecordRequiresCompleted.status, errors.RecordLocked.status, errors.RecordAlreadyExists.status]).toEqual([403, 409, 409, 409]);
        expect(errors.RecordAlreadyExists.code).toBe("Conflict");
        expect([errors.EmptyRecordUpdate.code, errors.ReasonRequiredAfterLock.code]).toEqual(["ValidationFailed", "ValidationFailed"]);
        for (const code of ["NotAssignedDoctor", "RecordRequiresCompleted", "RecordLocked"]) expect(ERROR_CODES).toContain(code);
        expect([...contractErrorCodes()].sort()).toEqual([...ERROR_CODES].sort());
    });

    it("should use the audit action names the contract lists", () => {
        expect(Object.values(RecordAuditAction).sort()).toEqual(["patient_records.listed", "record.amended", "record.created", "record.read", "record.updated"]);
    });
});

describe("records schemas", () => {
    it("should require every MedicalRecord member the DTO emits and no other", () => {
        const required = inlineLists(schemaBlock("MedicalRecord"), "required")[0] ?? [];
        const dto = MedicalRecordResponseDto.from(recordEntity(), [], { userId: 202, role: "doctor" });
        expect([...required].sort()).toEqual(Object.keys(dto).sort());
        expect(propertyNames(schemaBlock("MedicalRecord")).sort()).toEqual(Object.keys(dto).sort());
    });

    it("should describe the amendment members the DTO emits, with reason required and the amended fields nullable", () => {
        const block = schemaBlock("MedicalRecordAmendment");
        const dto = MedicalRecordAmendmentResponseDto.from(amendmentEntity(), { userId: 202, role: "doctor" });
        expect(propertyNames(block).sort()).toEqual(Object.keys(dto).sort());
        expect(inlineLists(block, "required")[0]).toEqual(["id", "recordId", "authorUserId", "reason", "createdAt"]);
    });

    it("should describe the timeline as a required nullable patient plus the records the DTO emits", () => {
        const block = schemaBlock("PatientTimeline");
        expect(inlineLists(block, "required")[0]).toEqual(["patient", "records"]);
        expect(block).toContain("- $ref: '#/components/schemas/PatientProfile'");
        expect(block).toContain("- type: 'null'");
        const dto = PatientTimelineResponseDto.from(null, [], { userId: 202, role: "doctor" });
        expect(propertyNames(block).sort()).toEqual(Object.keys(dto).sort());
    });

    it("should state attachments as always empty in this unit and the lock flag as database time", () => {
        const block = schemaBlock("MedicalRecord");
        expect(block).toContain("Always `[]` until the `record-attachments` module ships");
        expect(block).toContain("Computed with database time at read");
    });

    it("should bound the create and patch bodies exactly as the request DTOs do", () => {
        for (const name of ["MedicalRecordCreate", "MedicalRecordPatch"]) {
            const block = schemaBlock(name);
            expect(block).toContain("additionalProperties: false");
            expect(block).toContain(`maxLength: ${constants.CHIEF_COMPLAINT_MAX_LENGTH}`);
            expect(block).toContain(`maxLength: ${constants.NOTES_MAX_LENGTH}`);
            expect(block).toContain(`maxLength: ${constants.DIAGNOSIS_TEXT_MAX_LENGTH}`);
            expect(block).toContain(`minimum: ${constants.FOLLOW_UP_MIN_DAYS}`);
            expect(block).toContain(`maximum: ${constants.FOLLOW_UP_MAX_DAYS}`);
            expect(block).toContain(`pattern: '${constants.DIAGNOSIS_CODE_PATTERN.source}'`);
        }
        expect(inlineLists(schemaBlock("MedicalRecordCreate"), "required")[0]).toEqual(["chiefComplaint"]);
        expect(schemaBlock("MedicalRecordCreate")).toContain(`minLength: ${constants.CHIEF_COMPLAINT_MIN_LENGTH}`);
        const patch = schemaBlock("MedicalRecordPatch");
        expect(patch).toContain("minProperties: 1");
        expect(patch).toContain(`minLength: ${constants.AMENDMENT_REASON_MIN_LENGTH}`);
        expect(patch).toContain(`maxLength: ${constants.AMENDMENT_REASON_MAX_LENGTH}`);
        expect(propertyNames(schemaBlock("MedicalRecordCreate"))).toEqual(["chiefComplaint", "examinationNotes", "diagnosisText", "diagnosisCode", "treatmentPlan", "followUpInDays"]);
        expect(propertyNames(patch)).toEqual(["chiefComplaint", "examinationNotes", "diagnosisText", "diagnosisCode", "treatmentPlan", "followUpInDays", "reason"]);
    });
});

describe("records edits to the consultation contract", () => {
    it("should no longer reject followUpOfRecordId on booking and say it is a live record of this patient with the chosen doctor", () => {
        const block = contractOperationBlock("/api/consultations", "post");
        expect(block).not.toContain("until the records module ships");
        expect(block).toContain("followUpOfRecordId");
        expect(schemaBlock("ConsultationCreate")).toContain("followUpOfRecordId");
    });

    it("should describe hasRecord as true when a live record exists", () => {
        expect(schemaBlock("Consultation")).toContain("True when a live medical record exists for the consultation");
    });
});
