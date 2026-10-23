// Rules covered: spec 3.2 (viewer-aware public DoctorProfile, no internals), AV-R22 (hydration flags), contract C5 (meta.degraded).
import { SearchMetaResponseDto } from "../../../../src/app/availability/dto/search-meta.response.dto";
import { DiscoveryDoctorResponseDto } from "../../../../src/app/availability/dto/discovery-doctor.response.dto";
import { DegradedPart } from "../../../../src/app/availability/enums";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import type { PublicDoctorView } from "../../../../src/app/doctors/types";
import { ConsultationType } from "../../../../src/app/schedules/entity/consultation-type.entity";

const view = (bookable = true): PublicDoctorView => ({
    profile: new DoctorProfile({ id: 9, userId: 202, headline: "Synthetic headline", bio: "Synthetic bio", yearsExperience: 6, consultationFeeAmount: 150, currency: "EGP",
        defaultSlotMinutes: 20, timezone: "Africa/Cairo", isAcceptingPatients: true, verificationStatus: VerificationStatus.Approved, identitySyncStatus: IdentitySyncStatus.Synced,
        reviewNote: "SYNTHETIC-REVIEW-NOTE", suspensionReason: "SYNTHETIC-SUSPENSION", suspendedAt: null }),
    languages: ["en", "ar"], specialties: [{ id: 3, slug: "cardiology", name: "Cardiology", isPrimary: true }], bookable,
    activeTypes: [new ConsultationType({ id: 5, name: "First visit", durationMinutes: 30, price: 150, currency: "EGP", isActive: true, createdAt: new Date(0), updatedAt: new Date(0) })],
});
const START = Date.parse("2027-01-04T09:00:00Z");

describe("DiscoveryDoctorResponseDto", () => {
    it("should expose only the public fields of a search item, with sorted languages and ISO nextAvailableAt", () => {
        const dto = DiscoveryDoctorResponseDto.fromSearch({ view: view(), nextAvailableAt: START }, undefined);
        expect(Object.keys(dto).sort()).toEqual(["avatarUrl", "bio", "consultationFee", "consultationTypes", "displayName", "headline", "isAcceptingPatients", "languages",
            "nextAvailableAt", "profileHydrated", "specialties", "timezone", "userId", "yearsExperience"]);
        expect(dto).toMatchObject({ userId: 202, languages: ["ar", "en"], consultationFee: { amount: 150, currency: "EGP" }, timezone: "Africa/Cairo", nextAvailableAt: "2027-01-04T09:00:00.000Z" });
        expect(dto.consultationTypes[0]).toMatchObject({ id: 5, durationMinutes: 30, isActive: true });
    });

    it("should never expose verification, suspension, sync status, review note or the default slot length", () => {
        const text = JSON.stringify([DiscoveryDoctorResponseDto.fromSearch({ view: view(), nextAvailableAt: null }, undefined),
            DiscoveryDoctorResponseDto.fromProfile({ view: view(), hydrated: undefined, nextAvailableAt: null, slots: [], timezone: "UTC", admin: true })]);
        for (const leaked of ["SYNTHETIC-REVIEW-NOTE", "SYNTHETIC-SUSPENSION", "verificationStatus", "identitySync", "suspended", "defaultSlotMinutes", "reviewNote"]) {
            expect(text).not.toContain(leaked);
        }
    });

    it("should map hydration to display fields and flag an absent hydration as not hydrated", () => {
        const hydrated = DiscoveryDoctorResponseDto.fromSearch({ view: view(), nextAvailableAt: null }, { displayName: "Synthetic Name", avatarUrl: "https://synthetic.invalid/a.png", status: "active" });
        expect(hydrated).toMatchObject({ displayName: "Synthetic Name", avatarUrl: "https://synthetic.invalid/a.png", profileHydrated: true, nextAvailableAt: null });
        expect(DiscoveryDoctorResponseDto.fromSearch({ view: view(), nextAvailableAt: null }, undefined)).toMatchObject({ displayName: null, avatarUrl: null, profileHydrated: false });
    });

    it("should render the profile preview in the caller zone and add status only for an admin viewer", () => {
        const slots = [{ startMs: START, endMs: START + 1_800_000 }];
        const patientView = DiscoveryDoctorResponseDto.fromProfile({ view: view(), hydrated: undefined, nextAvailableAt: START, slots, timezone: "Africa/Cairo", admin: false });
        expect(patientView).not.toHaveProperty("status");
        expect(patientView.nextAvailableSlots).toEqual([{ startsAt: "2027-01-04T09:00:00.000Z", endsAt: "2027-01-04T09:30:00.000Z", startsAtLocal: expect.stringContaining("2027-01-04T11:00:00"), endsAtLocal: expect.any(String), timezone: "Africa/Cairo" }]);
        expect(DiscoveryDoctorResponseDto.fromProfile({ view: view(), hydrated: undefined, nextAvailableAt: START, slots, timezone: "UTC", admin: true }).status).toBe("bookable");
        const notBookable = DiscoveryDoctorResponseDto.fromProfile({ view: view(false), hydrated: undefined, nextAvailableAt: null, slots: [], timezone: "UTC", admin: true });
        expect(notBookable).toMatchObject({ status: "not_bookable", nextAvailableAt: null, nextAvailableSlots: [] });
    });
});

describe("SearchMetaResponseDto", () => {
    it("should include degraded only when it is non-empty", () => {
        expect(SearchMetaResponseDto.from({ nextCursor: null, hasMore: false, count: 0 })).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        expect(SearchMetaResponseDto.from({ nextCursor: null, hasMore: false, count: 0, degraded: [] })).not.toHaveProperty("degraded");
        expect(SearchMetaResponseDto.from({ nextCursor: "c", hasMore: true, count: 2, degraded: [DegradedPart.Sort, DegradedPart.NameFilter] }))
            .toEqual({ nextCursor: "c", hasMore: true, count: 2, degraded: ["sort", "nameFilter"] });
    });
});
