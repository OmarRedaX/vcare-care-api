import type { Knex } from "knex";
import { DateTime } from "luxon";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { AuthContext } from "../../../lib/types/types";
import { canonicalIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { PATIENT_PROFILE_ENTITY_TYPE, PATIENT_PROFILE_UNIQUE_USER } from "../constants";
import type { PatientProfile } from "../entity/patient-profile.entity";
import { PatientAuditAction, PatientProfileField } from "../enums";
import { DateOfBirthInFuture, TimezoneRequiredOnCreate } from "../errors";
import { findProfileByUserId, findProfileByUserIdForUpdate, insertProfile, updateProfile } from "../repository/patient-profiles.repo";
import type { PatientProfileChanges, PatientProfileColumnChanges, PatientProfileDiff } from "../types";

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Members present in `changes` that differ from `current`; `null` vs a value counts, list order counts. */
export function diffProfile(current: PatientProfile, changes: PatientProfileChanges): PatientProfileDiff {
    const fields: PatientProfileField[] = [];
    const columns: PatientProfileColumnChanges = {};
    if (changes.dateOfBirth !== undefined && changes.dateOfBirth !== current.dateOfBirth) { fields.push(PatientProfileField.DateOfBirth); columns.date_of_birth = changes.dateOfBirth; }
    if (changes.gender !== undefined && changes.gender !== current.gender) { fields.push(PatientProfileField.Gender); columns.gender = changes.gender; }
    if (changes.bloodType !== undefined && changes.bloodType !== current.bloodType) { fields.push(PatientProfileField.BloodType); columns.blood_type = changes.bloodType; }
    if (changes.allergies !== undefined && !sameList(changes.allergies, current.allergies)) { fields.push(PatientProfileField.Allergies); columns.allergies = changes.allergies; }
    if (changes.chronicConditions !== undefined && !sameList(changes.chronicConditions, current.chronicConditions)) { fields.push(PatientProfileField.ChronicConditions); columns.chronic_conditions = changes.chronicConditions; }
    if (changes.timezone !== undefined) {
        const canonical = canonicalIanaTimezone(changes.timezone);
        if (canonical !== current.timezone) { fields.push(PatientProfileField.Timezone); columns.timezone = canonical; }
    }
    return { fields, columns };
}

function providedFields(changes: PatientProfileChanges): PatientProfileField[] {
    const fields: PatientProfileField[] = [];
    if (changes.dateOfBirth !== undefined) fields.push(PatientProfileField.DateOfBirth);
    if (changes.gender !== undefined) fields.push(PatientProfileField.Gender);
    if (changes.bloodType !== undefined) fields.push(PatientProfileField.BloodType);
    if (changes.allergies !== undefined) fields.push(PatientProfileField.Allergies);
    if (changes.chronicConditions !== undefined) fields.push(PatientProfileField.ChronicConditions);
    if (changes.timezone !== undefined) fields.push(PatientProfileField.Timezone);
    return fields;
}

@injectable()
export class PatientsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
    ) {}

    /**
     * The live profile row of a patient, or `undefined`: a plain read for another module that renders it inside its own audited
     * transaction (the records timeline). It writes no `patient_profile.read` row; the caller audits its own access.
     */
    findProfile(patientUserId: number, conn: Knex = this.db): Promise<PatientProfile | undefined> {
        return findProfileByUserId(patientUserId, conn);
    }

    getOwn(actor: AuthContext): Promise<PatientProfile> {
        return this.db.transaction(async (trx) => {
            const profile = await findProfileByUserId(actor.userId, trx);
            if (profile === undefined) throw NotFound;
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: PatientAuditAction.Read,
                entityType: PATIENT_PROFILE_ENTITY_TYPE, entityId: profile.id, metadata: { patientUserId: actor.userId } });
            return profile;
        });
    }

    /**
     * `GET /patients/{patientUserId}` for the patient themself or a related doctor (the ownership policy already decided who
     * may ask). A patient is held to their own id again here; an absent profile is 404. The clinical read is audited in the
     * same transaction as the read.
     */
    getForViewer(actor: AuthContext, patientUserId: number): Promise<PatientProfile> {
        if (actor.role === "patient" && actor.userId !== patientUserId) throw NotFound;
        return this.db.transaction(async (trx) => {
            const profile = await findProfileByUserId(patientUserId, trx);
            if (profile === undefined) throw NotFound;
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: PatientAuditAction.Read, entityType: PATIENT_PROFILE_ENTITY_TYPE,
                entityId: profile.id, metadata: { patientUserId, viewerRole: actor.role } });
            return profile;
        });
    }

    async upsert(actor: AuthContext, changes: PatientProfileChanges): Promise<PatientProfile> {
        try {
            return await this.upsertOnce(actor, changes);
        } catch (error) {
            if (uniqueViolationConstraint(error) !== PATIENT_PROFILE_UNIQUE_USER) throw error;
            return this.upsertOnce(actor, changes);
        }
    }

    private upsertOnce(actor: AuthContext, changes: PatientProfileChanges): Promise<PatientProfile> {
        return this.db.transaction(async (trx) => {
            const current = await findProfileByUserIdForUpdate(actor.userId, trx);
            if (current === undefined) {
                if (changes.timezone === undefined) throw TimezoneRequiredOnCreate;
                const timezone = canonicalIanaTimezone(changes.timezone);
                this.assertDateOfBirthNotFuture(changes.dateOfBirth, timezone);
                const created = await insertProfile(actor.userId, { dateOfBirth: changes.dateOfBirth ?? null, gender: changes.gender ?? null,
                    bloodType: changes.bloodType ?? null, allergies: changes.allergies ?? [], chronicConditions: changes.chronicConditions ?? [], timezone }, trx);
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: PatientAuditAction.Updated, entityType: PATIENT_PROFILE_ENTITY_TYPE,
                    entityId: created.id, metadata: { created: true, changedFields: providedFields(changes).sort().join(",") } });
                return created;
            }
            const timezone = changes.timezone === undefined ? current.timezone : canonicalIanaTimezone(changes.timezone);
            this.assertDateOfBirthNotFuture(changes.dateOfBirth, timezone);
            const diff = diffProfile(current, changes);
            if (diff.fields.length === 0) return current;
            const updated = await updateProfile(current.id, diff.columns, trx);
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: PatientAuditAction.Updated, entityType: PATIENT_PROFILE_ENTITY_TYPE,
                entityId: current.id, metadata: { created: false, changedFields: [...diff.fields].sort().join(",") } });
            return updated;
        });
    }

    private assertDateOfBirthNotFuture(dateOfBirth: string | null | undefined, timezone: string): void {
        if (dateOfBirth === undefined || dateOfBirth === null) return;
        const today = DateTime.now().setZone(timezone).toISODate();
        if (today !== null && dateOfBirth > today) throw DateOfBirthInFuture;
    }
}
