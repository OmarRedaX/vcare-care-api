import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { exponentialBackoffMs } from "../../../lib/async/backoff";
import { settleWithin } from "../../../lib/async/settle-within";
import type { EmailPort, EmailSendResult } from "../../../lib/email/types";
import type { IdentityClient } from "../../../lib/identity-client/identity-client";
import type { Logger } from "../../../lib/logger/logger";
import type { TickOutcome } from "../../../lib/worker/types";
import {
    EMAIL_SEND_TIMEOUT_MS, OUTBOX_BACKOFF_BASE_MS, OUTBOX_BACKOFF_CAP_MS, OUTBOX_LEASE_SECONDS, OUTBOX_MAX_ROUNDS,
} from "../constants";
import { decidePreSend, payloadByRole, payloadInstantMs } from "../delivery-rules";
import { OutboxErrorCode, OutboxStatus, RecipientRole } from "../enums";
import { claimDue, finishRows, oldestDueAgeSeconds, oldestPendingAgeSeconds } from "../repository/notification-outbox.repo";
import { render } from "../templates/registry";
import type {
    ConsultationDeliveryPort, DeliveryCandidate, DeliveryEnv, DeliveryRoundResult, NotificationTiming, OutboxClaimedRow, OutboxFinish, PreparedBatch, SendableRow,
} from "../types";

const TIMEOUT_RESULT: EmailSendResult = { outcome: "transient", errorCode: OutboxErrorCode.EmailTimeout };
const THROWN_RESULT: EmailSendResult = { outcome: "transient", errorCode: OutboxErrorCode.EmailError };

/**
 * The delivery side of the outbox (ADR 0011, spec 3.4), run by `care-worker`. Rows are leased by one autocommit claim statement, so the
 * contacts lookup and every send happen with no database transaction open. Each outcome is persisted immediately with a guard on the
 * claim number. Delivery is at-least-once; a contacts failure delays a row without consuming an attempt (N-D1). Contact data lives in
 * memory for one batch and is never logged, cached or stored.
 */
export class OutboxDeliveryService {
    /** Consecutive ticks whose contacts lookup failed (a failing tick stops after its first failing batch); resets on a clean lookup. */
    private contactFailures = 0;

    constructor(
        private readonly db: Knex,
        private readonly identity: IdentityClient,
        private readonly email: EmailPort,
        private readonly consultations: ConsultationDeliveryPort,
        private readonly env: DeliveryEnv,
        private readonly logger: Logger,
        private readonly timing: NotificationTiming,
    ) {}

    /**
     * Emits the two age gauges, then claims and processes up to `OUTBOX_MAX_ROUNDS` batches. A batch whose contacts lookup failed ends the
     * tick (N-D1): one outage is one backoff step, and the rest of the due rows stay due for the next tick. Throws only on a database failure.
     */
    async tick(signal: AbortSignal): Promise<TickOutcome> {
        const now = new Date(this.timing.now());
        this.logger.metric("notification_outbox_lag_seconds", await oldestDueAgeSeconds(now, this.db), {});
        this.logger.metric("notification_outbox_oldest_pending_age_seconds", await oldestPendingAgeSeconds(now, this.db), {});
        let leaseLost = 0;
        for (let round = 0; round < OUTBOX_MAX_ROUNDS && !signal.aborted; round++) {
            const result = await this.deliverRound(signal);
            leaseLost += result.leaseLost;
            if (result.contactsUnavailable || result.claimed < this.env.OUTBOX_BATCH_SIZE) break;
        }
        return leaseLost === 0 ? "done" : "incomplete";
    }

    /** One claim and its processing. */
    async deliverRound(signal: AbortSignal): Promise<DeliveryRoundResult> {
        const rows = await claimDue(new Date(this.timing.now()), this.env.OUTBOX_BATCH_SIZE, OUTBOX_LEASE_SECONDS, this.db);
        if (rows.length === 0) return { claimed: 0, leaseLost: 0, contactsUnavailable: false };
        let prepared: PreparedBatch;
        try {
            prepared = await this.prepare(rows);
        } catch (error) {
            // Nothing was sent: give the claim back without burning an attempt, then let the runner log the failure.
            await this.release(rows);
            throw error;
        }
        let leaseLost = prepared.leaseLost;
        for (let index = 0; index < prepared.sendable.length; index++) {
            const item = prepared.sendable[index];
            if (item === undefined) continue;
            try {
                leaseLost += await this.send(item, signal);
            } catch (error) {
                await this.release(prepared.sendable.slice(index + 1).map((later) => later.row));
                throw error;
            }
        }
        return { claimed: rows.length, leaseLost, contactsUnavailable: prepared.contactsUnavailable };
    }

