import type { AuditActorRole, AuditMetadata } from "../types";

export class AuditLog {
    id!: number;
    actorUserId!: number | null;
    actorRole!: AuditActorRole;
    action!: string;
    entityType!: string;
    entityId!: number;
    requestId!: string | null;
    metadata!: AuditMetadata;
    createdAt!: Date;

    constructor(data: Partial<AuditLog>) {
        Object.assign(this, data);
    }
}
