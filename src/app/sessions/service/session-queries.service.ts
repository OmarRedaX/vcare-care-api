import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { hydrateUsersOrEmpty } from "../../../lib/identity-client/hydrate";
import type { IdentityClient } from "../../../lib/identity-client/identity-client";
import type { Logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { AuthContext, Clock } from "../../../lib/types/types";
import { toMs } from "../../../pkg/utils/time";
import type { Consultation } from "../../consultations/entity/consultation.entity";
import { TimeRangeReversed } from "../../consultations/errors";
import { ConsultationRowsService } from "../../consultations/service/consultation-rows.service";
import type { ConsultationViewer, RenderedConsultation } from "../../consultations/types";
import { buildConsultationView } from "../../consultations/view";
import { DoctorsService } from "../../doctors/service/doctors.service";
import { SchedulesService } from "../../schedules/service/schedules.service";
import { CALENDAR_MAX_ENTRIES, CALENDAR_MAX_WINDOW_DAYS, WAITING_ROOM_MAX_ENTRIES } from "../constants";
import { CalendarWindowTooLarge } from "../errors";
import type { CalendarQuery, RenderedCalendar } from "../types";

/**
 * Read side of `sessions`: the doctor's waiting room and calendar with Case 2 hydration (one batched Identity call per response,
 * degrading to unhydrated patients), and the rendering of the actor's own session write responses. No session response carries
 * `complaintText` (SS-R16): the doctor reads it through the audited get-one.
 */
@injectable()
export class SessionQueriesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.Clock) private readonly clock: Clock,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.IDENTITY_CLIENT) private readonly identity: IdentityClient,
        @inject(TOKENS.ConsultationRowsService) private readonly rows: ConsultationRowsService,
        @inject(TOKENS.DoctorsService) private readonly doctors: DoctorsService,
        @inject(TOKENS.SchedulesService) private readonly schedules: SchedulesService,
    ) {}

    async waitingRoom(actor: AuthContext): Promise<RenderedConsultation[]> {
        const doctorTimezone = await this.doctors.findTimezone(actor.userId, this.db);
        const consultations = await this.rows.listWaitingRoom({ doctorUserId: actor.userId, nowMs: this.clock.now(),
            openMinutes: this.env.WAITING_ROOM_OPEN_MINUTES, overrunMinutes: this.env.SESSION_OVERRUN_MINUTES, limit: WAITING_ROOM_MAX_ENTRIES }, this.db);
        return this.render(actor, consultations, undefined, doctorTimezone);
    }

    async calendar(actor: AuthContext, query: CalendarQuery): Promise<RenderedCalendar> {
        if (query.fromMs >= query.toMs) throw TimeRangeReversed;
        if (query.toMs - query.fromMs > toMs(CALENDAR_MAX_WINDOW_DAYS, "d")) throw CalendarWindowTooLarge;
        const { timezone: doctorTimezone, exceptions } = await this.schedules.listExceptionsForCalendar(actor.userId, query.fromMs, query.toMs, this.db);
        const consultations = await this.rows.listCalendar({ doctorUserId: actor.userId, fromMs: query.fromMs, toMs: query.toMs, limit: CALENDAR_MAX_ENTRIES }, this.db);
        // Counts only: the window is capped, never silently larger than what was returned.
        if (consultations.length >= CALENDAR_MAX_ENTRIES) {
            this.logger.warn("calendar_truncated", { requestId: currentRequestId(), count: consultations.length, limit: CALENDAR_MAX_ENTRIES });
        }
        const timezone = query.timezone ?? doctorTimezone;
        return { fromMs: query.fromMs, toMs: query.toMs, timezone, items: await this.render(actor, consultations, query.timezone, doctorTimezone), exceptions };
    }

    /** The actor's own session write response: both participants unhydrated, no clinical detail. */
    async renderOwn(actor: AuthContext, consultation: Consultation): Promise<RenderedConsultation> {
        const doctorTimezone = actor.role === "doctor" ? await this.doctors.findTimezone(actor.userId, this.db) : undefined;
        const viewer: ConsultationViewer = { userId: actor.userId, role: actor.role };
        return { consultation, view: buildConsultationView(consultation, viewer, { timezone: undefined, doctorTimezone }, new Map(), false) };
    }

    /** One batched Identity call for the distinct patients; the doctor side is the caller's own and stays unhydrated. */
    private async render(actor: AuthContext, consultations: readonly Consultation[], timezone: string | undefined,
        doctorTimezone: string | undefined): Promise<RenderedConsultation[]> {
        const users = await hydrateUsersOrEmpty(this.identity, this.logger, consultations.map((consultation) => consultation.patientUserId));
        const viewer: ConsultationViewer = { userId: actor.userId, role: actor.role };
        return consultations.map((consultation) => ({ consultation, view: buildConsultationView(consultation, viewer, { timezone, doctorTimezone }, users, false) }));
    }
}
