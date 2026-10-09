export const INTENT_PURGE_LOOP_NAME = "upload-intent-purge";
export const INTENT_PURGE_BATCH = 500;
export const INTENT_PURGE_LOCK_NAMESPACE = 1103;
/** Consumed intents stay seven days so a replayed `complete` still resolves. */
export const INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
