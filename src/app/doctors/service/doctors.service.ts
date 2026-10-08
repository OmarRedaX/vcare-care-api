import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import { uniqueViolationConstraint } from "../../../lib/knex/pg-errors";
import type { AuthContext } from "../../../lib/types/types";
import { canonicalIanaTimezone } from "../../../lib/validation/timezone-decorator";
import type { Specialty } from "../../specialties/entity/specialties.entity";
import { SpecialtiesService } from "../../specialties/service/specialties.service";
import { DOCTOR_PROFILE_ENTITY_TYPE, DOCTOR_PROFILE_UNIQUE_USER } from "../constants";
import { DoctorAuditAction, DoctorProfileField, IdentitySyncStatus, VerificationStatus } from "../enums";
import { ApplicationNotEditable, CurrencyNotAllowed, PrimarySpecialtyNotLinked, PrimarySpecialtyRequired, UnknownSpecialty } from "../errors";
import { Conflict } from "../../../lib/error/errors";
import { deleteLanguagesNotIn, insertLanguages, listLanguages } from "../repository/doctor-languages.repo";
import { findProfileByUserId, findProfileByUserIdForUpdate, insertProfile, isUserLocallySuspended, updateProfile } from "../repository/doctor-profiles.repo";
import { clearPrimaryExcept, deleteLinksNotIn, insertLinks, listSpecialtyLinks, markPrimary } from "../repository/doctor-specialties.repo";
import type { ApplyResult, DoctorProfileChanges, DoctorProfileColumnChanges, DoctorProfileDiff, DoctorProfileInput, DoctorProfileView, SpecialtyLink, SpecialtyRef } from "../types";
import type { DoctorProfile } from "../entity/doctor-profile.entity";
import { VerificationService } from "../../verification/service/verification.service";
import type { VerificationApplicationView } from "../../verification/types";

export function isBookable(profile: DoctorProfile, hasActiveConsultationType: boolean): boolean {
    return profile.verificationStatus === VerificationStatus.Approved && profile.identitySyncStatus === IdentitySyncStatus.Synced &&
        profile.suspendedAt === null && profile.isAcceptingPatients && hasActiveConsultationType;
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((value) => b.includes(value));
}

