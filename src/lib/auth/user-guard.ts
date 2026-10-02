import type { RequestHandler } from "express";
import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { Unauthorized } from "../error/errors";
import { captureRoute } from "../http/route-pattern";
import { requestContext } from "../logger/request-context";
import { markGuard } from "../rbac/markers";
import { MAX_BEARER_TOKEN_LENGTH } from "./constants";
import type { UserGuardOptions } from "./types";
import type { UserTokenVerifier } from "./user-token-verifier";

/** Exactly one token after the scheme: `Bearer a b`, `Basic …`, and an empty token all fail. */
const BEARER_PATTERN = /^Bearer (\S+)$/i;
/** `Bearer ` + the longest accepted token. */
const MAX_HEADER_LENGTH = MAX_BEARER_TOKEN_LENGTH + "Bearer ".length;

/**
 * Authentication only (access spec §3.3.6): verifies the `Authorization: Bearer` user token locally and sets
 * `req.auth`. Never reads the database, Redis, or any identity header (`X-User-Id`, `X-Role`, … are ignored — the
 * only principal is the verified token). On success the request-context store gets `userId` and `role`, so every
 * later log line carries them. Must precede `authorize(policy)` on every route (asserted at boot).
 */
export function userGuard(options?: UserGuardOptions): RequestHandler {
    const handler: RequestHandler = async (req, res, next) => {
        captureRoute(req, res);

        const header = req.get("Authorization");
        const match = header !== undefined && header.length <= MAX_HEADER_LENGTH ? BEARER_PATTERN.exec(header) : null;
        const token = match?.[1];
        if (token === undefined || token.length > MAX_BEARER_TOKEN_LENGTH) {
            next(Unauthorized);
            return;
        }

        // Resolved per request (like `resolveRedis`) so container overrides in tests take effect.
        const verifier = options?.verifier ?? container.resolve<UserTokenVerifier>(TOKENS.UserTokenVerifier);
        let auth;
        try {
            auth = await verifier.verify(token);
        } catch (error) {
            next(error);
            return;
        }

        req.auth = auth;
        const store = requestContext.getStore();
        if (store !== undefined) {
            store.userId = auth.userId;
            store.role = auth.role;
        }
        next();
    };

    return markGuard(handler);
}
