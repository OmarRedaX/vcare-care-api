import type { Knex } from "knex";
import { isUuid } from "../../pkg/utils/uuid";
import type { Logger } from "../logger/logger";
import { normalizeKey, REDACTED_KEYS } from "../logger/redact";
import { currentRequestId } from "../logger/request-context";
import { isRole } from "../rbac/roles";
import type { AuthContext } from "../types/types";
import {
    AUDIT_FIELD_MAX_LENGTH,
    AUDIT_METADATA_MAX_BYTES,
    AUDIT_METADATA_MAX_KEYS,
    AUDIT_METADATA_MAX_STRING_LENGTH,
} from "./constants";
import type { AuditActor, AuditEntry, AuditMetadataValue, AuditRecorderOptions, AuditRow } from "./types";

const ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const METADATA_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
const REDACTED_SET = new Set(REDACTED_KEYS.map(normalizeKey));

/** One statement, explicit columns, no RETURNING (the app role holds INSERT/SELECT only). */
const INSERT_AUDIT_LOG = `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)
VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)`;

/** A programming error (500 through the error handler; the caller's transaction rolls back). */
function invalid(field: string): Error {
    return new Error(`audit_entry_invalid: ${field}`);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isMetadataValue(value: unknown): value is AuditMetadataValue {
    if (value === null || typeof value === "boolean") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    return typeof value === "string" && value.length <= AUDIT_METADATA_MAX_STRING_LENGTH;
}

function actorColumns(actor: AuditActor): Pick<AuditRow, "actorUserId" | "actorRole"> {
    switch (actor.kind) {
        case "user":
            if (!isPositiveSafeInteger(actor.userId)) {
                throw invalid("actor.userId");
            }
            if (!isRole(actor.role)) {
                throw invalid("actor.role");
            }
            return { actorUserId: actor.userId, actorRole: actor.role };
        case "service":
            return { actorUserId: null, actorRole: "service" };
        case "system":
            return { actorUserId: null, actorRole: "system" };
        default:
            throw invalid("actor.kind");
    }
}

/** Flat scalar metadata: ≤ 20 keys, camelCase-ish names, no redacted (clinical/PII) key names, ≤ 2 KB serialized. */
function metadataJson(entry: AuditEntry): string {
    if (!isPlainObject(entry.metadata)) {
        throw invalid("metadata");
    }
    const metadata: Record<string, unknown> = { ...entry.metadata };
    if (entry.actor.kind === "service") {
        if (typeof entry.actor.clientId !== "string" || entry.actor.clientId.length === 0) {
            throw invalid("actor.clientId");
        }
        if ("actorClientId" in metadata) {
            throw invalid("metadata.actorClientId");
        }
        metadata.actorClientId = entry.actor.clientId;
    }

    const keys = Object.keys(metadata);
    if (keys.length > AUDIT_METADATA_MAX_KEYS) {
        throw invalid("metadata");
    }
    for (const key of keys) {
        // The key is a code identifier (never data), so naming it in the error is safe.
        if (!METADATA_KEY_PATTERN.test(key) || REDACTED_SET.has(normalizeKey(key))) {
            throw invalid(`metadata.${key}`);
        }
        if (!isMetadataValue(metadata[key])) {
            throw invalid(`metadata.${key}`);
        }
    }

    const json = JSON.stringify(metadata);
    if (Buffer.byteLength(json, "utf8") > AUDIT_METADATA_MAX_BYTES) {
        throw invalid("metadata");
    }
    return json;
}

function toRow(entry: AuditEntry): AuditRow {
    if (
        typeof entry.action !== "string" ||
        entry.action.length > AUDIT_FIELD_MAX_LENGTH ||
        !ACTION_PATTERN.test(entry.action)
    ) {
        throw invalid("action");
    }
    if (
        typeof entry.entityType !== "string" ||
        entry.entityType.length > AUDIT_FIELD_MAX_LENGTH ||
        !ENTITY_TYPE_PATTERN.test(entry.entityType)
    ) {
        throw invalid("entityType");
    }
    if (!isPositiveSafeInteger(entry.entityId)) {
        throw invalid("entityId");
    }
    const requestId = entry.requestId ?? currentRequestId() ?? null;
    if (requestId !== null && !isUuid(requestId)) {
        throw invalid("requestId");
    }
    return {
        ...actorColumns(entry.actor),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        requestId,
        metadataJson: metadataJson(entry),
    };
}

/**
 * The write side of the audit log (access spec §3.5; CLAUDE.md → Privacy and logging). `record(trx, entry)` writes
 * exactly ONE row inside the caller's transaction — it never opens one — so the row commits or rolls back with the
 * change it describes, and a failed audit fails the write (or the clinical read). Entries are validated first: a bad
 * entry is a programming error (500). Never logs metadata.
 */
export class AuditRecorder {
    private readonly logger: Logger;

    constructor(options: AuditRecorderOptions) {
        this.logger = options.logger;
    }

    async record(trx: Knex.Transaction, entry: AuditEntry): Promise<void> {
        if ((trx as { isTransaction?: unknown } | undefined)?.isTransaction !== true) {
            throw new Error("audit_requires_transaction");
        }
        const row = toRow(entry);
        try {
            await trx.raw(INSERT_AUDIT_LOG, [
                row.actorUserId,
                row.actorRole,
                row.action,
                row.entityType,
                row.entityId,
                row.requestId,
                row.metadataJson,
            ]);
        } catch (error) {
            this.logger.error("audit_write_failed", { action: row.action, entityType: row.entityType, error });
            this.logger.metric("audit_write_failed", 1, { action: row.action });
            throw error;
        }
    }
}

/** The audit actor for a verified user principal. */
export function actorFromAuth(auth: AuthContext): AuditActor {
    return { kind: "user", userId: auth.userId, role: auth.role };
}
