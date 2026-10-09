import type { Knex } from "knex";
import type { UserPolicy } from "../../lib/rbac/types";
import type { IdentitySyncStatus } from "../doctors/enums";

export interface SuspensionImpactContext { doctorProfileId: number; doctorUserId: number; now: Date }

/** Port for the consultations that a suspension strands (default no-op; `consultations` rebinds `TOKENS.SuspensionImpactProvider`). */
export interface SuspensionImpactProvider {
    /** Inside the suspension transaction: flag future non-terminal consultations; return their ids ascending. Never cancels or moves one. */
    flagFutureConsultations(ctx: SuspensionImpactContext, trx: Knex.Transaction): Promise<number[]>;
    /** Read-only: ids currently flagged `doctor_suspended` (future, non-terminal), for the no-op response. */
    listFlaggedConsultations(ctx: SuspensionImpactContext, conn: Knex): Promise<number[]>;
}

export interface SuspensionView { doctorUserId: number; suspendedAt: Date; identitySyncStatus: IdentitySyncStatus; flaggedConsultationIds: number[] }
/** `confirmed` = Identity confirmed the suspension (200); otherwise the controller answers 503 with the same view. */
export interface SuspendOutcome { view: SuspensionView; confirmed: boolean }
export interface ReinstatementView { doctorUserId: number; reinstatedAt: Date; identitySyncStatus: IdentitySyncStatus }
export interface ReinstateOutcome { view: ReinstatementView; status: 200 | 202; identitySync?: "pending" | "failed" }

/** What the suspend decision transaction decided: nothing to do, or a committed suspension whose job must now be synced. */
export type SuspendDecision =
    | { kind: "noop"; outcome: SuspendOutcome }
    | { kind: "applied"; jobId: number; doctorUserId: number; suspendedAt: Date; flaggedConsultationIds: number[] };
export type ReinstateDecision =
    | { kind: "noop"; outcome: ReinstateOutcome }
    | { kind: "applied"; jobId: number; doctorUserId: number; reinstatedAt: Date };

export interface AdminDoctorsPolicies { suspend: UserPolicy; reinstate: UserPolicy }
