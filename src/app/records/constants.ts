/** Rate limits (spec 3.9), all per user, 60 s sliding window: POST and PATCH share one bucket. */
export const RECORDS_RATE_WINDOW_MS = 60_000;
export const RECORDS_WRITE_USER_LIMIT = 20;
export const RECORDS_WRITE_RATE_NAME = "records-write-user";
export const RECORDS_READ_USER_LIMIT = 120;
export const RECORDS_READ_RATE_NAME = "records-read-user";
export const RECORDS_TIMELINE_USER_LIMIT = 60;
export const RECORDS_TIMELINE_RATE_NAME = "records-timeline-user";

/** Audit entity types: the timeline has no single row, so it is audited against the patient's Identity user id. */
export const MEDICAL_RECORD_ENTITY_TYPE = "medical_record";
export const PATIENT_RECORDS_ENTITY_TYPE = "patient_records";

export const UQ_MEDICAL_RECORDS_CONSULTATION_ID = "uq_medical_records_consultation_id";
export const TRG_MEDICAL_RECORDS_FORBID_UPDATE_AFTER_LOCK = "trg_medical_records_forbid_update_after_lock";

export const CHIEF_COMPLAINT_MIN_LENGTH = 3;
export const CHIEF_COMPLAINT_MAX_LENGTH = 2000;
export const NOTES_MAX_LENGTH = 10_000;
export const TREATMENT_PLAN_MAX_LENGTH = 10_000;
export const DIAGNOSIS_TEXT_MAX_LENGTH = 2000;
/** ICD-10 shape only (R-D2): no catalog. At most 8 characters, inside `VARCHAR(16)`; mirrored by `chk_medical_records_diagnosis_code`. */
export const DIAGNOSIS_CODE_PATTERN = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;
export const FOLLOW_UP_MIN_DAYS = 1;
export const FOLLOW_UP_MAX_DAYS = 365;
export const AMENDMENT_REASON_MIN_LENGTH = 3;
export const AMENDMENT_REASON_MAX_LENGTH = 1000;
