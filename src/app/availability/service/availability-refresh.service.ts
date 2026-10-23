import type { Logger } from "../../../lib/logger/logger";
import type { Clock } from "../../../lib/types/types";
import type { TickOutcome } from "../../../lib/worker/types";
import type { DoctorDiscoveryReader } from "../../doctors/service/doctor-discovery.reader";
import {
    GAUGE_EVERY_MS, LOG_REFRESH_DONE, METRIC_REFRESH_QUEUE_DEPTH, METRIC_SWEEP_AGE_S, REFRESH_BATCH, REFRESH_MAX_BATCHES_PER_TICK,
} from "../constants";
import type { NextAvailableComputer } from "./next-available.computer";
import type { NextAvailableIndex } from "./next-available.index";

/**
 * `availability-refresh` (AV-R24): drains the refresh set that every input change feeds. `SPOP` is atomic, so no lock is needed; ids that
 * could not be written go back into the set, a doctor who is no longer bookable is simply dropped (the sweep covers anything lost).
 */
export class AvailabilityRefreshService {
    private lastGaugeAt = 0;

    constructor(
        private readonly reader: DoctorDiscoveryReader,
        private readonly computer: NextAvailableComputer,
        private readonly index: NextAvailableIndex,
        private readonly logger: Logger,
        private readonly clock: Clock,
    ) {}

    async tick(signal: AbortSignal): Promise<TickOutcome | void> {
        if (!this.index.isUsable()) return "incomplete";
        let refreshed = 0;
        let outcome: TickOutcome = "done";
        for (let batch = 0; batch < REFRESH_MAX_BATCHES_PER_TICK && !signal.aborted; batch += 1) {
            const popped = await this.index.popRefresh(REFRESH_BATCH);
            if (popped === undefined) { outcome = "incomplete"; break; }
            if (popped.length === 0) break;
            try {
                const doctors = await this.reader.listBookableForIndex(popped);
                const result = await this.computer.refresh(doctors.items, this.clock.now());
                refreshed += doctors.items.length;
                if (result.failed.length > 0) { outcome = "incomplete"; await this.index.requeue(result.failed); }
            } catch (error) {
                await this.index.requeue(popped);
                throw error;
            }
        }
        if (refreshed > 0) this.logger.info(LOG_REFRESH_DONE, { doctors: refreshed });
        await this.emitGauges();
        return outcome;
    }

    /** Queue depth and sweep age, at most every 30 s (feeds the `AvailabilitySweepStale` alert). */
    private async emitGauges(): Promise<void> {
        const now = this.clock.now();
        if (now - this.lastGaugeAt < GAUGE_EVERY_MS) return;
        this.lastGaugeAt = now;
        const depth = await this.index.refreshDepth();
        if (depth !== undefined) this.logger.metric(METRIC_REFRESH_QUEUE_DEPTH, depth);
        const sweptAt = await this.index.readSweptAt();
        if (typeof sweptAt === "number") this.logger.metric(METRIC_SWEEP_AGE_S, Math.max(0, Math.round((now - sweptAt) / 1000)));
    }
}
