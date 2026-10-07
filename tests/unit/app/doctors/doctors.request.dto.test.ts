import "reflect-metadata";
import { DoctorApplyDto, DoctorProfileUpdateDto } from "../../../../src/app/doctors/dto/doctors.request.dto";
import type { AppError } from "../../../../src/lib/error/AppError";
import { validateBody } from "../../../../src/lib/validation/validate";

const valid = { headline: "Synthetic doctor headline", bio: "Synthetic biography", yearsExperience: 5,
    languages: ["en", "ar"], specialtyIds: [1, 2], primarySpecialtyId: 1,
    consultationFee: { amount: 100, currency: "EGP" }, defaultSlotMinutes: 30, timezone: "Africa/Cairo", submit: false };

async function rejected<T extends object>(cls: new () => T, body: object, field: string): Promise<void> {
    try { await validateBody(cls, body); } catch (error) {
        const failure = error as AppError;
        expect(failure.code).toBe("ValidationFailed");
        expect(failure.details.map((detail) => detail.field)).toContain(field);
        return;
    }
    throw new Error(`expected ${field} to fail validation`);
}

describe("doctor request DTOs", () => {
    it("should accept a complete apply body when every value is valid", async () => {
        expect((await validateBody(DoctorApplyDto, valid)).toInput()).toEqual(valid);
    });

    it.each([
        ["short headline", { headline: "abcd" }, "headline"],
        ["long headline", { headline: "x".repeat(161) }, "headline"],
        ["control in headline", { headline: "Synthetic\u0001doctor" }, "headline"],
        ["long bio", { bio: "x".repeat(4001) }, "bio"],
        ["null bio", { bio: null }, "bio"],
        ["NUL bio", { bio: "x\u0000y" }, "bio"],
        ["negative experience", { yearsExperience: -1 }, "yearsExperience"],
        ["excess experience", { yearsExperience: 71 }, "yearsExperience"],
        ["fractional experience", { yearsExperience: 1.5 }, "yearsExperience"],
        ["string experience", { yearsExperience: "5" }, "yearsExperience"],
        ["empty languages", { languages: [] }, "languages"],
        ["many languages", { languages: Array.from({ length: 11 }, (_, i) => `a${i}`) }, "languages"],
        ["duplicate languages", { languages: ["en", "en"] }, "languages"],
        ["uppercase language", { languages: ["AR"] }, "languages"],
        ["long language", { languages: ["ara"] }, "languages"],
        ["empty specialties", { specialtyIds: [] }, "specialtyIds"],
        ["many specialties", { specialtyIds: [1, 2, 3, 4, 5, 6] }, "specialtyIds"],
        ["duplicate specialties", { specialtyIds: [1, 1] }, "specialtyIds"],
        ["zero specialty", { specialtyIds: [0] }, "specialtyIds"],
        ["string specialty", { specialtyIds: ["1"] }, "specialtyIds"],
        ["missing primary", { primarySpecialtyId: undefined }, "primarySpecialtyId"],
        ["negative fee", { consultationFee: { amount: -1, currency: "EGP" } }, "consultationFee.amount"],
        ["overflow fee", { consultationFee: { amount: 2147483648, currency: "EGP" } }, "consultationFee.amount"],
        ["fractional fee", { consultationFee: { amount: 1.5, currency: "EGP" } }, "consultationFee.amount"],
        ["lowercase currency", { consultationFee: { amount: 1, currency: "egp" } }, "consultationFee.currency"],
        ["short currency", { consultationFee: { amount: 1, currency: "EG" } }, "consultationFee.currency"],
        ["missing fee", { consultationFee: undefined }, "consultationFee"],
        ["extra fee member", { consultationFee: { amount: 1, currency: "EGP", extra: true } }, "consultationFee.extra"],
        ["short slot", { defaultSlotMinutes: 4 }, "defaultSlotMinutes"],
        ["long slot", { defaultSlotMinutes: 241 }, "defaultSlotMinutes"],
        ["bad timezone", { timezone: "Not/AZone" }, "timezone"],
        ["long timezone", { timezone: "x".repeat(65) }, "timezone"],
        ["missing submit", { submit: undefined }, "submit"],
        ["string submit", { submit: "true" }, "submit"],
        ["body userId", { userId: 202 }, "userId"],
        ["body accepting state", { isAcceptingPatients: true }, "isAcceptingPatients"],
    ] as const)("should reject %s when applying", async (_label, change, field) => {
        await rejected(DoctorApplyDto, { ...valid, ...change }, field);
    });

    it("should count astral characters as one code point when validating headline", async () => {
        expect((await validateBody(DoctorApplyDto, { ...valid, headline: "😀".repeat(160) })).headline).toHaveLength(320);
        await rejected(DoctorApplyDto, { ...valid, headline: "😀".repeat(161) }, "headline");
    });

    it("should report empty and all-undefined updates when there are no changes", async () => {
        expect((await validateBody(DoctorProfileUpdateDto, {})).isEmpty()).toBe(true);
        expect(new DoctorProfileUpdateDto().isEmpty()).toBe(true);
    });

    it.each(["headline", "yearsExperience", "languages", "specialtyIds", "primarySpecialtyId", "consultationFee", "defaultSlotMinutes", "timezone", "isAcceptingPatients"])(
        "should reject null %s when updating", async (field) => rejected(DoctorProfileUpdateDto, { [field]: null }, field),
    );

    it("should preserve null bio and omit absent fields when updating", async () => {
        expect((await validateBody(DoctorProfileUpdateDto, { bio: null })).toChanges()).toEqual({ bio: null });
        expect((await validateBody(DoctorProfileUpdateDto, { headline: "Synthetic new headline" })).toChanges()).toEqual({ headline: "Synthetic new headline" });
    });
});
