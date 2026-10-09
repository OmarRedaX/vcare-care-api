import type { ScheduleImpactProvider } from "../types";

/**
 * Default binding until `consultations` lands: no consultation can be affected, so it never blocks a write.
 * `consultations` rebinds `TOKENS.ScheduleImpactProvider` (bootstrap) with the real implementation.
 */
export class NoopScheduleImpactProvider implements ScheduleImpactProvider {
    findAffected(): Promise<number[]> {
        return Promise.resolve([]);
    }

    flagAffected(): Promise<void> {
        return Promise.resolve();
    }
}
