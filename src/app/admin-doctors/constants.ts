export const ADMIN_DOCTORS_WRITE_LIMIT = 30;
export const ADMIN_DOCTORS_RATE_WINDOW_MS = 60_000;
export const ADMIN_DOCTORS_RATE_NAME = "admin-doctors-write";
/** Inline Identity attempts: with the client's 2 s per-attempt timeout this is the contract's "about 6 s" worst case. Separate constants so the two cases can diverge. */
export const SUSPEND_INLINE_ATTEMPTS = 3;
export const REINSTATE_INLINE_ATTEMPTS = 3;
/** Sibling member of the `503 IdentityUnavailable` envelope (contract `SuspensionPending`). */
export const SUSPENSION_PENDING_MARKER = "applied-locally, session-revocation-pending";
export const DOCTOR_PROFILE_ENTITY = "doctor_profile";
export const CONSULTATION_ENTITY = "consultation";
export const FOLLOWUP_REASON_DOCTOR_SUSPENDED = "doctor_suspended";
