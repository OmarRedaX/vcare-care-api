import type { SuspensionImpactProvider } from "../types";

/**
 * Default binding until `consultations` lands: no consultation exists, so none is flagged.
 * `consultations` rebinds `TOKENS.SuspensionImpactProvider` (bootstrap) with the real implementation.
 */
export class NoopSuspensionImpactProvider implements SuspensionImpactProvider {
    flagFutureConsultations(): Promise<number[]> {
        return Promise.resolve([]);
    }

    listFlaggedConsultations(): Promise<number[]> {
        return Promise.resolve([]);
    }
}
