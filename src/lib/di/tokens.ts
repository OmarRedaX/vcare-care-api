/** DI tokens. Every constructor parameter uses `@inject(TOKENS.X)` (ADR 0016) so transpile-only
 *  execution (tsx/esbuild, ts-jest isolatedModules) resolves identically to tsc. */
export const TOKENS = {
    Env: Symbol.for("Env"),
    Logger: Symbol.for("Logger"),
    Db: Symbol.for("Db"),
    /** Readiness-only pool (spec §3.1): never the request pool. */
    ProbeDb: Symbol.for("ProbeDb"),
    Redis: Symbol.for("Redis"),
    ShutdownState: Symbol.for("ShutdownState"),
    InFlightCounter: Symbol.for("InFlightCounter"),
    /** Identity's JWKS in memory (`lib/auth`); started by `server.ts`, never by the worker. */
    JwksCache: Symbol.for("JwksCache"),
    UserTokenVerifier: Symbol.for("UserTokenVerifier"),
    /** `record(trx, entry)` — one audit row in the caller's transaction (`lib/audit`). */
    AuditRecorder: Symbol.for("AuditRecorder"),
    HealthService: Symbol.for("HealthService"),
    HealthController: Symbol.for("HealthController"),
} as const;
