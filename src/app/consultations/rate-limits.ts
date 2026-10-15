import type { RequestHandler } from "express";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser, byUserOfRoles } from "../../lib/rate-limit/subjects";
import {
    CONSULTATIONS_RATE_WINDOW_MS, CONSULTATIONS_READ_RATE_NAME, CONSULTATIONS_READ_USER_LIMIT, CONSULTATIONS_WRITE_ADMIN_LIMIT,
    CONSULTATIONS_WRITE_ADMIN_RATE_NAME, CONSULTATIONS_WRITE_USER_LIMIT, CONSULTATIONS_WRITE_USER_RATE_NAME,
} from "./constants";

/** Booking-class writes: 10/min per patient or doctor (one shared bucket) and 60/min per admin; each limiter skips the other roles. */
export function writeLimits(): RequestHandler[] {
    return [
        rateLimit({ name: CONSULTATIONS_WRITE_USER_RATE_NAME, limit: CONSULTATIONS_WRITE_USER_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUserOfRoles(["patient", "doctor"]) }),
        rateLimit({ name: CONSULTATIONS_WRITE_ADMIN_RATE_NAME, limit: CONSULTATIONS_WRITE_ADMIN_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUserOfRoles(["admin"]) }),
    ];
}

/** Reads: 120/min per user. */
export function readLimit(): RequestHandler {
    return rateLimit({ name: CONSULTATIONS_READ_RATE_NAME, limit: CONSULTATIONS_READ_USER_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUser });
}
