import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import type { ErrorDetail } from "../../../lib/error/types";
import { isAppError } from "../../../lib/error/AppError";
import { ValidationFailed } from "../../../lib/error/errors";
import { DEFAULT_PAGE_LIMIT } from "../../../lib/http/pagination/page";
import { decodeSignedCursor, encodeSignedCursor } from "../../../lib/http/pagination/signed-cursor";
import { parseIsoDateTimeWithOffset } from "../../../pkg/utils/iso-datetime";
import { AUDIT_CURSOR_TIMESTAMP_PATTERN, AUDIT_CURSOR_TO_PATTERN } from "../constants";
import { listAuditLogs } from "../repository/audit.repo";
import type { AuditClock, AuditCursorPayload, AuditListQuery, AuditLogPage, AuditWindow } from "../types";
import { resolveAuditWindow } from "../window";

const ENTITY_TYPE_REQUIRED: ErrorDetail = { field: "entityType", issue: "is required when entityId is given" };

function toCursorPayload(payload: unknown): AuditCursorPayload | undefined {
    if (typeof payload !== "object" || payload === null || !("t" in payload) || !("id" in payload) || !("to" in payload) || !("from" in payload)) return undefined;
    const { t, id, from, to } = payload;
    // Shape (microsecond precision) AND a real instant: Postgres would otherwise raise 22008 -> 500 for a validly signed impossible `t`.
    if (typeof t !== "string" || !AUDIT_CURSOR_TIMESTAMP_PATTERN.test(t) || parseIsoDateTimeWithOffset(t) === undefined) return undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return undefined;
    if (typeof from !== "string" || !AUDIT_CURSOR_TO_PATTERN.test(from) || parseIsoDateTimeWithOffset(from) === undefined) return undefined;
    if (typeof to !== "string" || !AUDIT_CURSOR_TO_PATTERN.test(to) || parseIsoDateTimeWithOffset(to) === undefined) return undefined;
    return { t, id, from, to };
}

/** Read side of the audit trail: one admin page = one indexed, time-bounded statement. Writes no audit row (spec R9). */
@injectable()
export class AuditService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.AuditClock) private readonly clock: AuditClock,
    ) {}

    async list(query: AuditListQuery): Promise<AuditLogPage> {
        const secret = this.env.SERVICE_CLIENT_SECRET;
        // Every cross-field problem (cursor included) is reported at once, sorted by field (spec 3.1).
        const details: ErrorDetail[] = [];
        let cursor: AuditCursorPayload | undefined;
        if (query.cursor !== undefined) {
            try {
                cursor = decodeSignedCursor(query.cursor, secret, toCursorPayload);
            } catch (error) {
                if (!isAppError(error) || error.code !== "ValidationFailed") throw error;
                details.push(...error.details);
            }
        }
        if (query.entityId !== undefined && query.entityType === undefined) details.push(ENTITY_TYPE_REQUIRED);
        let window: AuditWindow | undefined;
        try {
            window = resolveAuditWindow(() => this.clock.now(), parseIsoDateTimeWithOffset(query.from), parseIsoDateTimeWithOffset(query.to),
                cursor === undefined ? undefined : parseIsoDateTimeWithOffset(cursor.to), cursor === undefined ? undefined : parseIsoDateTimeWithOffset(cursor.from));
        } catch (error) {
            if (!isAppError(error) || error.code !== "ValidationFailed") throw error;
            details.push(...error.details);
        }
        if (details.length > 0 || window === undefined) throw ValidationFailed.withDetails(details.sort((a, b) => a.field.localeCompare(b.field)));
        const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
        if (window.empty) return { items: [], meta: { nextCursor: null, hasMore: false, count: 0 } };
        const rows = await listAuditLogs({ from: window.from, to: window.to, actorUserId: query.actorUserId, action: query.action, entityType: query.entityType, entityId: query.entityId,
            after: cursor === undefined ? undefined : { t: cursor.t, id: cursor.id }, fetchLimit: limit + 1 }, this.db);
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        // The effective window is frozen into the cursor so later pages keep it while the clock advances.
        const nextCursor = hasMore && last !== undefined ? encodeSignedCursor({ t: last.cursorTimestamp, id: last.entry.id, from: window.from.toISOString(), to: window.to.toISOString() }, secret) : null;
        return { items: page.map((row) => row.entry), meta: { nextCursor, hasMore, count: page.length } };
    }
}
