/** DI tokens. Every constructor parameter uses `@inject(TOKENS.X)` (ADR 0016) so transpile-only
 *  execution (tsx/esbuild, ts-jest isolatedModules) resolves identically to tsc. */
export const TOKENS = {
    Env: Symbol.for("Env"),
    Logger: Symbol.for("Logger"),
    Db: Symbol.for("Db"),
    Redis: Symbol.for("Redis"),
    ShutdownState: Symbol.for("ShutdownState"),
    InFlightCounter: Symbol.for("InFlightCounter"),
    HealthService: Symbol.for("HealthService"),
    HealthController: Symbol.for("HealthController"),
} as const;
