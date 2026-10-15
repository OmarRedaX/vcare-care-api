import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import type { SuspensionImpactContext, SuspensionImpactProvider } from "../../admin-doctors/types";
import { OutboxKind } from "../../notifications/enums";
import type { NotificationsService } from "../../notifications/service/notifications.service";
import { FollowupReason } from "../enums";
import { flagFutureForDoctor, listFlaggedIds } from "../repository/consultations.repo";

/**
 * Case 3 port (bound to `TOKENS.SuspensionImpactProvider` in `bootstrap.ts`). Runs inside the suspension transaction; never cancels
 * or moves a consultation and never calls Identity. Queues one `doctor_suspended` notice per patient whose consultation was newly
 * flagged (flag-once, same transaction), so a repeated suspension does not notify again.
 */
@injectable()
export class ConsultationSuspensionImpactProvider implements SuspensionImpactProvider {
    constructor(@inject(TOKENS.NotificationsService) private readonly notifications: NotificationsService) {}

    async flagFutureConsultations(ctx: SuspensionImpactContext, trx: Knex.Transaction): Promise<number[]> {
        const flagged = await flagFutureForDoctor(ctx.doctorUserId, ctx.now, FollowupReason.DoctorSuspended, trx);
        await this.notifications.enqueue(trx, flagged.filter((row) => row.newly_flagged).map((row) => ({
            kind: OutboxKind.DoctorSuspended, consultationId: row.id, recipientUserId: row.patient_user_id,
            payload: { startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), recipientRole: "patient" },
        })));
        return flagged.map((row) => row.id);
    }

    listFlaggedConsultations(ctx: SuspensionImpactContext, conn: Knex): Promise<number[]> {
        return listFlaggedIds(ctx.doctorUserId, FollowupReason.DoctorSuspended, ctx.now, conn);
    }
}
