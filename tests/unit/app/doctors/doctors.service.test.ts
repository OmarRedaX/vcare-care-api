import "reflect-metadata";
import type { Knex } from "knex";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import * as languageRepo from "../../../../src/app/doctors/repository/doctor-languages.repo";
import * as profileRepo from "../../../../src/app/doctors/repository/doctor-profiles.repo";
import * as linkRepo from "../../../../src/app/doctors/repository/doctor-specialties.repo";
import { DoctorsService, isBookable } from "../../../../src/app/doctors/service/doctors.service";
import type { DoctorProfileInput } from "../../../../src/app/doctors/types";
import type { Specialty } from "../../../../src/app/specialties/entity/specialties.entity";
import type { SpecialtiesService } from "../../../../src/app/specialties/service/specialties.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { Env } from "../../../../src/lib/config/types";
import type { AuthContext } from "../../../../src/lib/types/types";

const actor: AuthContext = { userId: 202, role: "doctor", status: "pending", emailVerified: true };
const input: DoctorProfileInput = { headline: "Synthetic doctor headline", bio: "Synthetic bio", yearsExperience: 5,
    languages: ["en", "ar"], specialtyIds: [1, 2], primarySpecialtyId: 1, consultationFee: { amount: 100, currency: "EGP" },
    defaultSlotMinutes: 30, timezone: "africa/cairo", submit: false };
const profile = (overrides: Partial<DoctorProfile> = {}): DoctorProfile => new DoctorProfile({
    id: 9, userId: 202, headline: input.headline, bio: input.bio ?? null, yearsExperience: 5,
    consultationFeeAmount: 100, currency: "EGP", defaultSlotMinutes: 30, timezone: "Africa/Cairo",
    isAcceptingPatients: true, verificationStatus: VerificationStatus.Draft, identitySyncStatus: IdentitySyncStatus.NotRequired,
    submittedAt: null, decidedAt: null, reviewedBy: null, reviewNote: null, suspendedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"), ...overrides,
});
const links = [{ specialtyId: 1, isPrimary: true }, { specialtyId: 2, isPrimary: false }];
const specialties = (active = true): Specialty[] => [1, 2].map((id) => ({ id, slug: `synthetic-${id}`, name: `Synthetic ${id}`, isActive: active } as Specialty));
const failure = (constraint: string): Error => Object.assign(new Error("pg"), { code: "23505", constraint });

function setup() {
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => callback(trx));
    const db = { transaction } as unknown as Knex;
    const record = jest.fn().mockResolvedValue(undefined);
    const audit = { record } as unknown as AuditRecorder;
    const findByIds = jest.fn().mockResolvedValue(specialties());
    const service = new DoctorsService(db, audit, { ALLOWED_CURRENCIES: ["EGP"] } as unknown as Env, { findByIds } as unknown as SpecialtiesService);
    const mocks = {
        find: jest.spyOn(profileRepo, "findProfileByUserId").mockResolvedValue(profile()),
        locked: jest.spyOn(profileRepo, "findProfileByUserIdForUpdate").mockResolvedValue(undefined),
        insert: jest.spyOn(profileRepo, "insertProfile").mockResolvedValue(profile()),
        update: jest.spyOn(profileRepo, "updateProfile").mockResolvedValue(profile()),
        suspended: jest.spyOn(profileRepo, "isUserLocallySuspended").mockResolvedValue(false),
        languages: jest.spyOn(languageRepo, "listLanguages").mockResolvedValue(["ar", "en"]),
        insertLanguages: jest.spyOn(languageRepo, "insertLanguages").mockResolvedValue(),
        deleteLanguages: jest.spyOn(languageRepo, "deleteLanguagesNotIn").mockResolvedValue(),
        links: jest.spyOn(linkRepo, "listSpecialtyLinks").mockResolvedValue(links),
        insertLinks: jest.spyOn(linkRepo, "insertLinks").mockResolvedValue(),
        deleteLinks: jest.spyOn(linkRepo, "deleteLinksNotIn").mockResolvedValue(),
        clearPrimary: jest.spyOn(linkRepo, "clearPrimaryExcept").mockResolvedValue(),
        markPrimary: jest.spyOn(linkRepo, "markPrimary").mockResolvedValue(),
    };
    return { service, trx, db, transaction, record, findByIds, mocks };
}

