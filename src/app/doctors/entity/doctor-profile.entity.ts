import type { IdentitySyncStatus, VerificationStatus } from "../enums";

export class DoctorProfile {
    id!: number;
    userId!: number;
    headline!: string;
    bio!: string | null;
    yearsExperience!: number;
    consultationFeeAmount!: number;
    currency!: string;
    defaultSlotMinutes!: number;
    timezone!: string;
    isAcceptingPatients!: boolean;
    verificationStatus!: VerificationStatus;
    submittedAt!: Date | null;
    reviewedBy!: number | null;
    reviewNote!: string | null;
    decidedAt!: Date | null;
    identitySyncStatus!: IdentitySyncStatus;
    suspendedAt!: Date | null;
    suspendedBy!: number | null;
    suspensionReason!: string | null;
    createdAt!: Date;
    updatedAt!: Date;
    deletedAt!: Date | null;

    constructor(data: Partial<DoctorProfile>) { Object.assign(this, data); }
}
