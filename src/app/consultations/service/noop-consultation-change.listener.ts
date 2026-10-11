import type { ConsultationChangeListener } from "../types";

/** Default binding until discovery lands: it rebinds `TOKENS.ConsultationChangeListener` to invalidate slot and next-available caches. */
export class NoopConsultationChangeListener implements ConsultationChangeListener {
    onConsultationChanged(): Promise<void> {
        return Promise.resolve();
    }
}
