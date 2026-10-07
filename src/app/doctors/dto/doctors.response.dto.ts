import type { DoctorProfileView, SpecialtyRef } from "../types";
import { VerificationStatus } from "../enums";
import { isBookable } from "../service/doctors.service";

export class MoneyResponseDto {
    amount!: number;
    currency!: string;
    static from(amount: number, currency: string): MoneyResponseDto { return { amount, currency }; }
}

export class SpecialtyRefResponseDto {
    id!: number;
    slug!: string;
    name!: string;
    isPrimary!: boolean;
    static from(ref: SpecialtyRef): SpecialtyRefResponseDto {
        return { id: ref.id, slug: ref.slug, name: ref.name, isPrimary: ref.isPrimary };
    }
}

export class DoctorProfileOwnResponseDto {
    id!: number;
    userId!: number;
    headline!: string;
    bio!: string | null;
    yearsExperience!: number;
    languages!: string[];
    specialties!: SpecialtyRefResponseDto[];
    consultationFee!: MoneyResponseDto;
    defaultSlotMinutes!: number;
    timezone!: string;
    isAcceptingPatients!: boolean;
    verificationStatus!: string;
    reviewNote!: string | null;
    identitySyncStatus!: string;
    isSuspended!: boolean;
    suspendedAt!: string | null;
    isBookable!: boolean;
    createdAt!: string;
    updatedAt!: string;
    static from(view: DoctorProfileView): DoctorProfileOwnResponseDto {
        const p = view.profile;
        return {
            id: p.id, userId: p.userId, headline: p.headline, bio: p.bio, yearsExperience: p.yearsExperience,
            languages: [...view.languages].sort(), specialties: view.specialties.map((ref) => SpecialtyRefResponseDto.from(ref)),
            consultationFee: MoneyResponseDto.from(p.consultationFeeAmount, p.currency),
            defaultSlotMinutes: p.defaultSlotMinutes, timezone: p.timezone,
            isAcceptingPatients: p.isAcceptingPatients, verificationStatus: p.verificationStatus,
            reviewNote: p.reviewNote, identitySyncStatus: p.identitySyncStatus,
            isSuspended: p.suspendedAt !== null, suspendedAt: p.suspendedAt?.toISOString() ?? null,
            isBookable: isBookable(p, false), createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
        };
    }
}

export class VerificationApplicationResponseDto {
    id!: number;
    doctorUserId!: number;
    doctor!: { displayName: null; avatarUrl: null; profileHydrated: false };
    status!: string;
    identitySyncStatus!: string;
    specialties!: SpecialtyRefResponseDto[];
    yearsExperience!: number;
    submittedAt!: string | null;
    decidedAt!: string | null;
    reviewedBy!: number | null;
    reviewNote!: string | null;
    documents!: [];
    missingRequirements!: string[];
    static from(view: DoctorProfileView): VerificationApplicationResponseDto {
        const p = view.profile;
        return {
            id: p.id, doctorUserId: p.userId,
            doctor: { displayName: null, avatarUrl: null, profileHydrated: false },
            status: p.verificationStatus, identitySyncStatus: p.identitySyncStatus,
            specialties: view.specialties.map((ref) => SpecialtyRefResponseDto.from(ref)), yearsExperience: p.yearsExperience,
            submittedAt: p.submittedAt?.toISOString() ?? null, decidedAt: p.decidedAt?.toISOString() ?? null,
            reviewedBy: p.reviewedBy, reviewNote: p.reviewNote, documents: [],
            missingRequirements: p.verificationStatus === VerificationStatus.Draft || p.verificationStatus === VerificationStatus.Rejected ? ["license_document", "id_document"] : [],
        };
    }
}
