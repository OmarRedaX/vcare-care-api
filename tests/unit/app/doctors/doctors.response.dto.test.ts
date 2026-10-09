import { DoctorProfileOwnResponseDto, VerificationApplicationResponseDto } from "../../../../src/app/doctors/dto/doctors.response.dto";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import type { DoctorProfileView } from "../../../../src/app/doctors/types";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

const at = new Date("2026-01-02T03:04:05.000Z");
const view = (): DoctorProfileView => ({
    profile: new DoctorProfile({ id: 1, userId: 202, headline: "Synthetic headline", bio: null, yearsExperience: 5,
        consultationFeeAmount: 100, currency: "EGP", defaultSlotMinutes: 30, timezone: "Africa/Cairo",
        isAcceptingPatients: true, verificationStatus: VerificationStatus.Draft, identitySyncStatus: IdentitySyncStatus.NotRequired,
        submittedAt: null, decidedAt: null, reviewedBy: null, reviewNote: null, suspendedAt: null, deletedAt: at,
        createdAt: at, updatedAt: at }),
    languages: ["en", "ar"], specialties: [{ id: 1, slug: "synthetic-one", name: "Synthetic One", isPrimary: true }],
    hasActiveConsultationType: false,
});

describe("doctor response DTOs", () => {
    it("should produce exactly contract DoctorProfileOwn required keys plus reviewNote", () => {
        const [required = []] = inlineLists(schemaBlock("DoctorProfileOwn"), "required");
        expect(Object.keys(DoctorProfileOwnResponseDto.from(view())).sort()).toEqual([...required, "reviewNote"].sort());
    });

    it("should produce exactly contract VerificationApplication required keys", () => {
        const [required = []] = inlineLists(schemaBlock("VerificationApplication"), "required");
        expect(Object.keys(VerificationApplicationResponseDto.from(view())).sort()).toEqual([...required, "specialties", "yearsExperience", "missingRequirements"].sort());
    });

    it("should render ISO dates and suspension without exposing deletedAt", () => {
        const data = view();
        data.profile.suspendedAt = at;
        data.profile.submittedAt = at;
        const own = DoctorProfileOwnResponseDto.from(data);
        const application = VerificationApplicationResponseDto.from(data);
        expect(own).toMatchObject({ createdAt: at.toISOString(), updatedAt: at.toISOString(), suspendedAt: at.toISOString(), isSuspended: true, languages: ["ar", "en"] });
        expect(application).toMatchObject({ submittedAt: at.toISOString(), documents: [], doctor: { displayName: null, avatarUrl: null, profileHydrated: false } });
        expect(JSON.stringify({ own, application })).not.toContain("deletedAt");
    });

    it("should show missing documents for draft and rejected applications", () => {
        for (const status of [VerificationStatus.Draft, VerificationStatus.Rejected]) {
            const data = view(); data.profile.verificationStatus = status;
            expect(VerificationApplicationResponseDto.from(data).missingRequirements).toEqual(["license_document", "id_document"]);
        }
    });

    it("should compute isBookable from the active consultation type flag of the view", () => {
        const data = view();
        data.profile.verificationStatus = VerificationStatus.Approved; data.profile.identitySyncStatus = IdentitySyncStatus.Synced;
        expect(DoctorProfileOwnResponseDto.from(data).isBookable).toBe(false);
        data.hasActiveConsultationType = true;
        expect(DoctorProfileOwnResponseDto.from(data).isBookable).toBe(true);
    });
});
