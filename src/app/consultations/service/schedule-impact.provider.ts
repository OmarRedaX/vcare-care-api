import type { Knex } from "knex";
import { localInstant } from "../../../pkg/slots/instant";
import { addDays, localDateOf } from "../../../pkg/slots/local-date";
import { isCoveredByOpenIntervals } from "../../../pkg/slots/slot-fit";
import { OutboxKind } from "../../notifications/enums";
import type { ScheduleChange, ScheduleImpactContext, ScheduleImpactProvider } from "../../schedules/types";
import { OPEN_DAYS_MARGIN } from "../constants";
import { FollowupReason } from "../enums";
import { flagConsultations, listAffectedCandidates } from "../repository/consultations.repo";
import type { CandidateWindow, ScheduleImpactDeps } from "../types";

/** The UTC window a change can strand consultations in; `null` (working hours) means every future consultation. */
function windowOf(change: ScheduleChange, timezone: string): CandidateWindow | null {
    if (change.kind === "working_hours") return null;
    const fromDate = change.kind === "schedule_exception_created" ? change.fromDate : change.date;
    const toDate = change.kind === "schedule_exception_created" ? change.toDate : change.date;
    return { fromMs: localInstant(fromDate, 0, timezone, "start"), toMs: localInstant(toDate, 1440, timezone, "end") };
}

/**
 * Domain: "Schedule changes" (PRD 7.3 flow F). `findAffected` reads the NEW schedule through the write's transaction and reports
 * future `booked`/`waiting`/`in_progress` consultations no longer inside ONE open interval (containment only: the slot grid is not
 * re-checked, so a shifted shift anchor does not flag every booking). `flagAffected` flags them `schedule_blocked` and queues one
 * `schedule_blocked` notification per patient; it never cancels or moves a consultation. Three queries however many rows.
 *
 * `SchedulesService` injects this provider, so it is looked up lazily (`getSchedules`) to keep the constructors acyclic.
 */
export function buildScheduleImpactProvider(deps: ScheduleImpactDeps): ScheduleImpactProvider {
    return {
        async findAffected(ctx: ScheduleImpactContext, trx: Knex.Transaction): Promise<number[]> {
            const candidates = await listAffectedCandidates(ctx.doctorUserId, ctx.now, windowOf(ctx.change, ctx.timezone), trx);
            if (candidates.length === 0) return [];
            const firstStart = Math.min(...candidates.map((row) => row.starts_at.getTime()));
            const lastEnd = Math.max(...candidates.map((row) => row.ends_at.getTime()));
            const fromDate = addDays(localDateOf(firstStart, ctx.timezone), -OPEN_DAYS_MARGIN);
            const toDate = addDays(localDateOf(lastEnd - 1, ctx.timezone), OPEN_DAYS_MARGIN);
            const days = await deps.getSchedules().resolveOpenDays(ctx.doctorProfileId, ctx.timezone, fromDate, toDate, trx);
            return candidates
                .filter((row) => !isCoveredByOpenIntervals(days, row.starts_at.getTime(), row.ends_at.getTime()))
                .map((row) => row.id);
        },

        async flagAffected(ctx: ScheduleImpactContext, ids: readonly number[], trx: Knex.Transaction): Promise<void> {
            const flagged = await flagConsultations(ids, ctx.doctorUserId, FollowupReason.ScheduleBlocked, trx);
            await deps.notifications.enqueue(trx, flagged.map((row) => ({
                kind: OutboxKind.ScheduleBlocked, consultationId: row.id, recipientUserId: row.patient_user_id,
                payload: { startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), recipientRole: "patient" },
            })));
        },
    };
}
