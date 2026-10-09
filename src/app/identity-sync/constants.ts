import type { SyncTiming } from "./types";

/** Session advisory-lock namespace: outbound status calls for one doctor never run concurrently (all job kinds, API and worker). */
export const IDENTITY_SYNC_LOCK_NAMESPACE = 1102;
export const IDENTITY_SYNC_LOOP_NAME = "identity-sync";
export const IDENTITY_SYNC_BATCH = 50;
/** Identity's `StatusChangeRequest.reason` `maxLength`: the Identity-bound text is clamped to it, Care keeps the full text. */
export const IDENTITY_REASON_MAX_CODE_POINTS = 500;
/** `IdentitySuspensionSyncFailing` pages at this many consecutive failed engine attempts, then every `REPAGE_EVERY` more. */
export const SUSPENSION_FAILURE_PAGE_THRESHOLD = 3;
export const SUSPENSION_FAILURE_REPAGE_EVERY = 10;
export const IDENTITY_SYNC_PROFILE_ENTITY = "doctor_profile";
/** Production timing; tests inject a fake clock instead. */
export const SYSTEM_SYNC_TIMING: SyncTiming = { now: () => Date.now(), random: () => Math.random() };
