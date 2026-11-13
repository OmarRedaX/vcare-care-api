/** Key prefixes of care's bucket. The first is the upload quarantine; the other two are the final homes (care ADRs 0013, 0022). */
export const QUARANTINE_PREFIX = "quarantine/";
export const VERIFICATION_DOCUMENTS_PREFIX = "verification-documents/";
export const RECORD_ATTACHMENTS_PREFIX = "record-attachments/";
export const FINAL_PREFIXES: readonly string[] = [VERIFICATION_DOCUMENTS_PREFIX, RECORD_ATTACHMENTS_PREFIX];

/** `quarantine/*` objects expire after 24 h: the backstop for abandoned or rolled-back uploads. */
export const QUARANTINE_EXPIRY_DAYS = 1;
/** Final objects move to infrequent access after 90 days. */
export const INFREQUENT_ACCESS_AFTER_DAYS = 90;
/** Browser preflight cache for the POST CORS rule (care ADR 0015: `MaxAge=600`). */
export const CORS_MAX_AGE_SECONDS = 600;
