import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { canonicalJson } from "../../pkg/utils/canonical-json";
import { isUuid } from "../../pkg/utils/uuid";
import { Conflict, IdempotencyConflict, ValidationFailed } from "../error/errors";
import { clientIp } from "../http/client-ip";
import { routeLabel } from "../http/route-pattern";
import { logger } from "../logger/logger";
import { isRedisReady, resolveRedis } from "../redis/redis";
import { acquireLock, readRecord, releaseLock, storeResult } from "./idempotency-store";
import type { IdempotencyOptions } from "./types";

const DEFAULT_LOCK_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 86_400_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const IN_FLIGHT_CONFLICT = Conflict.withMessage("A request with this idempotency key is still being processed");

/** `user:<id>` (user token) | `client:<id>` (service token) | `ip:<clientIp>` — never a caller-supplied header. */
export function resolvePrincipal(req: Request): string {
    if (req.auth !== undefined) {
        return `user:${req.auth.userId}`;
    }
    if (req.service !== undefined) {
        return `client:${req.service.clientId}`;
    }
    return `ip:${clientIp(req)}`;
}

/** `idem:<METHOD path>:<principal>:<key>` — the concrete path, never the query string. */
export function buildIdempotencyKey(req: Request, key: string): string {
    return `idem:${req.method} ${req.baseUrl}${req.path}:${resolvePrincipal(req)}:${key.toLowerCase()}`;
}

export function hashBody(body: unknown): string {
    return createHash("sha256").update(canonicalJson(body ?? null)).digest("hex");
}

/** Redis is Tier 2: when it is unavailable the middleware steps aside — DB-level guarantees still apply. */
function skip(req: Request, reason: string): void {
    logger.warn("idempotency_skipped", { requestId: req.requestId, route: routeLabel(req), reason });
    logger.metric("idempotency_skipped", 1, { reason });
}

/** Replays a stored response; a stored error envelope gets THIS request's id so it matches `X-Request-Id`. */
function replay(req: Request, res: Response, status: number, body: unknown): void {
    if (body === null || body === undefined || status === 204) {
        res.status(status).end();
        return;
    }
    if (typeof body === "object" && body !== null && "error" in body) {
        const envelope = body as { error?: Record<string, unknown> };
        if (envelope.error !== undefined && typeof envelope.error === "object") {
            envelope.error.requestId = req.requestId;
        }
    }
    res.status(status).json(body);
}

export function idempotency(options: IdempotencyOptions): RequestHandler {
    const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    return (req, res, next) => {
        if (SAFE_METHODS.has(req.method)) {
            next();
            return;
        }

        const key = req.get("Idempotency-Key");
        if (key === undefined || key.length === 0) {
            // Enforced even when Redis is down: a required key is a contract rule, not a cache concern.
            next(
                options.required
                    ? ValidationFailed.withDetails([{ field: "Idempotency-Key", issue: "is required" }])
                    : undefined,
            );
            return;
        }
        if (!isUuid(key)) {
            next(ValidationFailed.withDetails([{ field: "Idempotency-Key", issue: "must be a UUID" }]));
            return;
        }

        const client = resolveRedis(options.redis);
        if (!isRedisReady(client)) {
            skip(req, "redis_not_ready");
            next();
            return;
        }

        const storeKey = buildIdempotencyKey(req, key);
        const bodyHash = hashBody(req.body);

        void (async () => {
            let acquired: boolean;
            try {
                acquired = await acquireLock(client, storeKey, bodyHash, lockTtlMs);
            } catch {
                skip(req, "redis_error");
                next();
                return;
            }

            if (!acquired) {
                let record;
                try {
                    record = await readRecord(client, storeKey);
                } catch {
                    skip(req, "redis_error");
                    next();
                    return;
                }

                if (record === null) {
                    // The first request just released the lock (5xx/429): tell the client to retry.
                    res.setHeader("Retry-After", "1");
                    next(IN_FLIGHT_CONFLICT);
                    return;
                }
                if (record.bodyHash !== bodyHash) {
                    next(IdempotencyConflict);
                    return;
                }
                if (record.state === "in_progress") {
                    res.setHeader("Retry-After", "1");
                    next(IN_FLIGHT_CONFLICT);
                    return;
                }
                replay(req, res, record.status, record.body);
                return;
            }

            // We own the key: capture the response so a retry can replay it verbatim.
            let captured: unknown = null;
            const originalJson = res.json.bind(res);
            res.json = (body: unknown) => {
                captured = body;
                return originalJson(body);
            };

            res.on("finish", () => {
                const status = res.statusCode;
                const settle =
                    status >= 500 || status === 429
                        ? releaseLock(client, storeKey)
                        : storeResult(client, storeKey, bodyHash, status, captured, ttlMs);
                settle.catch(() => {
                    // Response is already sent; the lock expires after lockTtlMs.
                    logger.warn("idempotency_store_failed", { requestId: req.requestId, route: routeLabel(req) });
                });
            });

            next();
        })();
    };
}
