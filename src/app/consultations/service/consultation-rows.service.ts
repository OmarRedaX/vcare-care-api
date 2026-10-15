import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import { currentRequestId } from "../../../lib/logger/request-context";
import type { Consultation } from "../entity/consultation.entity";
import type { ConsultationChangeKind, ConsultationStatus } from "../enums";
import {
    applyTransition, findById, findByIdForUpdate, isAssignedDoctor, isParticipant, listCalendar, listWaitingRoom, setRoomIfAbsent,
} from "../repository/consultations.repo";
import type { CalendarParams, ConsultationChangeListener, TransitionChanges, WaitingRoomParams } from "../types";

/**
 * Row access for other modules (`sessions`): thin, no rules. It is how a module reaches `consultations` without importing a foreign
 * repository, and the one home of the guarded after-commit listener call.
 */
@injectable()
export class ConsultationRowsService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.Logger) private readonly logger: Logger,
        @inject(TOKENS.ConsultationChangeListener) private readonly listener: ConsultationChangeListener,
    ) {}

    find(id: number, conn: Knex = this.db): Promise<Consultation | undefined> {
        return findById(id, conn);
    }

    /** `SELECT ... FOR UPDATE` of one live row: serializes lifecycle changes. */
    lockForUpdate(id: number, trx: Knex.Transaction): Promise<Consultation | undefined> {
        return findByIdForUpdate(id, trx);
    }

    /** The guarded lifecycle update; zero rows (the status left `from` meanwhile) -> `undefined`. */
    transition(row: Consultation, from: readonly ConsultationStatus[], to: ConsultationStatus, changes: TransitionChanges, trx: Knex.Transaction): Promise<Consultation | undefined> {
        return applyTransition(row, from, to, changes, trx);
    }

    setRoomIfAbsent(id: number, roomId: string, conn: Knex.Transaction | Knex = this.db): Promise<boolean> {
        return setRoomIfAbsent(id, roomId, conn);
    }

    isParticipant(id: number, userId: number): Promise<boolean> {
        return isParticipant(id, userId, this.db);
    }

    isAssignedDoctor(id: number, userId: number): Promise<boolean> {
        return isAssignedDoctor(id, userId, this.db);
    }

    listWaitingRoom(params: WaitingRoomParams, conn: Knex = this.db): Promise<Consultation[]> {
        return listWaitingRoom(params, conn);
    }

    listCalendar(params: CalendarParams, conn: Knex = this.db): Promise<Consultation[]> {
        return listCalendar(params, conn);
    }

    /** After commit; a listener failure is logged (no data) and never fails the committed write. */
    async notifyChanged(kind: ConsultationChangeKind, consultation: Consultation): Promise<void> {
        try {
            await this.listener.onConsultationChanged({ kind, doctorUserId: consultation.doctorUserId, consultationId: consultation.id });
        } catch {
            this.logger.error("consultation_change_listener_failed", { requestId: currentRequestId(), consultationId: consultation.id, kind });
        }
    }
}
