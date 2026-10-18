import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { TOKENS } from "../../../lib/di/tokens";
import { Forbidden, NotFound } from "../../../lib/error/errors";
import { decodeTimestampCursor } from "../../../lib/http/pagination/cursor";
import { buildPage, resolveLimit } from "../../../lib/http/pagination/page";
import { hydrateUsersOrEmpty } from "../../../lib/identity-client/hydrate";
import type { IdentityClient } from "../../../lib/identity-client/identity-client";
import type { HydratedUser } from "../../../lib/identity-client/types";
import type { Logger } from "../../../lib/logger/logger";
import type { AuthContext, Clock } from "../../../lib/types/types";
import { canonicalIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { DoctorsService } from "../../doctors/service/doctors.service";
import { RecordLinksService } from "../../records/service/record-links.service";
import { CONSULTATION_ENTITY_TYPE } from "../constants";
import type { Consultation } from "../entity/consultation.entity";
import { ConsultationAuditAction, ConsultationStatus } from "../enums";
import { TimeRangeReversed } from "../errors";
import { findById, listPage } from "../repository/consultations.repo";
import type { ConsultationListQuery, ConsultationViewer, RenderedConsultation, RenderedConsultationPage, ViewContext } from "../types";
import { buildConsultationView, userIdsToHydrate } from "../view";

/**
 * Read side: list and get-one with Case 2 hydration (one batched Identity call per page, degrades to unhydrated
 * participants and never fails the read), plus the rendering of the actor's own write responses.
 */
@injectable()
export class ConsultationQueriesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Clock) private readonly clock: Clock,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.IDENTITY_CLIENT) private readonly identity: IdentityClient,
        @inject(TOKENS.DoctorsService) private readonly doctors: DoctorsService,
        @inject(TOKENS.RecordLinksService) private readonly records: RecordLinksService,
    ) {}

    async list(actor: AuthContext, query: ConsultationListQuery): Promise<RenderedConsultationPage> {
        const admin = actor.role === "admin";
        // The admin-only filters are checked before any query: a non-admin cannot even probe them (spec C2).
        if (!admin && (query.doctorUserId !== undefined || query.patientUserId !== undefined || query.needsAdminFollowup !== undefined)) throw Forbidden;
        if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs >= query.toMs) throw TimeRangeReversed;
        const limit = resolveLimit(query.limit);
        const after = query.cursor === undefined ? null : decodeTimestampCursor(query.cursor);
        const context = await this.viewContext(actor, query.timezone);
        const entries = await listPage({
            // The participant predicate comes from the verified principal, never from the query.
            doctorUserId: actor.role === "doctor" ? actor.userId : admin ? query.doctorUserId ?? null : null,
            patientUserId: actor.role === "patient" ? actor.userId : admin ? query.patientUserId ?? null : null,
            scope: query.scope, statuses: query.statuses ?? null, from: query.fromMs === undefined ? null : new Date(query.fromMs),
            to: query.toMs === undefined ? null : new Date(query.toMs), needsAdminFollowup: query.needsAdminFollowup ?? null,
            now: new Date(this.clock.now()), after, fetch: limit + 1,
        }, this.db);
        const page = buildPage(entries, limit, (entry) => [entry.cursorTimestamp, entry.consultation.id]);
        const viewer: ConsultationViewer = { userId: actor.userId, role: actor.role };
        const users = await this.hydrate(page.items.flatMap((entry) => userIdsToHydrate(viewer, entry.consultation)));
        // One batched lookup per page, over the completed rows only (nothing else can have a record); none when there are no completed rows.
        const recorded = await this.records.recordedConsultationIds(page.items.filter((entry) => entry.consultation.status === ConsultationStatus.Completed)
            .map((entry) => entry.consultation.id), this.db);
        return { items: page.items.map((entry) => ({ consultation: entry.consultation, view: buildConsultationView(entry.consultation, viewer, context, users, false, recorded) })), meta: page.meta };
    }

    async get(actor: AuthContext, id: number, timezone: string | undefined): Promise<RenderedConsultation> {
        const consultation = actor.role === "admin" ? await this.readAsAdmin(id) : await this.readAsParticipant(actor, id);
        const viewer: ConsultationViewer = { userId: actor.userId, role: actor.role };
        const context = await this.viewContext(actor, timezone);
        const users = await this.hydrate(userIdsToHydrate(viewer, consultation));
        // Outside the audit transaction (read-only): existence of a record is a boolean, not clinical content; only a completed row can have one.
        const recorded = await this.records.recordedConsultationIds(consultation.status === ConsultationStatus.Completed ? [consultation.id] : [], this.db);
        return { consultation, view: buildConsultationView(consultation, viewer, context, users, true, recorded) };
    }

    /**
     * The actor's own write response: both participants unhydrated (decision 1.5.5), clinical detail allowed for participants.
     * `hasRecord` is truthful: a booking replayed through the database idempotency path returns the CURRENT row, which can be completed and
     * recorded by now. The lookup runs only for a completed row (every other status can never have a record), so the normal write path
     * makes no extra query.
     */
    async renderOwn(actor: AuthContext, consultation: Consultation): Promise<RenderedConsultation> {
        const viewer: ConsultationViewer = { userId: actor.userId, role: actor.role };
        const recorded = await this.records.recordedConsultationIds(consultation.status === ConsultationStatus.Completed ? [consultation.id] : [], this.db);
        // No hydration map: every participant, the counterpart included, renders as `profileHydrated: false`.
        return { consultation, view: buildConsultationView(consultation, viewer, await this.viewContext(actor, undefined), new Map(), true, recorded) };
    }

    /** Admin: no clinical field is emitted, so no audit row (spec C-R15). */
    private async readAsAdmin(id: number): Promise<Consultation> {
        const row = await findById(id, this.db);
        if (row === undefined) throw NotFound;
        return row;
    }

    /** A participant's read is a clinical read: the audit row commits in the read's transaction. Non-participants get 404. */
    private readAsParticipant(actor: AuthContext, id: number): Promise<Consultation> {
        return this.db.transaction(async (trx) => {
            const row = await findById(id, trx);
            const participant = row !== undefined && ((actor.role === "patient" && row.patientUserId === actor.userId)
                || (actor.role === "doctor" && row.doctorUserId === actor.userId));
            if (row === undefined || !participant) throw NotFound;
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Read, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: row.id, metadata: { viewerRole: actor.role } });
            return row;
        });
    }

    private async viewContext(actor: AuthContext, timezone: string | undefined): Promise<ViewContext> {
        return {
            timezone: timezone === undefined ? undefined : canonicalIanaTimezone(timezone),
            doctorTimezone: actor.role === "doctor" ? await this.doctors.findTimezone(actor.userId, this.db) : undefined,
        };
    }

    private hydrate(userIds: readonly number[]): Promise<Map<number, HydratedUser>> {
        return hydrateUsersOrEmpty(this.identity, this.logger, userIds);
    }
}
