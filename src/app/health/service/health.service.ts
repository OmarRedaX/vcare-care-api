import { inject, injectable } from "tsyringe";
import type Redis from "ioredis";
import type { Knex } from "knex";
import { TOKENS } from "../../../lib/di/tokens";
import { probeDatabase } from "../../../lib/knex/probe";
import type { ShutdownState } from "../../../lib/lifecycle/shutdown-state";
import { probeRedis } from "../../../lib/redis/redis";
import { HealthStatus, ProbeStatus } from "../enums";
import type { LiveReport, ReadinessResult } from "../types";

const PROBE_TIMEOUT_MS = 500;

@injectable()
export class HealthService {
    constructor(
        @inject(TOKENS.ProbeDb) private readonly db: Knex,
        @inject(TOKENS.Redis) private readonly redis: Redis,
        @inject(TOKENS.ShutdownState) private readonly state: ShutdownState,
    ) {}

    /** Never checks a dependency and is unaffected by shutdown — a liveness failure means "restart me". */
    live(): LiveReport {
        return { status: HealthStatus.Ok };
    }

    /**
     * Postgres is fatal; Redis is Tier 2 and only reported (ADR 0006). The database probe uses its own 1-connection
     * pool (`TOKENS.ProbeDb`), so a busy request pool never reads as "down". Probes run concurrently, each
     * bounded by 500 ms, and run even during shutdown so the body stays truthful.
     */
    async ready(): Promise<ReadinessResult> {
        const [databaseUp, redisUp] = await Promise.all([
            probeDatabase(this.db, PROBE_TIMEOUT_MS),
            probeRedis(this.redis, PROBE_TIMEOUT_MS),
        ]);

        const checks = {
            database: databaseUp ? ProbeStatus.Up : ProbeStatus.Down,
            redis: redisUp ? ProbeStatus.Up : ProbeStatus.Down,
        };

        if (this.state.isShuttingDown() || !databaseUp) {
            return { httpStatus: 503, report: { status: HealthStatus.Down, checks } };
        }

        return {
            httpStatus: 200,
            report: { status: redisUp ? HealthStatus.Ok : HealthStatus.Degraded, checks },
        };
    }
}