    /** Everything before the first send: crash-loop guard, claim-time re-check, contacts lookup and the batched pre-send writes. */
    private async prepare(rows: readonly OutboxClaimedRow[]): Promise<PreparedBatch> {
        const early: OutboxFinish[] = [];
        const reasons = new Map<number, OutboxErrorCode>();
        const candidates: DeliveryCandidate[] = [];

        const live: OutboxClaimedRow[] = [];
        for (const row of rows) {
            // Crash-loop guard (N-R19): only repeated lease expiries get a row here.
            if (row.attempts > this.env.OUTBOX_MAX_ATTEMPTS) early.push(this.dead(row, OutboxErrorCode.LeaseExpired));
            else live.push(row);
        }

        const consultationIds = [...new Set(live.flatMap((row) => (row.consultation_id === null ? [] : [row.consultation_id])))];
        const contexts = await this.consultations.findDeliveryContexts(consultationIds, this.db);
        const nowMs = this.timing.now();
        for (const row of live) {
            const context = row.consultation_id === null ? undefined : contexts.get(row.consultation_id);
            const decision = decidePreSend(row, context, nowMs);
            if (!decision.send) {
                early.push(this.skipped(row, decision.errorCode));
                reasons.set(row.id, decision.errorCode);
            } else if (context !== undefined) candidates.push({ row, role: decision.role, context });
        }

        const delayed: OutboxFinish[] = [];
        const sendable: SendableRow[] = [];
        let contactsUnavailable = false;
        if (candidates.length > 0) {
            const contacts = await this.identity.getContacts([...new Set(candidates.map((candidate) => candidate.row.recipient_user_id))], randomUUID());
            if (contacts.unavailable.size > 0) {
                contactsUnavailable = true;
                const delayMs = exponentialBackoffMs(OUTBOX_BACKOFF_BASE_MS, this.contactFailures, OUTBOX_BACKOFF_CAP_MS, () => this.timing.random());
                this.contactFailures += 1;
                for (const candidate of candidates) {
                    if (contacts.unavailable.has(candidate.row.recipient_user_id)) {
                        delayed.push({
                            id: candidate.row.id, expectedAttempts: candidate.row.attempts, status: OutboxStatus.Pending, attemptsDelta: -1,
                            nextAttemptAt: new Date(this.timing.now() + delayMs), lastErrorCode: OutboxErrorCode.ContactsUnavailable, sentAt: null,
                        });
                    }
                }
            } else {
                this.contactFailures = 0;
            }
            for (const candidate of candidates) {
                if (contacts.unavailable.has(candidate.row.recipient_user_id)) continue;
                const contact = contacts.contacts.get(candidate.row.recipient_user_id);
                if (contact === undefined) {
                    early.push(this.skipped(candidate.row, OutboxErrorCode.RecipientUnknown));
                    reasons.set(candidate.row.id, OutboxErrorCode.RecipientUnknown);
                } else if (contact.status !== "active") {
                    early.push(this.skipped(candidate.row, OutboxErrorCode.RecipientInactive));
                    reasons.set(candidate.row.id, OutboxErrorCode.RecipientInactive);
                } else {
                    sendable.push({ ...candidate, email: contact.email, fullName: contact.fullName, locale: contact.locale });
                }
            }
        }

        let leaseLost = 0;
        const written = new Set(await finishRows([...early, ...delayed], this.db));
        for (const finish of [...early, ...delayed]) {
            if (!written.has(finish.id)) { leaseLost += 1; this.logger.warn("notification_lease_lost", { outboxId: finish.id }); continue; }
            this.logOutcome(rows, finish, reasons.get(finish.id));
        }

        return { sendable, leaseLost, contactsUnavailable };
    }

    /** Best effort: returns claimed rows to the queue as due now, with the claim's attempt handed back (guarded on the claim number). */
    private async release(rows: readonly OutboxClaimedRow[]): Promise<void> {
        if (rows.length === 0) return;
        const nextAttemptAt = new Date(this.timing.now());
        try {
            await finishRows(rows.map((row) => ({
                id: row.id, expectedAttempts: row.attempts, status: OutboxStatus.Pending, attemptsDelta: -1,
                nextAttemptAt, lastErrorCode: null, sentAt: null,
            })), this.db);
            this.logger.warn("notification_claim_released", { count: rows.length });
        } catch {
            this.logger.warn("notification_claim_release_failed", { count: rows.length });
        }
    }

