import type { HealthStatus, ProbeStatus } from "./enums";

export interface LiveReport {
    status: HealthStatus.Ok;
}

/** `checks` stays open for additive informational probes (e.g. `identityJwks`, added with `lib/auth`). */
export interface HealthChecks {
    database: ProbeStatus;
    redis: ProbeStatus;
}

export interface ReadyReport {
    status: HealthStatus;
    checks: HealthChecks;
}

export interface ReadinessResult {
    httpStatus: 200 | 503;
    report: ReadyReport;
}
