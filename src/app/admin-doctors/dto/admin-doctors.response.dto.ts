import type { ReinstatementView, SuspensionView } from "../types";

export class SuspensionResultResponseDto {
    doctorUserId!: number; suspendedAt!: string; identitySyncStatus!: string; flaggedConsultationIds!: number[];
    static from(view: SuspensionView): SuspensionResultResponseDto {
        return { doctorUserId: view.doctorUserId, suspendedAt: view.suspendedAt.toISOString(), identitySyncStatus: view.identitySyncStatus, flaggedConsultationIds: [...view.flaggedConsultationIds] };
    }
}
export class ReinstatementResultResponseDto {
    doctorUserId!: number; reinstatedAt!: string; identitySyncStatus!: string;
    static from(view: ReinstatementView): ReinstatementResultResponseDto {
        return { doctorUserId: view.doctorUserId, reinstatedAt: view.reinstatedAt.toISOString(), identitySyncStatus: view.identitySyncStatus };
    }
}
