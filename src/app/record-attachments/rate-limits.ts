import type { RequestHandler } from "express";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import {
    RECORD_ATTACHMENTS_INTENT_RATE_NAME, RECORD_ATTACHMENTS_INTENT_USER_LIMIT, RECORD_ATTACHMENTS_INTENT_WINDOW_MS, RECORD_ATTACHMENTS_RATE_WINDOW_MS,
    RECORD_ATTACHMENTS_READ_RATE_NAME, RECORD_ATTACHMENTS_READ_USER_LIMIT, RECORD_ATTACHMENTS_WRITE_RATE_NAME, RECORD_ATTACHMENTS_WRITE_USER_LIMIT,
} from "./constants";

/** Attachment upload intents: 20/hour per user. A separate bucket from verification-document intents (SD11). Admins never reach it. */
export function intentLimit(): RequestHandler {
    return rateLimit({ name: RECORD_ATTACHMENTS_INTENT_RATE_NAME, limit: RECORD_ATTACHMENTS_INTENT_USER_LIMIT, windowMs: RECORD_ATTACHMENTS_INTENT_WINDOW_MS, subject: byUser });
}

/** `complete` and `DELETE`: 20/min per user, one shared bucket. */
export function writeLimit(): RequestHandler {
    return rateLimit({ name: RECORD_ATTACHMENTS_WRITE_RATE_NAME, limit: RECORD_ATTACHMENTS_WRITE_USER_LIMIT, windowMs: RECORD_ATTACHMENTS_RATE_WINDOW_MS, subject: byUser });
}

/** `download-url`: 120/min per user. */
export function readLimit(): RequestHandler {
    return rateLimit({ name: RECORD_ATTACHMENTS_READ_RATE_NAME, limit: RECORD_ATTACHMENTS_READ_USER_LIMIT, windowMs: RECORD_ATTACHMENTS_RATE_WINDOW_MS, subject: byUser });
}
