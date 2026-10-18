import type { RequestHandler } from "express";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import {
    RECORDS_RATE_WINDOW_MS, RECORDS_READ_RATE_NAME, RECORDS_READ_USER_LIMIT, RECORDS_TIMELINE_RATE_NAME, RECORDS_TIMELINE_USER_LIMIT,
    RECORDS_WRITE_RATE_NAME, RECORDS_WRITE_USER_LIMIT,
} from "./constants";

/** Record create and update: 20/min per user, one shared bucket. Admins never reach it (denied at `authorize`). */
export function writeLimit(): RequestHandler {
    return rateLimit({ name: RECORDS_WRITE_RATE_NAME, limit: RECORDS_WRITE_USER_LIMIT, windowMs: RECORDS_RATE_WINDOW_MS, subject: byUser });
}

/** `GET /records/{id}`: 120/min per user. */
export function readLimit(): RequestHandler {
    return rateLimit({ name: RECORDS_READ_RATE_NAME, limit: RECORDS_READ_USER_LIMIT, windowMs: RECORDS_RATE_WINDOW_MS, subject: byUser });
}

/** `GET /patients/{patientUserId}/records`: 60/min per user. */
export function timelineLimit(): RequestHandler {
    return rateLimit({ name: RECORDS_TIMELINE_RATE_NAME, limit: RECORDS_TIMELINE_USER_LIMIT, windowMs: RECORDS_RATE_WINDOW_MS, subject: byUser });
}
