import "reflect-metadata";
import type { Knex } from "knex";
import { BloodType, Gender } from "../../../../src/app/patients/enums";
import { PatientProfile } from "../../../../src/app/patients/entity/patient-profile.entity";
import * as repo from "../../../../src/app/patients/repository/patient-profiles.repo";
import { diffProfile, PatientsService } from "../../../../src/app/patients/service/patients.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { AuthContext } from "../../../../src/lib/types/types";

const actor: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: false };
const profile = (overrides: Partial<PatientProfile> = {}): PatientProfile => new PatientProfile({ id: 7, userId: 101, dateOfBirth: "1990-05-17",
    gender: Gender.Female, bloodType: BloodType.OPositive, allergies: ["TEST-ALLERGEN-A", "TEST-ALLERGEN-B"], chronicConditions: ["TEST-CONDITION-A"], timezone: "Africa/Cairo",
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"), ...overrides });
const failure = (constraint: string): Error => Object.assign(new Error("pg"), { code: "23505", constraint });

function setup() {
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => callback(trx));
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new PatientsService({ transaction } as unknown as Knex, { record } as unknown as AuditRecorder);
    const mocks = {
        find: jest.spyOn(repo, "findProfileByUserId").mockResolvedValue(profile()),
        locked: jest.spyOn(repo, "findProfileByUserIdForUpdate").mockResolvedValue(undefined),
        insert: jest.spyOn(repo, "insertProfile").mockResolvedValue(profile()),
        update: jest.spyOn(repo, "updateProfile").mockResolvedValue(profile()),
    };
    return { service, trx, transaction, record, mocks };
}

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe("PatientsService.getOwn", () => {
    it("should return the profile and audit one read with the id and patientUserId only when it exists", async () => {
        const { service, trx, record, mocks, transaction } = setup();
        const result = await service.getOwn(actor);
        expect(result.id).toBe(7);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(mocks.find).toHaveBeenCalledWith(101, trx);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 101, role: "patient" }, action: "patient_profile.read",
            entityType: "patient_profile", entityId: 7, metadata: { patientUserId: 101 } });
    });

    it("should throw NotFound and write no audit row when no live profile exists", async () => {
        const { service, record, mocks } = setup();
        mocks.find.mockResolvedValue(undefined);
        await expect(service.getOwn(actor)).rejects.toMatchObject({ code: "NotFound", status: 404 });
        expect(record).not.toHaveBeenCalled();
    });

    it("should fail the read and return no data when the audit insert fails", async () => {
        const { service, record } = setup();
        record.mockRejectedValue(new Error("audit down"));
        await expect(service.getOwn(actor)).rejects.toThrow("audit down");
    });

    it("should scope the lookup to the caller's token user id only", async () => {
        const { service, mocks } = setup();
        await service.getOwn({ ...actor, userId: 555 });
        expect(mocks.find.mock.calls[0]?.[0]).toBe(555);
    });
});

describe("PatientsService.upsert create path", () => {
    it("should reject creation without timezone and write nothing when no live profile exists", async () => {
        const { service, record, mocks } = setup();
        await expect(service.upsert(actor, { allergies: ["TEST-ALLERGEN-A"] })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "timezone" }] });
        expect(mocks.insert).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    });

    it("should insert with canonical timezone, empty lists and null scalars for absent members", async () => {
        const { service, trx, mocks } = setup();
        await service.upsert(actor, { timezone: "africa/cairo" });
        expect(mocks.insert).toHaveBeenCalledWith(101, { dateOfBirth: null, gender: null, bloodType: null, allergies: [], chronicConditions: [], timezone: "Africa/Cairo" }, trx);
    });

    it("should audit created=true with sorted provided field names and never values", async () => {
        const { service, trx, record } = setup();
        await service.upsert(actor, { timezone: "Africa/Cairo", chronicConditions: ["TEST-CONDITION-A"], allergies: ["TEST-ALLERGEN-A"], gender: Gender.Male });
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 101, role: "patient" }, action: "patient_profile.updated",
            entityType: "patient_profile", entityId: 7, metadata: { created: true, changedFields: "allergies,chronicConditions,gender,timezone" } });
        expect(JSON.stringify(record.mock.calls)).not.toContain("TEST-");
    });

    it("should insert and audit inside one transaction", async () => {
        const { service, transaction, record, mocks } = setup();
        await service.upsert(actor, { timezone: "UTC" });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(mocks.locked).toHaveBeenCalledWith(101, expect.anything());
        expect(record.mock.calls[0]?.[0]).toBe(mocks.insert.mock.calls[0]?.[2]);
    });
});

