import { Type } from "class-transformer";
import { IsInt, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import type { Request, Response } from "express";
import { Router } from "express";
import { ValidationFailed } from "../../src/lib/error/errors";
import { decodeCursor } from "../../src/lib/http/pagination/cursor";
import { buildPage, resolveLimit } from "../../src/lib/http/pagination/page";
import { PaginationQueryDto } from "../../src/lib/http/pagination/pagination.request.dto";
import { sendNoContent, sendSuccess } from "../../src/lib/http/response";
import { idempotency } from "../../src/lib/idempotency/idempotency";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { actorFromAuth } from "../../src/lib/audit/audit";
import type { AuditRecorder } from "../../src/lib/audit/audit";
import { userGuard } from "../../src/lib/auth/user-guard";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { sealRouter } from "../../src/lib/http/route-pattern";
import { rateLimit } from "../../src/lib/rate-limit/rate-limit";
import { byIp } from "../../src/lib/rate-limit/subjects";
import { authorize } from "../../src/lib/rbac/authorize";
import type { AccessContext, OwnershipDecision, UserPolicy } from "../../src/lib/rbac/types";
import { validateBody, validateQuery } from "../../src/lib/validation/validate";
import { parsePositiveId } from "../../src/pkg/utils/id";

/** Test DTO: every field validated; unknown properties rejected by `validateBody`. */
export class EchoItemDto {
    @IsString()
    @MaxLength(50)
    label!: string;
}

export class EchoDto {
    @IsString()
    @MaxLength(50)
    name!: string;

    @IsInt()
    @Min(1)
    @Max(10)
    count!: number;

    @ValidateNested()
    @Type(() => EchoItemDto)
    item!: EchoItemDto;
}

/** Call counters observed by the idempotency suite (handler runs exactly once on replay). */
export const counters = { idem: 0, flaky: 0, invalid: 0, noContent: 0 };

export function resetCounters(): void {
    counters.idem = 0;
    counters.flaky = 0;
    counters.invalid = 0;
    counters.noContent = 0;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Envelope / validation / logging routes. Mount at `/api`. */
export function buildEnvelopeRouter(): Router {
    const router = Router();

    router.post("/__test/echo", async (req: Request, res: Response) => {
        const dto = await validateBody(EchoDto, req.body as unknown);
        sendSuccess(res, { name: dto.name, count: dto.count, label: dto.item.label }, { status: 201 });
    });

    // A non-AppError whose message carries internals: the body must never contain it.
    router.post("/__test/boom", () => {
        throw new Error("SELECT password_hash FROM secret_table WHERE id = 42");
    });

    router.get("/__test/boom", () => {
        throw new Error("SELECT password_hash FROM secret_table WHERE id = 42");
    });

    // A "repository" call Postgres rejects: pg puts the offending VALUE into the error message
    // (22P02 int, 22007 timestamptz, 22008 date out of range).
    router.post("/__test/db-cast", async (req: Request, res: Response) => {
        const { value, type } = req.body as { value?: unknown; type?: unknown };
        const cast = type === "timestamptz" ? "timestamptz" : type === "date" ? "date" : "int";
        await db.raw(`SELECT ?::${cast} AS v`, [String(value)]);
        sendSuccess(res, { ok: true });
    });

    // A CHECK violation: pg puts the failing row (with the value) into `detail`, the constraint name into `constraint`.
    router.post("/__test/db-check", async (req: Request, res: Response) => {
        const value = String((req.body as { value?: unknown }).value);
        await db.transaction(async (trx) => {
            await trx.raw(
                `CREATE TEMP TABLE check_probe (v TEXT, CONSTRAINT chk_check_probe_short CHECK (length(v) < 5)) ON COMMIT DROP`,
            );
            await trx.raw("INSERT INTO check_probe (v) VALUES (?)", [value]);
        });
        sendSuccess(res, { ok: true });
    });

    // A "service" that logs from a promise continuation and a timer — no logger or request id passed in.
    router.get("/__test/context", async (_req: Request, res: Response) => {
        await delay(5);
        await new Promise<void>((resolve) =>
            setTimeout(() => {
                logger.warn("test_service_called", { step: "timer" });
                resolve();
            }, 5),
        );
        sendSuccess(res, { ok: true });
    });

    return router;
}

/** Idempotency routes (`required: true`, call counters). Mount at `/api`. */
export function buildIdempotencyRouter(): Router {
    const router = Router();

    router.post("/__test/idem", idempotency({ required: true }), async (req: Request, res: Response) => {
        const delayMs = Number(req.query.delayMs ?? 0);
        if (Number.isFinite(delayMs) && delayMs > 0) {
            await delay(delayMs);
        }
        counters.idem += 1;
        sendSuccess(res, { run: counters.idem, echo: req.body as unknown }, { status: 201 });
    });

    // Always a 4xx: a stored error response must be replayed with the CURRENT request id.
    router.post("/__test/idem-invalid", idempotency({ required: true }), () => {
        counters.invalid += 1;
        throw ValidationFailed.withDetails([{ field: "name", issue: "must be a string" }]);
    });

    // First call fails with a 5xx (lock released), later calls succeed.
    router.post("/__test/idem-flaky", idempotency({ required: true }), (_req: Request, res: Response) => {
        counters.flaky += 1;
        if (counters.flaky === 1) {
            throw new Error("synthetic transient failure");
        }
        sendSuccess(res, { run: counters.flaky }, { status: 201 });
    });

    router.post("/__test/idem-empty", idempotency({ required: true }), (_req: Request, res: Response) => {
        counters.noContent += 1;
        sendNoContent(res);
    });

    return router;
}

/** Rate-limited route: `limit` requests per `windowMs` per client IP. Mount at `/api`. */
export function buildRateLimitRouter(name: string, limit = 3, windowMs = 1_000): Router {
    const router = Router();
    router.get("/__test/limited", rateLimit({ name, limit, windowMs, subject: byIp }), (_req, res) => {
        sendSuccess(res, { ok: true });
    });
    return router;
}

/**
 * A real keyset-paginated query against Postgres (`generate_series`, no table needed), sorted by the default
 * sort `(created_at DESC, id DESC)` — the shape every list endpoint uses. Mount at `/api`.
 */
export function buildPaginationRouter(total: number): Router {
    const router = Router();
    router.get("/__test/page", async (req: Request, res: Response) => {
        const query = await validateQuery(PaginationQueryDto, req.query);
        const limit = resolveLimit(query.limit);
        const position = query.cursor === undefined ? null : decodeCursor(query.cursor);

        const rows: Array<{ id: number; created_at: Date }> = await db
            .select("id", "created_at")
            .from(
                db.raw(
                    `(SELECT g AS id, TIMESTAMPTZ '2026-01-01T00:00:00Z' + (g / 3) * INTERVAL '1 minute' AS created_at
                      FROM generate_series(1, ?) AS g) AS seeded`,
                    [total],
                ),
            )
            .modify((builder) => {
                if (position !== null) {
                    builder.whereRaw("(created_at, id) < (?::timestamptz, ?)", [String(position.sortValue), position.id]);
                }
            })
            .orderBy([
                { column: "created_at", order: "desc" },
                { column: "id", order: "desc" },
            ])
            .limit(limit + 1);

        const page = buildPage(rows, limit, (row) => [row.created_at.toISOString(), row.id]);
        sendSuccess(
            res,
            page.items.map((row) => ({ id: row.id })),
            { meta: { ...page.meta } },
        );
    });
    return router;
}

// ---------------------------------------------------------------------------------------------------------------
// access (spec §9.3): test-only routes, mounted at `/api` through `extraRouters` — never in src/routes.ts, never in
// the contract. Each still declares userGuard() → authorize(policy) like a production route.
// ---------------------------------------------------------------------------------------------------------------

/** The owner of synthetic resource `:id` from a real query (no table): 1 → user 101, 2 → user 102. */
async function resolveTestOwner(ctx: AccessContext): Promise<OwnershipDecision> {
    const id = parsePositiveId(ctx.params.id);
    if (id === undefined) {
        return "deny-not-found";
    }
    const result = await db.raw<{ rows: Array<{ owner_user_id: number }> }>(
        "SELECT owner_user_id FROM (VALUES (1, 101), (2, 102)) AS t(id, owner_user_id) WHERE id = ?",
        [id],
    );
    const owner = result.rows[0]?.owner_user_id;
    if (owner === undefined) {
        return "deny-not-found";
    }
    if (owner === ctx.auth.userId) {
        return "allow";
    }
    // Private to patients (404 hides existence); visible-but-forbidden for doctors.
    return ctx.auth.role === "patient" ? "deny-not-found" : "deny-forbidden";
}

/** A "locally suspended doctor" stand-in: user 9001 is blocked, from a real query. */
async function testBlockedDoctor(ctx: AccessContext): Promise<"allow" | "deny-forbidden"> {
    const result = await db.raw<{ rows: Array<{ blocked: boolean }> }>("SELECT ?::bigint = ANY (ARRAY[9001]::bigint[]) AS blocked", [
        ctx.auth.userId,
    ]);
    return result.rows[0]?.blocked === true ? "deny-forbidden" : "allow";
}

export const ACCESS_TEST_POLICIES: Record<string, UserPolicy> = {
    any: { kind: "user", roles: ["patient", "doctor", "admin"], owner: { kind: "none" } },
    admin: { kind: "user", roles: ["admin"], owner: { kind: "none" } },
    onboarding: {
        kind: "user",
        roles: ["doctor"],
        owner: { kind: "self" },
        accountState: { statuses: { doctor: ["pending", "active", "rejected"] } },
    },
    verified: { kind: "user", roles: ["patient"], owner: { kind: "self" }, accountState: { emailVerified: true } },
    owned: {
        kind: "user",
        roles: ["patient", "doctor"],
        owner: { kind: "resolver", name: "test_owner", resolve: resolveTestOwner },
    },
    checked: {
        kind: "user",
        roles: ["doctor", "admin"],
        owner: { kind: "none" },
        checks: [{ name: "test_blocked_doctor", appliesTo: ["doctor"], run: testBlockedDoctor }],
    },
    audit: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    params: { kind: "user", roles: ["patient"], owner: { kind: "none" } },
};

function echoPrincipal(req: Request, res: Response, status: 200 | 201 = 200): void {
    sendSuccess(res, { userId: req.auth?.userId, role: req.auth?.role }, { status });
}

/** `/api/__test/access/*` — the RBAC matrix routes (also served by scripts/access-qa-server.ts). Mount at `/api`. */
export function buildAccessTestRouter(): Router {
    const router = Router();
    const p = ACCESS_TEST_POLICIES;

    router.get("/__test/access/any", userGuard(), authorize(p.any), (req, res) => echoPrincipal(req, res));
    router.get("/__test/access/admin", userGuard(), authorize(p.admin), (req, res) => echoPrincipal(req, res));
    router.get("/__test/access/onboarding", userGuard(), authorize(p.onboarding), (req, res) => echoPrincipal(req, res));
    router.post(
        "/__test/access/verified",
        userGuard(),
        authorize(p.verified),
        idempotency({ required: false }),
        (req, res) => echoPrincipal(req, res, 201),
    );
    router.get("/__test/access/owned/:id", userGuard(), authorize(p.owned), (req, res) => echoPrincipal(req, res));
    router.get("/__test/access/checked", userGuard(), authorize(p.checked), (req, res) => echoPrincipal(req, res));

    return sealRouter(router);
}

/**
 * `POST /api/__test/audit` body `{ fail?: boolean }`: one audit row in a transaction that commits (201) or rolls back
 * (500). Mount at `/api`.
 */
export function buildAuditTestRouter(): Router {
    const router = Router();
    router.post("/__test/audit", userGuard(), authorize(ACCESS_TEST_POLICIES.audit), async (req: Request, res: Response) => {
        const fail = (req.body as { fail?: unknown } | undefined)?.fail === true;
        const auth = req.auth;
        if (auth === undefined) {
            throw new Error("unreachable: authorize requires a principal");
        }
        const audit = container.resolve<AuditRecorder>(TOKENS.AuditRecorder);
        await db.transaction(async (trx) => {
            await audit.record(trx, {
                actor: actorFromAuth(auth),
                action: "test.performed",
                entityType: "test_entity",
                entityId: 1,
                metadata: { reason: "synthetic" },
            });
            if (fail) {
                throw new Error("synthetic rollback");
            }
        });
        sendSuccess(res, { recorded: true }, { status: 201 });
    });
    return sealRouter(router);
}

/** Nested sealed routers whose handlers throw (fix #6: the route label keeps the full prefix). Mount at `/api`. */
export function buildNestedRouter(): Router {
    const inner = Router();
    inner.get("/boom/:id", () => {
        throw new Error("synthetic nested failure");
    });

    const guarded = Router();
    guarded.get("/boom/:id", userGuard(), authorize(ACCESS_TEST_POLICIES.admin), () => {
        throw new Error("synthetic nested failure");
    });

    const outer = Router();
    outer.use("/__test/nested/inner", sealRouter(inner));
    outer.use("/__test/nested/guarded", sealRouter(guarded));
    return sealRouter(outer);
}

/** `GET /api/__test/params/:value` — exercises fix #5 (malformed percent-encoding). Mount at `/api`. */
export function buildParamRouter(): Router {
    const router = Router();
    router.get("/__test/params/:value", userGuard(), authorize(ACCESS_TEST_POLICIES.params), (req: Request, res: Response) => {
        sendSuccess(res, { value: req.params.value });
    });
    return sealRouter(router);
}
