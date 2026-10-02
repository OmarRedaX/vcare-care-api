import type { HealthStatus, ProbeStatus } from "./enums";

export interface LiveReport {
    status: HealthStatus.Ok;
}

export interface HealthChecks {
    database: ProbeStatus;
    redis: ProbeStatus;
    /** Informational: the in-memory JWKS cache state (no network call). Never affects `status` or the HTTP code. */
    identityJwks: ProbeStatus;
}

export interface ReadyReport {
    status: HealthStatus;
    checks: HealthChecks;
}

export interface ReadinessResult {
    httpStatus: 200 | 503;
    report: ReadyReport;
}
