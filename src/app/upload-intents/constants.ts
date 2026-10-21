/** Session advisory lock namespace of one intent (`complete`, purge). Identity sync uses 1102 (`identity-sync/constants.ts`). */
export const UPLOAD_INTENT_LOCK_NAMESPACE = 1101;
/** Singleton lock of the purge tick (id 0). */
export const INTENT_PURGE_LOCK_NAMESPACE = 1103;
export const INTENT_PURGE_LOOP_NAME = "upload-intent-purge";
export const INTENT_PURGE_BATCH = 500;
/** Consumed intents stay seven days so a replayed `complete` still resolves. */
export const INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 10_485_760;
export const QUARANTINE_KEY_PREFIX = "quarantine/";
/** Leading bytes read from the stored object to detect its real type. */
export const DETECT_HEAD_BYTES = 16;