describe("PatientsService.upsert update path", () => {
    beforeEach(() => { /* each test sets its own locked profile */ });

    it("should update only the changed columns and audit created=false with sorted changed names", async () => {
        const { service, trx, record, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.upsert(actor, { gender: Gender.Male, bloodType: BloodType.OPositive, allergies: ["TEST-ALLERGEN-Z"] });
        expect(mocks.update).toHaveBeenCalledWith(7, { gender: Gender.Male, allergies: ["TEST-ALLERGEN-Z"] }, trx);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "patient_profile.updated", entityId: 7,
            metadata: { created: false, changedFields: "allergies,gender" } }));
    });

    it("should clear scalars with null and replace arrays whole rather than merging", async () => {
        const { service, trx, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.upsert(actor, { dateOfBirth: null, gender: null, bloodType: null, allergies: [], chronicConditions: ["TEST-CONDITION-NEW"] });
        expect(mocks.update).toHaveBeenCalledWith(7, { date_of_birth: null, gender: null, blood_type: null, allergies: [], chronic_conditions: ["TEST-CONDITION-NEW"] }, trx);
    });

    it("should return the current row and write nothing when nothing changes", async () => {
        const { service, record, mocks } = setup();
        const current = profile();
        mocks.locked.mockResolvedValue(current);
        const result = await service.upsert(actor, { dateOfBirth: "1990-05-17", gender: Gender.Female, allergies: ["TEST-ALLERGEN-A", "TEST-ALLERGEN-B"], timezone: "AFRICA/CAIRO" });
        expect(result).toBe(current);
        expect(mocks.update).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    });

    it("should treat a re-ordered list as a change", async () => {
        const { service, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.upsert(actor, { allergies: ["TEST-ALLERGEN-B", "TEST-ALLERGEN-A"] });
        expect(mocks.update).toHaveBeenCalledTimes(1);
    });

    it("should canonicalize the timezone before storing a change", async () => {
        const { service, trx, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.upsert(actor, { timezone: "europe/berlin" });
        expect(mocks.update).toHaveBeenCalledWith(7, { timezone: "Europe/Berlin" }, trx);
    });

    it("should propagate an audit failure so the transaction rolls back", async () => {
        const { service, record, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        record.mockRejectedValue(new Error("audit down"));
        await expect(service.upsert(actor, { gender: Gender.Male })).rejects.toThrow("audit down");
    });
});

describe("PatientsService.upsert first-write race", () => {
    it("should retry exactly once as an update when the insert loses on the live-user index", async () => {
        const { service, transaction, record, mocks } = setup();
        mocks.insert.mockRejectedValueOnce(failure("uq_patient_profiles_user_id"));
        mocks.locked.mockResolvedValueOnce(undefined).mockResolvedValueOnce(profile());
        const result = await service.upsert(actor, { timezone: "Africa/Cairo", gender: Gender.Male });
        expect(result.id).toBe(7);
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(mocks.insert).toHaveBeenCalledTimes(1);
        expect(mocks.update).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledTimes(1);
    });

    it("should propagate a unique violation on another constraint without retrying", async () => {
        const { service, transaction, mocks } = setup();
        mocks.insert.mockRejectedValue(failure("uq_something_else"));
        await expect(service.upsert(actor, { timezone: "UTC" })).rejects.toMatchObject({ code: "23505" });
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("should propagate a second unique violation instead of looping", async () => {
        const { service, transaction, mocks } = setup();
        mocks.insert.mockRejectedValue(failure("uq_patient_profiles_user_id"));
        await expect(service.upsert(actor, { timezone: "UTC" })).rejects.toMatchObject({ code: "23505" });
        expect(transaction).toHaveBeenCalledTimes(2);
    });

    it("should not retry non-database errors", async () => {
        const { service, transaction, mocks } = setup();
        mocks.insert.mockRejectedValue(new Error("boom"));
        await expect(service.upsert(actor, { timezone: "UTC" })).rejects.toThrow("boom");
        expect(transaction).toHaveBeenCalledTimes(1);
    });
});

describe("PatientsService date of birth rule", () => {
    // 2026-06-10T12:00Z is 2026-06-10 in UTC and 2026-06-11 (02:00) in Pacific/Kiritimati (UTC+14).
    const freeze = (): void => { jest.useFakeTimers({ now: new Date("2026-06-10T12:00:00Z") }); };

    it("should reject a date after today in the patient's timezone when creating", async () => {
        freeze();
        const { service, mocks } = setup();
        await expect(service.upsert(actor, { timezone: "UTC", dateOfBirth: "2026-06-11" })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "dateOfBirth" }] });
        expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("should accept tomorrow-in-UTC when the patient's timezone is already there", async () => {
        freeze();
        const { service, mocks } = setup();
        await service.upsert(actor, { timezone: "Pacific/Kiritimati", dateOfBirth: "2026-06-11" });
        expect(mocks.insert).toHaveBeenCalledTimes(1);
    });

    it("should accept today and reject the day after in the stored timezone when updating without a timezone", async () => {
        freeze();
        const { service, mocks } = setup();
        mocks.locked.mockResolvedValue(profile({ timezone: "UTC" }));
        await service.upsert(actor, { dateOfBirth: "2026-06-10" });
        expect(mocks.update).toHaveBeenCalledTimes(1);
        await expect(service.upsert(actor, { dateOfBirth: "2026-06-11" })).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(mocks.update).toHaveBeenCalledTimes(1);
    });

    it("should evaluate against the new timezone when the same update changes it", async () => {
        freeze();
        const { service, mocks } = setup();
        mocks.locked.mockResolvedValue(profile({ timezone: "UTC" }));
        await service.upsert(actor, { dateOfBirth: "2026-06-11", timezone: "Pacific/Kiritimati" });
        expect(mocks.update).toHaveBeenCalledTimes(1);
    });

    it("should not check the date when clearing it with null", async () => {
        freeze();
        const { service, mocks } = setup();
        mocks.locked.mockResolvedValue(profile());
        await service.upsert(actor, { dateOfBirth: null });
        expect(mocks.update).toHaveBeenCalledWith(7, { date_of_birth: null }, expect.anything());
    });
});

describe("diffProfile", () => {
    it("should report nothing when no member is provided", () => {
        expect(diffProfile(profile(), {})).toEqual({ fields: [], columns: {} });
    });

    it("should count null versus a value as a change in both directions", () => {
        expect(diffProfile(profile({ gender: null }), { gender: Gender.Male }).fields).toEqual(["gender"]);
        expect(diffProfile(profile(), { gender: null }).columns).toEqual({ gender: null });
        expect(diffProfile(profile({ gender: null }), { gender: null }).fields).toEqual([]);
    });

    it("should compare lists element-wise in order", () => {
        const current = profile({ allergies: ["a", "b"] });
        expect(diffProfile(current, { allergies: ["a", "b"] }).fields).toEqual([]);
        expect(diffProfile(current, { allergies: ["b", "a"] }).fields).toEqual(["allergies"]);
        expect(diffProfile(current, { allergies: ["a"] }).fields).toEqual(["allergies"]);
        expect(diffProfile(current, { allergies: [] }).columns).toEqual({ allergies: [] });
    });

    it("should compare timezones after canonicalization", () => {
        expect(diffProfile(profile(), { timezone: "africa/cairo" }).fields).toEqual([]);
        expect(diffProfile(profile(), { timezone: "UTC" })).toEqual({ fields: ["timezone"], columns: { timezone: "UTC" } });
    });
});
