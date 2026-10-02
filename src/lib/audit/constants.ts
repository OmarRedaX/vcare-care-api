/** care-worker loop that keeps monthly `audit_logs` partitions ahead of time (ADR 0009). */
export const AUDIT_PARTITION_LOOP_NAME = "audit-partitions";
/** Daily; the LoopRunner runs the first tick at start. */
export const AUDIT_PARTITION_INTERVAL_MS = 86_400_000;
/** bigint advisory-lock key reserved for this loop (transaction-scoped: `pg_try_advisory_xact_lock`). */
export const AUDIT_PARTITION_LOCK_KEY = 7_311_420_001;
/** Bound of the `audit_logs_default` non-empty sample (the gauge saturates at this value). */
export const AUDIT_DEFAULT_SAMPLE_LIMIT = 1_001;

/** Entry validation (access spec §3.5): the DB caps metadata at 4 096 bytes; the recorder at half of it. */
export const AUDIT_FIELD_MAX_LENGTH = 64;
export const AUDIT_METADATA_MAX_KEYS = 20;
export const AUDIT_METADATA_MAX_STRING_LENGTH = 500;
export const AUDIT_METADATA_MAX_BYTES = 2_048;
