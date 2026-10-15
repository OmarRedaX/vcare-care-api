/** Scopes of the token used for hydration (`users:read`) and account status changes (Cases 1, 3, 4). */
export const STATUS_SERVICE_SCOPES: readonly string[] = ["users:read", "users:status:write"];

/**
 * Scope of the token used only by `care-worker` to look up notification contacts (Case 5, hub ADR 0010). It is requested
 * in its own token, never merged into the status token, so a missing grant cannot break suspension or verification.
 */
export const CONTACT_SERVICE_SCOPES: readonly string[] = ["users:contact:read"];
