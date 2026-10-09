import type { ScheduleChangeListener } from "../types";

/** Default binding until `availability` lands (it rebinds `TOKENS.ScheduleChangeListener` to invalidate its caches). */
export class NoopScheduleChangeListener implements ScheduleChangeListener {
    onScheduleChanged(): Promise<void> {
        return Promise.resolve();
    }
}
