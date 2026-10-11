import type { Knex } from "knex";
import type { SuspensionImpactContext, SuspensionImpactProvider } from "../../admin-doctors/types";
import { FollowupReason } from "../enums";
import { flagFutureForDoctor, listFlaggedIds } from "../repository/consultations.repo";

/**
 * Case 3 port (bound to `TOKENS.SuspensionImpactProvider` in `bootstrap.ts`). Runs inside the suspension transaction; never cancels
 * or moves a consultation, never calls Identity, and queues no notification (no suspension email kind exists).
 */
export class ConsultationSuspensionImpactProvider implements SuspensionImpactProvider {
    async flagFutureConsultations(ctx: SuspensionImpactContext, trx: Knex.Transaction): Promise<number[]> {
        const flagged = await flagFutureForDoctor(ctx.doctorUserId, ctx.now, FollowupReason.DoctorSuspended, trx);
        return flagged.map((row) => row.id);
    }

    listFlaggedConsultations(ctx: SuspensionImpactContext, conn: Knex): Promise<number[]> {
        return listFlaggedIds(ctx.doctorUserId, FollowupReason.DoctorSuspended, ctx.now, conn);
    }
}
