import type { PageMeta } from "../../lib/http/pagination/types";
import type { UserPolicy } from "../../lib/rbac/types";
import type { Role } from "../../lib/types/types";
import type { AuditLog } from "./entity/audit-log.entity";

export type AuditMetadata = Record<string, string | number | boolean | null>;
export type AuditActorRole = Role | "service" | "system";

export interface AuditLogRow {
    id: number; actor_user_id: number | null; actor_role: AuditActorRole; action: string; entity_type: string; entity_id: number;
    request_id: string | null; metadata: AuditMetadata; created_at: Date;
}
/** The selected row: the nine columns plus `created_at` at microsecond precision for the cursor. */
export type AuditLogCursorRow = AuditLogRow & { cursor_timestamp: string };

export interface AuditKeysetPosition { t: string; id: number }
/** What the repository needs: absolute bounds computed in the application (never SQL time functions) and a fetch size. */
export interface ListAuditLogsParams {
    from: Date; to: Date; actorUserId?: number; action?: string; entityType?: string; entityId?: number;
    after?: AuditKeysetPosition; fetchLimit: number;
}
export interface AuditCursorPayload { t: string; id: number; from: string; to: string }
export interface AuditWindow { from: Date; to: Date; empty: boolean }
export interface AuditClock { now(): number }

/** The validated query as the service receives it (strings parsed by the DTO, dates still ISO strings). */
export interface AuditListQuery {
    actorUserId?: number; action?: string; entityType?: string; entityId?: number; from?: string; to?: string; cursor?: string; limit?: number;
}
export interface AuditLogPage { items: AuditLog[]; meta: PageMeta }
export interface AuditPolicies { list: UserPolicy }