afterEach(() => jest.restoreAllMocks());

describe("DoctorsService", () => {
    it("should insert a profile, children and one audit row in one transaction when applying first", async () => {
        const { service, trx, transaction, record, mocks } = setup();
        const result = await service.apply(actor, input);
        expect(result.created).toBe(true);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(mocks.insert).toHaveBeenCalledWith(202, input, "Africa/Cairo", trx);
        expect(mocks.insertLanguages).toHaveBeenCalledWith(9, input.languages, trx);
        expect(mocks.insertLinks).toHaveBeenCalledWith(9, links, trx);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" },
            action: "doctor.profile_created", entityType: "doctor_profile", entityId: 9, metadata: {} });
    });

    it.each([VerificationStatus.Submitted, VerificationStatus.Approved])("should reject apply when status is %s", async (status) => {
        const { service, record, mocks } = setup();
        mocks.locked.mockResolvedValue(profile({ verificationStatus: status }));
        await expect(service.apply(actor, input)).rejects.toMatchObject({ code: "Conflict", status: 409 });
        expect(mocks.update).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    });

    it.each([VerificationStatus.Draft, VerificationStatus.Rejected])("should preserve %s when replacing an existing profile", async (status) => {
        const { service, mocks } = setup();
        mocks.locked.mockResolvedValue(profile({ verificationStatus: status, headline: "Old headline" }));
        await service.apply(actor, input);
        expect(mocks.update).toHaveBeenCalledWith(9, expect.objectContaining({ headline: input.headline }), expect.anything());
        expect(mocks.update.mock.calls[0]?.[1]).not.toHaveProperty("verification_status");
    });

    it("should clear bio when replacing a profile with an apply body lacking bio", async () => {
        const { service, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.apply(actor, { ...input, bio: undefined });
        expect(mocks.update).toHaveBeenCalledWith(9, { bio: null }, expect.anything());
    });

    it("should avoid a write and audit when applying the identical profile", async () => {
        const { service, record, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.apply(actor, input);
        expect(mocks.update).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    });

    it.each([false, true])("should reject submit when an existing profile is %s", async (existing) => {
        const { service, record, mocks } = setup();
        if (existing) mocks.locked.mockResolvedValue(profile());
        await expect(service.apply(actor, { ...input, submit: true })).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    });

    it("should retry once as an update when first insert races on the live-user constraint", async () => {
        const { service, mocks, transaction } = setup();
        mocks.insert.mockRejectedValueOnce(failure("uq_doctor_profiles_user_id"));
        mocks.locked.mockResolvedValueOnce(undefined).mockResolvedValueOnce(profile());
        await service.apply(actor, input);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(mocks.insert).toHaveBeenCalledTimes(1);
    });

    it.each(["uq_other", "uq_doctor_profiles_user_id"])("should not retry beyond the allowed race recovery for %s", async (constraint) => {
        const { service, mocks, transaction } = setup();
        mocks.insert.mockRejectedValue(failure(constraint));
        await expect(service.apply(actor, input)).rejects.toMatchObject({ code: "23505" });
        expect(transaction).toHaveBeenCalledTimes(constraint === "uq_other" ? 1 : 2);
    });

    it("should reject currency outside the configured allowlist before a transaction", async () => {
        const { service, transaction } = setup();
        await expect(service.apply(actor, { ...input, consultationFee: { amount: 1, currency: "USD" } })).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(transaction).not.toHaveBeenCalled();
    });

    it.each([["missing", []], ["inactive", specialties(false)]] as const)("should reject a %s specialty when newly linked", async (_label, available) => {
        const { service, findByIds } = setup(); findByIds.mockResolvedValue(available);
        await expect(service.apply(actor, input)).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should accept an inactive specialty when already linked", async () => {
        const { service, mocks, findByIds } = setup();
        mocks.locked.mockResolvedValue(profile()); findByIds.mockResolvedValue(specialties(false));
        await expect(service.apply(actor, input)).resolves.toMatchObject({ created: false });
    });

    it("should reject a primary outside the specialty set", async () => {
        const { service } = setup();
        await expect(service.apply(actor, { ...input, primarySpecialtyId: 3 })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should propagate an audit failure so the transaction handler rolls back", async () => {
        const { service, record } = setup(); const error = new Error("audit down"); record.mockRejectedValue(error);
        await expect(service.apply(actor, input)).rejects.toBe(error);
    });

    it("should reject update and getOwn when no profile exists", async () => {
        const { service, mocks } = setup(); mocks.locked.mockResolvedValue(undefined); mocks.find.mockResolvedValue(undefined);
        await expect(service.update(actor, { headline: "New headline" })).rejects.toMatchObject({ code: "NotFound" });
        await expect(service.getOwn(actor)).rejects.toMatchObject({ code: "NotFound" });
    });

    it("should load the profile, languages, links and specialty data in four queries on getOwn", async () => {
        const { service, db, mocks, findByIds } = setup();
        await service.getOwn(actor);
        expect(mocks.find).toHaveBeenCalledWith(202, db);
        expect(mocks.languages).toHaveBeenCalledTimes(1); expect(mocks.links).toHaveBeenCalledTimes(1);
        expect(findByIds).toHaveBeenCalledTimes(1);
    });

    it("should audit sorted changed wire names and no values on update", async () => {
        const { service, record, mocks } = setup(); mocks.locked.mockResolvedValue(profile());
        await service.update(actor, { yearsExperience: 6, headline: "Changed synthetic headline" });
        expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata: { changedFields: "headline,yearsExperience" } }));
    });

    it("should treat reordered language sets as unchanged", async () => {
        const { service, mocks, record } = setup(); mocks.locked.mockResolvedValue(profile());
        await service.update(actor, { languages: ["en", "ar"] });
        expect(mocks.update).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    });

    it("should preserve the current primary when the replacement set includes it", async () => {
        const { service, mocks } = setup(); mocks.locked.mockResolvedValue(profile());
        await service.update(actor, { specialtyIds: [1] });
        expect(mocks.deleteLinks).toHaveBeenCalledWith(9, [1], expect.anything());
    });

    it("should require a primary when a replacement set removes the current one", async () => {
        const { service, mocks } = setup(); mocks.locked.mockResolvedValue(profile());
        await expect(service.update(actor, { specialtyIds: [2] })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should require an already linked specialty when changing only the primary", async () => {
        const { service, mocks } = setup(); mocks.locked.mockResolvedValue(profile());
        await expect(service.update(actor, { primarySpecialtyId: 3 })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("should order link changes as delete, clear primary, insert, mark primary", async () => {
        const { service, mocks } = setup(); mocks.locked.mockResolvedValue(profile());
        const calls: string[] = [];
        mocks.deleteLinks.mockImplementation(() => { calls.push("delete"); return Promise.resolve(); });
        mocks.clearPrimary.mockImplementation(() => { calls.push("clear"); return Promise.resolve(); });
        mocks.insertLinks.mockImplementation(() => { calls.push("insert"); return Promise.resolve(); });
        mocks.markPrimary.mockImplementation(() => { calls.push("mark"); return Promise.resolve(); });
        await service.update(actor, { specialtyIds: [2], primarySpecialtyId: 2 });
        expect(calls).toEqual(["delete", "clear", "insert", "mark"]);
    });

    it.each([false, true])("should report local suspension as %s", async (value) => {
        const { service, mocks } = setup(); mocks.suspended.mockResolvedValue(value);
        expect(await service.isLocallySuspended(202)).toBe(value);
    });
});

describe("isBookable", () => {
    it.each([
        [VerificationStatus.Approved, IdentitySyncStatus.Synced, null, true, true, true],
        [VerificationStatus.Draft, IdentitySyncStatus.Synced, null, true, true, false],
        [VerificationStatus.Approved, IdentitySyncStatus.Pending, null, true, true, false],
        [VerificationStatus.Approved, IdentitySyncStatus.Synced, new Date(), true, true, false],
        [VerificationStatus.Approved, IdentitySyncStatus.Synced, null, false, true, false],
        [VerificationStatus.Approved, IdentitySyncStatus.Synced, null, true, false, false],
    ] as const)("should return %s/%s bookability when all gates are evaluated", (status, sync, suspendedAt, accepting, hasType, expected) => {
        expect(isBookable(profile({ verificationStatus: status, identitySyncStatus: sync, suspendedAt, isAcceptingPatients: accepting }), hasType)).toBe(expected);
    });
});