@injectable()
export class DoctorsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.SpecialtiesService) private readonly specialties: SpecialtiesService,
        @inject(TOKENS.VerificationService) private readonly verification: VerificationService,
    ) {}

    async getOwn(actor: AuthContext): Promise<DoctorProfileView> {
        const profile = await findProfileByUserId(actor.userId, this.db);
        if (profile === undefined) throw NotFound;
        return this.loadView(profile, this.db);
    }

    getOwnApplication(actor: AuthContext): Promise<VerificationApplicationView> { return this.verification.getOwnApplication(actor); }

    async isLocallySuspended(userId: number): Promise<boolean> { return isUserLocallySuspended(userId, this.db); }

    async apply(actor: AuthContext, input: DoctorProfileInput): Promise<ApplyResult> {
        this.assertCurrencyAllowed(input.consultationFee.currency);
        if (!input.specialtyIds.includes(input.primarySpecialtyId)) throw PrimarySpecialtyNotLinked;
        try {
            return await this.applyOnce(actor, input);
        } catch (error) {
            if (uniqueViolationConstraint(error) !== DOCTOR_PROFILE_UNIQUE_USER) throw error;
            return this.applyOnce(actor, input);
        }
    }

    private async applyOnce(actor: AuthContext, input: DoctorProfileInput): Promise<ApplyResult> {
        const result = await this.db.transaction(async (trx) => {
            const current = await findProfileByUserIdForUpdate(actor.userId, trx);
            if (current === undefined) {
                await this.resolveSpecialties(input.specialtyIds, [], trx);
                const created = await insertProfile(actor.userId, input, canonicalIanaTimezone(input.timezone), trx);
                await insertLanguages(created.id, input.languages, trx);
                await insertLinks(created.id, input.specialtyIds.map((specialtyId) => ({ specialtyId, isPrimary: specialtyId === input.primarySpecialtyId })), trx);
                await this.audit.record(trx, { actor: actorFromAuth(actor), action: DoctorAuditAction.ProfileCreated,
                    entityType: DOCTOR_PROFILE_ENTITY_TYPE, entityId: created.id, metadata: {} });
                const transition = input.submit ? await this.verification.submitInTransaction(actor, created, trx) : { jobId: null };
                return { view: await this.loadView(created, trx), created: true, transition };
            }
            if (current.verificationStatus === VerificationStatus.Submitted) throw ApplicationNotEditable;
            if (current.verificationStatus === VerificationStatus.Approved) throw Conflict;
            await this.resolveSpecialties(input.specialtyIds, (await listSpecialtyLinks(current.id, trx)).map((link) => link.specialtyId), trx);
            const changes: DoctorProfileChanges = { headline: input.headline, bio: input.bio ?? null,
                yearsExperience: input.yearsExperience, languages: input.languages, specialtyIds: input.specialtyIds,
                primarySpecialtyId: input.primarySpecialtyId, consultationFee: input.consultationFee,
                defaultSlotMinutes: input.defaultSlotMinutes, timezone: input.timezone };
            const view = await this.applyChanges(actor, current, changes, trx);
            const transition = input.submit ? await this.verification.submitInTransaction(actor, view.profile, trx) : { jobId: null };
            return { view, created: false, transition };
        });
        if (!input.submit) return { view: result.view, created: result.created };
        const sync = await this.verification.finishSubmit(actor, result.transition);
        return { view: await this.getOwn(actor), created: result.created, status: sync?.status ?? (result.created ? 201 : 200), identitySync: sync?.identitySync };
    }

    async update(actor: AuthContext, changes: DoctorProfileChanges): Promise<DoctorProfileView> {
        if (changes.consultationFee !== undefined) this.assertCurrencyAllowed(changes.consultationFee.currency);
        return this.db.transaction(async (trx) => {
            const current = await findProfileByUserIdForUpdate(actor.userId, trx);
            if (current === undefined) throw NotFound;
            if (current.verificationStatus === VerificationStatus.Submitted) throw ApplicationNotEditable;
            const links = await listSpecialtyLinks(current.id, trx);
            if (changes.specialtyIds !== undefined || changes.primarySpecialtyId !== undefined) {
                const ids = changes.specialtyIds ?? links.map((link) => link.specialtyId);
                const currentPrimary = links.find((link) => link.isPrimary)?.specialtyId;
                const primary = changes.primarySpecialtyId ?? currentPrimary;
                if (primary === undefined || !ids.includes(primary)) {
                    if (changes.primarySpecialtyId === undefined) throw PrimarySpecialtyRequired;
                    throw PrimarySpecialtyNotLinked;
                }
                await this.resolveSpecialties(ids, links.map((link) => link.specialtyId), trx);
                changes = { ...changes, primarySpecialtyId: primary };
            }
            return this.applyChanges(actor, current, changes, trx, links);
        });
    }

    private async applyChanges(actor: AuthContext, current: DoctorProfile, changes: DoctorProfileChanges,
        trx: Knex.Transaction, knownLinks?: SpecialtyLink[]): Promise<DoctorProfileView> {
        const [languages, links] = await Promise.all([listLanguages(current.id, trx), knownLinks === undefined ? listSpecialtyLinks(current.id, trx) : Promise.resolve(knownLinks)]);
        const diff = this.diff(current, languages, links, changes);
        if (diff.fields.length === 0) return this.loadView(current, trx, languages, links);
        const updated = await updateProfile(current.id, diff.columns, trx);
        if (diff.languages !== undefined) {
            await deleteLanguagesNotIn(current.id, diff.languages, trx);
            await insertLanguages(current.id, diff.languages, trx);
        }
        if (diff.specialtyIds !== undefined && diff.primarySpecialtyId !== undefined) {
            await deleteLinksNotIn(current.id, diff.specialtyIds, trx);
            await clearPrimaryExcept(current.id, diff.primarySpecialtyId, trx);
            await insertLinks(current.id, diff.specialtyIds.map((specialtyId) => ({ specialtyId, isPrimary: specialtyId === diff.primarySpecialtyId })), trx);
            await markPrimary(current.id, diff.primarySpecialtyId, trx);
        }
        await this.audit.record(trx, { actor: actorFromAuth(actor), action: DoctorAuditAction.ProfileUpdated,
            entityType: DOCTOR_PROFILE_ENTITY_TYPE, entityId: current.id, metadata: { changedFields: diff.fields.sort().join(",") } });
        return this.loadView(updated, trx);
    }

    private diff(current: DoctorProfile, languages: string[], links: SpecialtyLink[], changes: DoctorProfileChanges): DoctorProfileDiff {
        const fields: DoctorProfileField[] = [];
        const columns: DoctorProfileColumnChanges = {};
        if (changes.headline !== undefined && changes.headline !== current.headline) { fields.push(DoctorProfileField.Headline); columns.headline = changes.headline; }
        if (changes.bio !== undefined && changes.bio !== current.bio) { fields.push(DoctorProfileField.Bio); columns.bio = changes.bio; }
        if (changes.yearsExperience !== undefined && changes.yearsExperience !== current.yearsExperience) { fields.push(DoctorProfileField.YearsExperience); columns.years_experience = changes.yearsExperience; }
        if (changes.consultationFee !== undefined && (changes.consultationFee.amount !== current.consultationFeeAmount || changes.consultationFee.currency !== current.currency)) {
            fields.push(DoctorProfileField.ConsultationFee); columns.consultation_fee = changes.consultationFee.amount; columns.currency = changes.consultationFee.currency;
        }
        if (changes.defaultSlotMinutes !== undefined && changes.defaultSlotMinutes !== current.defaultSlotMinutes) { fields.push(DoctorProfileField.DefaultSlotMinutes); columns.default_slot_minutes = changes.defaultSlotMinutes; }
        if (changes.timezone !== undefined) {
            const canonical = canonicalIanaTimezone(changes.timezone);
            if (canonical !== current.timezone) { fields.push(DoctorProfileField.Timezone); columns.timezone = canonical; }
        }
        if (changes.isAcceptingPatients !== undefined && changes.isAcceptingPatients !== current.isAcceptingPatients) { fields.push(DoctorProfileField.IsAcceptingPatients); columns.is_accepting_patients = changes.isAcceptingPatients; }
        const languageChange = changes.languages !== undefined && !sameSet(changes.languages, languages);
        if (languageChange) fields.push(DoctorProfileField.Languages);
        const ids = links.map((link) => link.specialtyId);
        const specialtyChange = changes.specialtyIds !== undefined && !sameSet(changes.specialtyIds, ids);
        if (specialtyChange) fields.push(DoctorProfileField.Specialties);
        const currentPrimary = links.find((link) => link.isPrimary)?.specialtyId;
        const primaryChange = changes.primarySpecialtyId !== undefined && changes.primarySpecialtyId !== currentPrimary;
        if (primaryChange) fields.push(DoctorProfileField.PrimarySpecialty);
        return { fields, columns, languages: languageChange ? changes.languages : undefined,
            specialtyIds: specialtyChange || primaryChange ? (changes.specialtyIds ?? ids) : undefined,
            primarySpecialtyId: specialtyChange || primaryChange ? changes.primarySpecialtyId : undefined };
    }

    private assertCurrencyAllowed(currency: string): void {
        if (!this.env.ALLOWED_CURRENCIES.includes(currency)) throw CurrencyNotAllowed;
    }

    private async resolveSpecialties(ids: number[], alreadyLinked: number[], trx: Knex.Transaction): Promise<Specialty[]> {
        const specialties = await this.specialties.findByIds(ids, trx);
        if (ids.some((id) => !specialties.some((item) => item.id === id && (item.isActive || alreadyLinked.includes(id))))) throw UnknownSpecialty;
        return specialties;
    }

    private async loadView(profile: DoctorProfile, conn: Knex, knownLanguages?: string[], knownLinks?: SpecialtyLink[]): Promise<DoctorProfileView> {
        const [languages, links] = await Promise.all([knownLanguages === undefined ? listLanguages(profile.id, conn) : Promise.resolve(knownLanguages),
            knownLinks === undefined ? listSpecialtyLinks(profile.id, conn) : Promise.resolve(knownLinks)]);
        const specialties = await this.specialties.findByIds(links.map((link) => link.specialtyId), conn);
        const refs: SpecialtyRef[] = specialties.map((item) => ({ id: item.id, slug: item.slug, name: item.name,
            isPrimary: links.some((link) => link.specialtyId === item.id && link.isPrimary) }));
        refs.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name) || a.id - b.id);
        return { profile, languages, specialties: refs };
    }
}
