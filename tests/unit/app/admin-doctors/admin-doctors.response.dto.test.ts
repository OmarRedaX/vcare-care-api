import { ReinstatementResultResponseDto, SuspensionResultResponseDto } from "../../../../src/app/admin-doctors/dto/admin-doctors.response.dto";
import { IdentitySyncStatus } from "../../../../src/app/doctors/enums";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

const required = (schema: string): string[] => inlineLists(schemaBlock(schema), "required")[0] ?? [];
const at = new Date("2026-10-09T10:00:00.123Z");

describe("admin-doctors response DTOs", () => {
    it("should produce exactly the SuspensionResult required keys with ISO dates and numeric ids", () => {
        const dto = SuspensionResultResponseDto.from({ doctorUserId: 202, suspendedAt: at, identitySyncStatus: IdentitySyncStatus.Pending, flaggedConsultationIds: [11, 12] });
        expect(Object.keys(dto).sort()).toEqual([...required("SuspensionResult")].sort());
        expect(dto).toEqual({ doctorUserId: 202, suspendedAt: "2026-10-09T10:00:00.123Z", identitySyncStatus: "pending", flaggedConsultationIds: [11, 12] });
        expect(typeof dto.doctorUserId).toBe("number");
    });

    it("should produce exactly the ReinstatementResult required keys", () => {
        const dto = ReinstatementResultResponseDto.from({ doctorUserId: 202, reinstatedAt: at, identitySyncStatus: IdentitySyncStatus.Synced });
        expect(Object.keys(dto).sort()).toEqual([...required("ReinstatementResult")].sort());
        expect(dto).toEqual({ doctorUserId: 202, reinstatedAt: "2026-10-09T10:00:00.123Z", identitySyncStatus: "synced" });
    });

    it("should copy flaggedConsultationIds instead of aliasing the view", () => {
        const view = { doctorUserId: 1, suspendedAt: at, identitySyncStatus: IdentitySyncStatus.Synced, flaggedConsultationIds: [1] };
        const dto = SuspensionResultResponseDto.from(view);
        expect(dto.flaggedConsultationIds).not.toBe(view.flaggedConsultationIds);
    });

    it("should expose no reason, actor or profile id even when the view carries extras", () => {
        const view = { doctorUserId: 1, suspendedAt: at, identitySyncStatus: IdentitySyncStatus.Synced, flaggedConsultationIds: [], reason: "private", suspendedBy: 303, doctorProfileId: 9 };
        expect(JSON.stringify(SuspensionResultResponseDto.from(view))).not.toMatch(/private|suspendedBy|doctorProfileId|303/);
    });

    it.each(Object.values(IdentitySyncStatus))("should render identitySyncStatus %s as a contract enum value", (status) => {
        const declared = schemaBlock("IdentitySyncStatus");
        expect(declared).toContain(status);
        expect(ReinstatementResultResponseDto.from({ doctorUserId: 1, reinstatedAt: at, identitySyncStatus: status }).identitySyncStatus).toBe(status);
    });
});
