import type { Express } from "express";
import request from "supertest";
import type { Test } from "supertest";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { buildTestApps } from "./app";
import { closeDb, ownerDb, truncateAll } from "./db";
import { buildFakeJwksWiring, startFakeJwks } from "./fake-jwks";
import { closeRedis, ensureRedisReady, flushByPrefix } from "./redis";
import { signUserToken } from "./tokens";
import type { FakeJwks, FakeJwksWiring } from "./types";

/** Synthetic body marker: it must never reach a log line, an audit row or a response outside the article it belongs to. */
export const BODY_MARKER = "SYNTHETIC-HELP-BODY-7731";
export const LIST = "/api/help-articles";

export interface ActorSpec {
    label: string;
    sub: string;
    role: "patient" | "doctor" | "admin";
    status: "pending" | "active" | "rejected" | "suspended";
}

export const ACTORS = {
    patient: { label: "patient active", sub: "101", role: "patient", status: "active" },
    doctor: { label: "doctor active", sub: "202", role: "doctor", status: "active" },
    doctorPending: { label: "doctor pending", sub: "203", role: "doctor", status: "pending" },
    doctorRejected: { label: "doctor rejected", sub: "204", role: "doctor", status: "rejected" },
    admin: { label: "admin active", sub: "303", role: "admin", status: "active" },
    admin2: { label: "second admin", sub: "304", role: "admin", status: "active" },
    patientPending: { label: "patient pending", sub: "105", role: "patient", status: "pending" },
    adminPending: { label: "admin pending", sub: "305", role: "admin", status: "pending" },
    patientSuspended: { label: "patient suspended", sub: "106", role: "patient", status: "suspended" },
    doctorSuspended: { label: "doctor suspended", sub: "206", role: "doctor", status: "suspended" },
    adminSuspended: { label: "admin suspended", sub: "306", role: "admin", status: "suspended" },
} as const satisfies Record<string, ActorSpec>;

export type ActorName = keyof typeof ACTORS;

export interface ArticleBody {
    id: number;
    title: string;
    body: string;
    category: string;
    audience: string;
    isPublished: boolean;
    publishedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SummaryBody {
    id: number;
    title: string;
    category: string;
    audience: string;
    isPublished: boolean;
    publishedAt: string | null;
    updatedAt: string;
}

export interface SeedArticle {
    title: string;
    body?: string;
    category?: string;
    audience?: "patient" | "doctor";
    isPublished?: boolean;
    /** ISO string (kept as text so microseconds survive); defaults to a fixed instant when published, null otherwise. */
    publishedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
    deleted?: boolean;
}

export interface AuditRow {
    actor_user_id: number;
    actor_role: string;
    action: string;
    entity_type: string;
    entity_id: number;
    request_id: string | null;
    metadata: Record<string, unknown>;
}

export interface DbRow {
    id: number;
    title: string;
    body: string;
    category: string;
    audience: string;
    is_published: boolean;
    published_at: Date | null;
    created_by: number;
    updated_by: number;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
}

export interface HelpArticlesHarness {
    readonly app: Express;
    readonly fake: FakeJwks;
    readonly tokens: Record<ActorName, string>;
    /** `METHOD contract-path` to the statuses observed, asserted against the contract at the end of a suite. */
    readonly observed: Map<string, Set<number>>;
    get(path: string, actor?: ActorName, headers?: Record<string, string>): Test;
    post(body: unknown, actor?: ActorName, headers?: Record<string, string>): Test;
    patch(id: number | string, body: unknown, actor?: ActorName, headers?: Record<string, string>): Test;
    del(id: number | string, actor?: ActorName, headers?: Record<string, string>): Test;
    seed(rows: SeedArticle[]): Promise<number[]>;
    seedMany(count: number, overrides?: Partial<SeedArticle>): Promise<number[]>;
    auditRows(): Promise<AuditRow[]>;
    dbRows(): Promise<DbRow[]>;
}

export const padded = (n: number): string => String(n).padStart(3, "0");

export const validCreate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: "Synthetic Article 001",
    body: `# Synthetic heading\n\n${BODY_MARKER}`,
    category: "how-it-works",
    audience: "patient",
    isPublished: true,
    ...overrides,
});

/**
 * Registers the shared lifecycle of a help-articles integration suite (fake JWKS, the REAL apps, real Postgres and Redis,
 * truncate + limiter/idempotency flush per test) and returns the helpers. Call it once inside the top-level `describe`.
 */
