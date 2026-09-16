import type { RequestHandler } from "express";
import type { CorsOptions } from "./types";

const ALLOWED_METHODS = "GET, POST, PATCH, DELETE";
const ALLOWED_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Request-Id";
const EXPOSED_HEADERS = "X-Request-Id, Retry-After";
const MAX_AGE_SECONDS = "600";

/**
 * In-house, allowlist-only CORS (ADR 0016). Mounted by `createPublicApp` ONLY when
 * `NODE_ENV=development` and the allowlist is non-empty; production is a single origin with CORS
 * disabled (hub ADR 0005). Never mounted on the internal listener. No `Allow-Credentials`: Care uses
 * bearer tokens, never cookies.
 */
export function cors(options: CorsOptions): RequestHandler {
    const allowed = new Set(options.origins);

    return (req, res, next) => {
        const origin = req.get("Origin");
        if (origin === undefined || !allowed.has(origin)) {
            next();
            return;
        }

        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);

        if (req.method === "OPTIONS" && req.get("Access-Control-Request-Method") !== undefined) {
            res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
            res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
            res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
            res.status(204).end();
            return;
        }

        next();
    };
}
