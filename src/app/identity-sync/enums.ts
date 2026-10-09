export enum IdentitySyncJobKind { Verification = "verification", Suspension = "suspension", Reinstatement = "reinstatement" }
export enum IdentitySyncJobStatus { Pending = "pending", Succeeded = "succeeded", Failed = "failed", Superseded = "superseded" }
export enum IdentitySyncAuditAction { Pending = "identity_sync.pending", Synced = "identity_sync.synced", Failed = "identity_sync.failed" }