export function useHelpArticlesHarness(): HelpArticlesHarness {
    let app!: Express;
    let fake!: FakeJwks;
    let wiring!: FakeJwksWiring;
    const tokens = {} as Record<ActorName, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const observed = new Map<string, Set<number>>();

    function record(req: Test, method: string, path: string): Test {
        const pathname = path.split("?")[0] ?? path;
        const key = `${method} ${pathname.replace(/^\/api\/help-articles\/.+$/, "/api/help-articles/{id}")}`;
        const originalEnd = req.end.bind(req) as (callback?: (error: Error | null, res: request.Response) => void) => Test;
        req.end = ((callback?: (error: Error | null, res: request.Response) => void): Test =>
            originalEnd((error, res) => {
                if (res !== undefined) {
                    const set = observed.get(key) ?? new Set<number>();
                    set.add(res.status);
                    observed.set(key, set);
                }
                callback?.(error, res);
            })) as Test["end"];
        return req;
    }

    const authed = (req: Test, actor: ActorName | undefined): Test => (actor === undefined ? req : req.set("Authorization", `Bearer ${tokens[actor]}`));

    const harness: HelpArticlesHarness = {
        get app() {
            return app;
        },
        get fake() {
            return fake;
        },
        tokens,
        observed,
        get: (path, actor, headers = {}) => authed(record(request(app).get(path), "GET", path), actor).set(headers),
        post: (body, actor, headers = {}) => authed(record(request(app).post(LIST), "POST", LIST), actor).set(headers).send(body as object),
        patch: (id, body, actor, headers = {}) =>
            authed(record(request(app).patch(`${LIST}/${id}`), "PATCH", `${LIST}/${id}`), actor).set(headers).send(body as object),
        del: (id, actor, headers = {}) => authed(record(request(app).delete(`${LIST}/${id}`), "DELETE", `${LIST}/${id}`), actor).set(headers),
        async seed(rows) {
            if (rows.length === 0) return [];
            const inserted = await ownerDb("help_articles")
                .insert(
                    rows.map((row) => {
                        const isPublished = row.isPublished ?? true;
                        const publishedAt = row.publishedAt !== undefined ? row.publishedAt : isPublished ? "2026-01-01T00:00:00.000000Z" : null;
                        return {
                            title: row.title,
                            body: row.body ?? `${BODY_MARKER} ${row.title}`,
                            category: row.category ?? "how-it-works",
                            audience: row.audience ?? "patient",
                            is_published: isPublished,
                            published_at: publishedAt,
                            created_by: 303,
                            updated_by: 303,
                            ...(row.createdAt === undefined ? {} : { created_at: row.createdAt }),
                            ...(row.updatedAt === undefined ? {} : { updated_at: row.updatedAt }),
                            deleted_at: row.deleted === true ? "2026-02-01T00:00:00.000000Z" : null,
                        };
                    }),
                )
                .returning("id");
            return inserted.map((row: { id: number | string }) => Number(row.id));
        },
        seedMany: (count, overrides = {}) =>
            harness.seed(Array.from({ length: count }, (_v, i) => ({ title: `Synthetic Article ${padded(i + 1)}`, ...overrides }))),
        async auditRows() {
            const result = await ownerDb.raw<{ rows: AuditRow[] }>(
                `SELECT actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata
                 FROM audit_logs WHERE entity_type = 'help_article' ORDER BY id`,
            );
            return result.rows;
        },
        async dbRows() {
            const result = await ownerDb.raw<{ rows: DbRow[] }>(
                `SELECT id, title, body, category, audience, is_published, published_at, created_by, updated_by, created_at, updated_at, deleted_at
                 FROM help_articles ORDER BY id`,
            );
            return result.rows;
        },
    };

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["k1"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) {
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        }
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp; // the REAL src/routes.ts mounts the help-articles router
        for (const [name, actor] of Object.entries(ACTORS) as Array<[ActorName, ActorSpec]>) {
            tokens[name] = await signUserToken(fake.key("k1"), { sub: actor.sub, role: actor.role, status: actor.status });
        }
    });

    beforeEach(async () => {
        await truncateAll();
        await flushByPrefix(["idem:", "rl:"]);
    });

    afterAll(async () => {
        await truncateAll();
        await flushByPrefix(["idem:", "rl:"]);
        for (const entry of previous) {
            if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        }
        wiring.cache.stop();
        await fake.close();
        await closeRedis();
        await closeDb();
    });

    return harness;
}
