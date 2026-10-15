import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { actorFromAuth, AuditRecorder } from "../../../lib/audit/audit";
import { settleWithin } from "../../../lib/async/settle-within";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound } from "../../../lib/error/errors";
import type { Logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { AuthContext, Clock } from "../../../lib/types/types";
import type { VideoParticipantRole, VideoRoomProvider } from "../../../lib/video/types";
import { VideoProviderError } from "../../../lib/video/video-error";
import { isInsideWindow, sessionWindow } from "../../../pkg/utils/session-window";
import type { SessionWindow } from "../../../pkg/utils/types";
import { toMs } from "../../../pkg/utils/time";
import { CONSULTATION_ENTITY_TYPE } from "../../consultations/constants";
import type { Consultation } from "../../consultations/entity/consultation.entity";
import { ConsultationAuditAction, ConsultationChangeKind, ConsultationStatus } from "../../consultations/enums";
import { InvalidTransition } from "../../consultations/errors";
import { ConsultationRowsService } from "../../consultations/service/consultation-rows.service";
import { OutboxKind } from "../../notifications/enums";
import { NotificationsService } from "../../notifications/service/notifications.service";
import { VIDEO_CALL_TIMEOUT_MS } from "../constants";
import { NoShowTooEarly, RoomNotOpen, VideoUnavailable } from "../errors";
import type { NoShowInput, SessionJoinResult } from "../types";

/** Resolves `settleWithin` when the provider call exceeded its bound (an object, so it can never equal a provider result). */
const PROVIDER_TIMED_OUT = { timedOut: true } as const;
const TERMINAL_STATUSES: readonly ConsultationStatus[] = [ConsultationStatus.Completed, ConsultationStatus.Cancelled, ConsultationStatus.NoShow];
const START_FROM: readonly ConsultationStatus[] = [ConsultationStatus.Booked, ConsultationStatus.Waiting];

/**
 * Join, start, complete and no-show (Domain rules 9, 11, 12). State first, provider second, token last: the room is created
 * BEFORE the transaction (idempotent per consultation) and the join token issued AFTER the commit, so no transaction ever holds a
 * provider call and a provider failure never corrupts the lifecycle. Every transition is a status-guarded update under the row
 * lock; the checks here give the precise error. Session writes make no Identity call.
 */
@injectable()
export class SessionsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.Clock) private readonly clock: Clock,
        @inject(TOKENS.ConsultationRowsService) private readonly rows: ConsultationRowsService,
        @inject(TOKENS.NotificationsService) private readonly notifications: NotificationsService,
        @inject(TOKENS.VideoProvider) private readonly video: VideoRoomProvider,
    ) {}

    async join(actor: AuthContext, id: number): Promise<SessionJoinResult> {
        const now = this.clock.now();
        const seen = await this.rows.find(id);
        if (seen === undefined || !this.isParticipant(actor, seen)) throw NotFound;
        this.assertJoinable(seen, now);
        const ensuredRoomId = await this.resolveRoom(seen);
        // A patient on a booked row is the only transition; every other participant gets a token for the current state.
        const row = actor.role === "patient" && seen.status === ConsultationStatus.Booked
            ? await this.db.transaction((trx) => this.admitPatient(actor, id, ensuredRoomId, now, trx))
            : seen;
        const roomId = await this.persistRoom(row, ensuredRoomId);
        return this.withToken(row, actor, roomId, now);
    }

    async start(actor: AuthContext, id: number): Promise<SessionJoinResult> {
        const now = this.clock.now();
        const seen = await this.rows.find(id);
        if (seen === undefined || seen.doctorUserId !== actor.userId) throw NotFound;
        this.assertStartable(seen, now);
        const ensuredRoomId = await this.resolveRoom(seen);
        const started = await this.db.transaction(async (trx) => {
            const locked = await this.rows.lockForUpdate(id, trx);
            if (locked === undefined) throw NotFound;
            this.assertStartable(locked, now);
            const updated = await this.rows.transition(locked, START_FROM, ConsultationStatus.InProgress,
                { started_at: new Date(now), ...(locked.roomId === null ? { room_id: ensuredRoomId } : {}) }, trx);
            if (updated === undefined) throw InvalidTransition;
            await this.notifications.enqueue(trx, [{ kind: OutboxKind.DoctorJoined, consultationId: updated.id, recipientUserId: updated.patientUserId,
                payload: { startsAt: updated.startsAt.toISOString(), endsAt: updated.endsAt.toISOString(), recipientRole: "patient" } }]);
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Started, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: updated.id, metadata: { byRole: actor.role, fromStatus: locked.status } });
            return updated;
        });
        return this.withToken(started, actor, started.roomId ?? ensuredRoomId, now);
    }

    async complete(actor: AuthContext, id: number): Promise<Consultation> {
        const now = this.clock.now();
        const seen = await this.rows.find(id);
        if (seen === undefined || seen.doctorUserId !== actor.userId) throw NotFound;
        const completed = await this.db.transaction(async (trx) => {
            const locked = await this.rows.lockForUpdate(id, trx);
            if (locked === undefined) throw NotFound;
            // No window check: the doctor may overrun the session.
            if (locked.status !== ConsultationStatus.InProgress) throw InvalidTransition;
            const updated = await this.rows.transition(locked, [ConsultationStatus.InProgress], ConsultationStatus.Completed, { completed_at: new Date(now) }, trx);
            if (updated === undefined) throw InvalidTransition;
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Completed, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: updated.id, metadata: { byRole: actor.role } });
            return updated;
        });
        await this.rows.notifyChanged(ConsultationChangeKind.Completed, completed);
        return completed;
    }

    async noShow(actor: AuthContext, id: number, input: NoShowInput): Promise<Consultation> {
        const now = this.clock.now();
        const seen = await this.rows.find(id);
        if (seen === undefined || (actor.role === "doctor" && seen.doctorUserId !== actor.userId)) throw NotFound;
        this.assertNoShowAllowed(seen, now);
        const marked = await this.db.transaction(async (trx) => {
            const locked = await this.rows.lockForUpdate(id, trx);
            if (locked === undefined) throw NotFound;
            this.assertNoShowAllowed(locked, now);
            const updated = await this.rows.transition(locked, START_FROM, ConsultationStatus.NoShow, { no_show_marked_at: new Date(now) }, trx);
            if (updated === undefined) throw InvalidTransition;
            // The note is never stored or audited as text: only its length, and only when it says something.
            const note = input.note;
            await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.NoShow, entityType: CONSULTATION_ENTITY_TYPE,
                entityId: updated.id, metadata: { byRole: actor.role, fromStatus: locked.status,
                    ...(note !== undefined && note.trim().length > 0 ? { noteLength: [...note].length } : {}) } });
            return updated;
        });
        await this.rows.notifyChanged(ConsultationChangeKind.NoShow, marked);
        return marked;
    }

    /** Patient on a `booked` row: lock, re-check against the locked row (a reschedule may have moved it), then `booked -> waiting`. */
    private async admitPatient(actor: AuthContext, id: number, ensuredRoomId: string, now: number, trx: Knex.Transaction): Promise<Consultation> {
        const locked = await this.rows.lockForUpdate(id, trx);
        if (locked === undefined) throw NotFound;
        this.assertJoinable(locked, now);
        // A concurrent join already admitted the patient: this call is token-only.
        if (locked.status !== ConsultationStatus.Booked) return locked;
        const updated = await this.rows.transition(locked, [ConsultationStatus.Booked], ConsultationStatus.Waiting,
            { joined_at: new Date(now), ...(locked.roomId === null ? { room_id: ensuredRoomId } : {}) }, trx);
        if (updated === undefined) throw InvalidTransition;
        await this.audit.record(trx, { actor: actorFromAuth(actor), action: ConsultationAuditAction.Waiting, entityType: CONSULTATION_ENTITY_TYPE,
            entityId: updated.id, metadata: { byRole: actor.role, fromStatus: ConsultationStatus.Booked } });
        return updated;
    }

    private isParticipant(actor: AuthContext, row: Consultation): boolean {
        return (actor.role === "patient" && row.patientUserId === actor.userId) || (actor.role === "doctor" && row.doctorUserId === actor.userId);
    }

    private windowOf(row: Consultation): SessionWindow {
        return sessionWindow(row.startsAt.getTime(), row.endsAt.getTime(), this.env.WAITING_ROOM_OPEN_MINUTES, this.env.SESSION_OVERRUN_MINUTES);
    }

    /** SS-R3: a terminal row always answers `InvalidTransition`, never `RoomNotOpen`. */
    private assertJoinable(row: Consultation, now: number): void {
        if (TERMINAL_STATUSES.includes(row.status)) throw InvalidTransition;
        if (!isInsideWindow(this.windowOf(row), now)) throw RoomNotOpen;
    }

    /** SS-R6: `start` only from `booked`/`waiting`; `in_progress` is `InvalidTransition` even outside the window, so a second start never re-notifies. */
    private assertStartable(row: Consultation, now: number): void {
        if (!START_FROM.includes(row.status)) throw InvalidTransition;
        if (!isInsideWindow(this.windowOf(row), now)) throw RoomNotOpen;
    }

    /** SS-R9: `no-show` only from `booked`/`waiting`, once `now >= startsAt + grace` (exactly on the boundary is allowed). */
    private assertNoShowAllowed(row: Consultation, now: number): void {
        if (!START_FROM.includes(row.status)) throw InvalidTransition;
        if (now < row.startsAt.getTime() + toMs(this.env.NO_SHOW_GRACE_MINUTES, "min")) throw NoShowTooEarly;
    }

    /** The stored room, else one created at the provider (idempotent per consultation) outside any transaction. */
    private async resolveRoom(row: Consultation): Promise<string> {
        if (row.roomId !== null) return row.roomId;
        const room = await this.callProvider("ensure_room", () => this.video.ensureRoom({ consultationId: row.id, startsAtMs: row.startsAt.getTime(), endsAtMs: row.endsAt.getTime() }));
        return room.roomId;
    }

    /** Token-only paths (a doctor on `booked`) persist a room that was never stored; the stored value wins over a concurrent call. */
    private async persistRoom(row: Consultation, ensuredRoomId: string): Promise<string> {
        if (row.roomId !== null) return row.roomId;
        if (await this.rows.setRoomIfAbsent(row.id, ensuredRoomId)) return ensuredRoomId;
        return (await this.rows.find(row.id))?.roomId ?? ensuredRoomId;
    }

    /** After commit: the participant's token, capped at the window close. A failure leaves the committed state valid; `join` repairs it. */
    private async withToken(row: Consultation, actor: AuthContext, roomId: string, now: number): Promise<SessionJoinResult> {
        const window = this.windowOf(row);
        const role: VideoParticipantRole = actor.role === "doctor" ? "doctor" : "patient";
        const expiresAtMs = Math.min(now + toMs(this.env.VIDEO_JOIN_TOKEN_TTL_SECONDS, "s"), window.closesAtMs);
        const token = await this.callProvider("issue_token", () => this.video.issueJoinToken({ roomId, userId: actor.userId, role, expiresAtMs }));
        return { consultation: row, roomId, joinToken: token.token, joinTokenExpiresAt: new Date(token.expiresAtMs),
            windowOpensAt: new Date(window.opensAtMs), windowClosesAt: new Date(window.closesAtMs) };
    }

    /** One bounded provider call. Any failure or timeout is `VideoUnavailable`; only a safe code is logged (never provider text). */
    private async callProvider<T>(operation: "ensure_room" | "issue_token", call: () => Promise<T>): Promise<T> {
        let code = "timeout";
        try {
            const outcome = await settleWithin<{ value: T } | typeof PROVIDER_TIMED_OUT>(call().then((value) => ({ value })), VIDEO_CALL_TIMEOUT_MS, PROVIDER_TIMED_OUT);
            if ("value" in outcome) return outcome.value;
        } catch (error) {
            code = error instanceof VideoProviderError ? error.code : "error";
        }
        this.logger.warn("video_provider_failed", { requestId: currentRequestId(), operation, code });
        throw VideoUnavailable;
    }
}
