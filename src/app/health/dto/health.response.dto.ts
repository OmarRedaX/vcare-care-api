import type { HealthStatus, ProbeStatus } from "../enums";
import type { LiveReport, ReadyReport } from "../types";

/** Contract schema `HealthLive`. Health is the documented non-enveloped exception. */
export class LiveResponseDto {
    status!: HealthStatus.Ok;

    static from(report: LiveReport): LiveResponseDto {
        const dto = new LiveResponseDto();
        dto.status = report.status;
        return dto;
    }
}

/** Contract schema `HealthStatus`. Explicit field copy — nothing else is ever exposed by a probe. */
export class ReadyResponseDto {
    status!: HealthStatus;
    checks!: { database: ProbeStatus; redis: ProbeStatus };

    static from(report: ReadyReport): ReadyResponseDto {
        const dto = new ReadyResponseDto();
        dto.status = report.status;
        dto.checks = { database: report.checks.database, redis: report.checks.redis };
        return dto;
    }
}
