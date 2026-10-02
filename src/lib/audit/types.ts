import type { Knex } from "knex";
import type { Logger } from "../logger/logger";
import type { Role } from "../types/types";

/** Who acted. Maps to `actor_user_id` / `actor_role` (`chk_audit_logs_actor_user_id`). */
export type AuditActor =
    /** `actor_user_id = userId`, `actor_role = role`. */
    | { kind: "user"; userId: number; role: Role }
    /** `actor_user_id NULL`, `actor_role 'service'`, `metadata.actorClientId = clientId`. */
    | { kind: "service"; clientId: string }
    /** `actor_user_id NULL`, `actor_role 'system'` (worker loops, retriers). */
    | { kind: "system" };

/** Contract `AuditLogEntry.metadata` values: flat scalars only — ids, statuses, reasons; never clinical text or PII. */
export type AuditMetadataValue = string | number | boolean | null;

export interface AuditEntry {
    actor: AuditActor;
    /** `<entity>.<verb>`, e.g. `specialty.created`, `record.read`. */
    action: string;
    /** snake_case, e.g. `medical_record`. */
    entityType: string;
    entityId: number;
    metadata: Readonly<Record<string, AuditMetadataValue>>;
    /** Default: the current request's id; `null` when there is none (worker). */
    requestId?: string;
}

export interface AuditRecorderOptions {
    logger: Logger;
}

/** The validated row `AuditRecorder` inserts. */
export interface AuditRow {
    actorUserId: number | null;
    actorRole: Role | "service" | "system";
    action: string;
    entityType: string;
    entityId: number;
    requestId: string | null;
    metadataJson: string;
}

export interface AuditPartitionLoopDeps {
    db: Knex;
    logger: Logger;
    monthsAhead: number;
}

/** A row of `audit_logs_ensure_partitions(int)`. */
export interface EnsuredPartitionRow {
    partition_name: string;
    created: boolean;
}
