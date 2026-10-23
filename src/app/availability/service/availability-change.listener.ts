import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import type { ConsultationChangeListener, ConsultationChangeEvent } from "../../consultations/types";
import type { DoctorChangeListener, DoctorChangedEvent } from "../../doctors/types";
import type { ScheduleChangeListener, ScheduleChangedEvent } from "../../schedules/types";
import { NextAvailableIndex } from "./next-available.index";

@injectable()
export class AvailabilityChangeListener implements ScheduleChangeListener, ConsultationChangeListener, DoctorChangeListener {
    constructor(@inject(TOKENS.NextAvailableIndex) private readonly index: NextAvailableIndex) {}
    private async invalidate(doctorUserId: number): Promise<void> {
        // Cache maintenance must never change the outcome of an already committed domain write.
        try { await this.index.invalidate(doctorUserId); } catch { /* the write remains authoritative */ }
    }
    async onScheduleChanged(event: ScheduleChangedEvent): Promise<void> { await this.invalidate(event.doctorUserId); }
    async onConsultationChanged(event: ConsultationChangeEvent): Promise<void> { await this.invalidate(event.doctorUserId); }
    async onDoctorChanged(event: DoctorChangedEvent): Promise<void> { await this.invalidate(event.doctorUserId); }
}