    /** Renders and sends one row, then persists the outcome immediately (N-D3). Returns 1 when the lease was lost. */
    private async send(item: SendableRow, signal: AbortSignal): Promise<number> {
        const { row, role, context } = item;
        const startsAtMs = payloadInstantMs(row, "startsAt") ?? context.startsAt.getTime();
        const previousStartsAtMs = payloadInstantMs(row, "previousStartsAt");
        const byRole = payloadByRole(row);
        const rendered = render({
            kind: row.kind, role, locale: item.locale, recipientName: item.fullName,
            timezone: role === RecipientRole.Patient ? context.patientTimezone : (context.doctorTimezone ?? "UTC"),
            startsAtMs, ...(previousStartsAtMs === undefined ? {} : { previousStartsAtMs }), ...(byRole === undefined ? {} : { byRole }), inProgress: context.status === "in_progress",
        });
        if (rendered === undefined) return this.finishOne(row, this.skipped(row, OutboxErrorCode.TemplateMissing), OutboxErrorCode.TemplateMissing);

        const result = await settleWithin(
            this.safeSend({ to: item.email, subject: rendered.subject, text: rendered.text, meta: { outboxId: row.id, kind: row.kind, recipientUserId: row.recipient_user_id } },
                AbortSignal.any([signal, AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS)])),
            EMAIL_SEND_TIMEOUT_MS, TIMEOUT_RESULT);

        const nowMs = this.timing.now();
        if (result.outcome === "sent") {
            return this.finishOne(row, { id: row.id, expectedAttempts: row.attempts, status: OutboxStatus.Sent, attemptsDelta: 0, nextAttemptAt: null, lastErrorCode: null, sentAt: new Date(nowMs) }, undefined);
        }
        if (result.outcome === "permanent") return this.finishOne(row, this.dead(row, OutboxErrorCode.EmailRejected), undefined);
        const timeoutCode: string = OutboxErrorCode.EmailTimeout;
        const errorCode = result.errorCode === timeoutCode ? OutboxErrorCode.EmailTimeout : OutboxErrorCode.EmailError;
        if (row.attempts >= this.env.OUTBOX_MAX_ATTEMPTS) return this.finishOne(row, this.dead(row, errorCode), undefined);
        const delayMs = exponentialBackoffMs(OUTBOX_BACKOFF_BASE_MS, row.attempts - 1, OUTBOX_BACKOFF_CAP_MS, () => this.timing.random());
        return this.finishOne(row, {
            id: row.id, expectedAttempts: row.attempts, status: OutboxStatus.Pending, attemptsDelta: 0,
            nextAttemptAt: new Date(nowMs + delayMs), lastErrorCode: errorCode, sentAt: null,
        }, undefined);
    }

    /** A thrown error becomes a transient `email_error`; its message is never stored or logged. */
    private async safeSend(message: Parameters<EmailPort["send"]>[0], signal: AbortSignal): Promise<EmailSendResult> {
        try {
            return await this.email.send(message, signal);
        } catch {
            return THROWN_RESULT;
        }
    }

    private async finishOne(row: OutboxClaimedRow, finish: OutboxFinish, reason: OutboxErrorCode | undefined): Promise<number> {
        const [written] = await finishRows([finish], this.db);
        if (written === undefined) {
            this.logger.warn("notification_lease_lost", { outboxId: row.id });
            return 1;
        }
        this.logOutcome([row], finish, reason);
        return 0;
    }

    private logOutcome(rows: readonly OutboxClaimedRow[], finish: OutboxFinish, reason: OutboxErrorCode | undefined): void {
        const row = rows.find((candidate) => candidate.id === finish.id);
        if (row === undefined) return;
        const base = { outboxId: row.id, kind: row.kind, attempts: finish.expectedAttempts + finish.attemptsDelta };
        if (finish.status === OutboxStatus.Sent) {
            this.logger.info("notification_sent", base);
            this.logger.metric("notification_sent", 1, { kind: row.kind });
        } else if (finish.status === OutboxStatus.Dead) {
            this.logger.error("notification_dead", { ...base, errorCode: finish.lastErrorCode });
            this.logger.metric("notification_dead", 1, { kind: row.kind });
        } else if (finish.status === OutboxStatus.Skipped) {
            this.logger.info("notification_skipped", { ...base, reason: reason ?? finish.lastErrorCode });
            this.logger.metric("notification_skipped", 1, { reason: reason ?? finish.lastErrorCode ?? "unknown" });
        } else if (finish.lastErrorCode !== OutboxErrorCode.ContactsUnavailable) {
            this.logger.warn("notification_failed", { ...base, errorCode: finish.lastErrorCode });
            this.logger.metric("notification_failed", 1, { kind: row.kind });
        }
    }

    private dead(row: OutboxClaimedRow, errorCode: OutboxErrorCode): OutboxFinish {
        return { id: row.id, expectedAttempts: row.attempts, status: OutboxStatus.Dead, attemptsDelta: 0, nextAttemptAt: null, lastErrorCode: errorCode, sentAt: null };
    }

    private skipped(row: OutboxClaimedRow, errorCode: OutboxErrorCode): OutboxFinish {
        return { id: row.id, expectedAttempts: row.attempts, status: OutboxStatus.Skipped, attemptsDelta: 0, nextAttemptAt: null, lastErrorCode: errorCode, sentAt: null };
    }
}
