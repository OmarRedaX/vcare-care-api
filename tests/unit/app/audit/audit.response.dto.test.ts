import { AuditLogResponseDto } from "../../../../src/app/audit/dto/audit.response.dto";
import { AuditLog } from "../../../../src/app/audit/entity/audit-log.entity";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

const entry = (overrides: Partial<AuditLog> = {}): AuditLog =>
    new AuditLog({
        id: 9, actorUserId: 303, actorRole: "admin", action: "doctor.approved", entityType: "doctor_profile", entityId: 21,
        requestId: "9a0b7c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d", metadata: { fromStatus: "submitted", toStatus: "approved" },
        createdAt: new Date("2026-04-15T11:59:59.123Z"), ...overrides,
    });

describe("AuditLogResponseDto", () => {
    it("should produce exactly the nine contract keys and no other", () => {
        const [required = []] = inlineLists(schemaBlock("AuditLogEntry"), "required");
        expect(required).toHaveLength(9);
        const dto = AuditLogResponseDto.from(entry());
        expect(Object.keys(dto).sort()).toEqual([...required].sort());
    });

    it("should not expose an extra property carried by the entity", () => {
        const dto = AuditLogResponseDto.from(Object.assign(entry(), { cursorTimestamp: "x", password_hash: "y" }));
        expect(Object.keys(dto)).not.toContain("cursorTimestamp");
        expect(Object.keys(dto)).not.toContain("password_hash");
    });

    it("should copy metadata verbatim with null, number, boolean and string values", () => {
        const metadata = { fromStatus: "booked", consultationId: 1042, flag: true, off: false, note: null, reasonLength: 0 };
        const dto = AuditLogResponseDto.from(entry({ metadata }));
        expect(dto.metadata).toStrictEqual(metadata);
        expect(dto.metadata).not.toBe(metadata);
    });

    it("should return an empty metadata object as an empty object", () => {
        expect(AuditLogResponseDto.from(entry({ metadata: {} })).metadata).toStrictEqual({});
    });

    it("should render createdAt with toISOString at millisecond precision", () => {
        expect(AuditLogResponseDto.from(entry()).createdAt).toBe("2026-04-15T11:59:59.123Z");
    });

    it("should map a service or system actor to actorUserId null and keep the role", () => {
        expect(AuditLogResponseDto.from(entry({ actorUserId: null, actorRole: "service" }))).toMatchObject({ actorUserId: null, actorRole: "service" });
        expect(AuditLogResponseDto.from(entry({ actorUserId: null, actorRole: "system" }))).toMatchObject({ actorUserId: null, actorRole: "system" });
    });

    it("should keep a null requestId as null", () => {
        expect(AuditLogResponseDto.from(entry({ requestId: null })).requestId).toBeNull();
    });
});
