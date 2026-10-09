import type { AuditLog } from "../entity/audit-log.entity";
import type { AuditMetadata } from "../types";

/** Exactly the contract `AuditLogEntry`; `metadata` is passed through verbatim (shallow copy). */
export class AuditLogResponseDto {
    id!: number; actorUserId!: number | null; actorRole!: string; action!: string; entityType!: string; entityId!: number;
    requestId!: string | null; metadata!: AuditMetadata; createdAt!: string;
    static from(entry: AuditLog): AuditLogResponseDto {
        return { id: entry.id, actorUserId: entry.actorUserId, actorRole: entry.actorRole, action: entry.action, entityType: entry.entityType, entityId: entry.entityId,
            requestId: entry.requestId, metadata: { ...entry.metadata }, createdAt: entry.createdAt.toISOString() };
    }
}
