/** DI tokens. Every constructor parameter uses `@inject(TOKENS.X)` (ADR 0016) so transpile-only
 *  execution (tsx/esbuild, ts-jest isolatedModules) resolves identically to tsc. */
export const TOKENS = {
    Env: Symbol.for("Env"),
    Logger: Symbol.for("Logger"),
    Db: Symbol.for("Db"),
    /** Readiness-only pool (spec §3.1): never the request pool. */
    ProbeDb: Symbol.for("ProbeDb"),
    Redis: Symbol.for("Redis"),
    IDENTITY_CLIENT: Symbol.for("IdentityClient"),
    ShutdownState: Symbol.for("ShutdownState"),
    InFlightCounter: Symbol.for("InFlightCounter"),
    /** Identity's JWKS in memory (`lib/auth`); started by `server.ts`, never by the worker. */
    JwksCache: Symbol.for("JwksCache"),
    UserTokenVerifier: Symbol.for("UserTokenVerifier"),
    /** `record(trx, entry)` — one audit row in the caller's transaction (`lib/audit`). */
    AuditRecorder: Symbol.for("AuditRecorder"),
    STORAGE: Symbol.for("Storage"),
    HealthService: Symbol.for("HealthService"),
    HealthController: Symbol.for("HealthController"),
    SpecialtiesService: Symbol.for("SpecialtiesService"),
    SpecialtiesController: Symbol.for("SpecialtiesController"),
    DoctorsService: Symbol.for("DoctorsService"),
    DoctorsController: Symbol.for("DoctorsController"),
    /** Shared Identity-sync engine (verification, suspension, reinstatement jobs); registered before its callers. */
    IdentitySyncService: Symbol.for("IdentitySyncService"),
    /** Clock and randomness of the sync engine; tests bind a fake. */
    SyncTiming: Symbol.for("SyncTiming"),
    VerificationService: Symbol.for("VerificationService"),
    VerificationController: Symbol.for("VerificationController"),
    AuditService: Symbol.for("AuditService"),
    AuditController: Symbol.for("AuditController"),
    /** Clock of the audit read window (`{ now(): number }`); tests bind a fake. */
    AuditClock: Symbol.for("AuditClock"),
    AdminDoctorsService: Symbol.for("AdminDoctorsService"),
    AdminDoctorsController: Symbol.for("AdminDoctorsController"),
    /** Port: future non-terminal consultations a suspension flags for follow-up (default no-op; `consultations` rebinds). */
    SuspensionImpactProvider: Symbol.for("SuspensionImpactProvider"),
    SchedulesService: Symbol.for("SchedulesService"),
    SchedulesController: Symbol.for("SchedulesController"),
    /** Port: future non-terminal consultations a schedule change strands (default no-op; `consultations` rebinds). */
    ScheduleImpactProvider: Symbol.for("ScheduleImpactProvider"),
    /** Port: after-commit hook for cache invalidation (default no-op; `availability` rebinds). */
    ScheduleChangeListener: Symbol.for("ScheduleChangeListener"),
    /** Port: the caller's doctor profile for `schedules`, resolved lazily through `doctors`. */
    ScheduleOwnerResolver: Symbol.for("ScheduleOwnerResolver"),
} as const;
