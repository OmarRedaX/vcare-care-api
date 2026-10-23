import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { addDays, localDateOf } from "../../../pkg/slots/local-date";
import type { SlotDoctor, IndexDoctor } from "../../doctors/types";
import type { DoctorDiscoveryReader } from "../../doctors/service/doctor-discovery.reader";
import { SlotInputsReader } from "../../schedules/service/slot-inputs.reader";
import { BusyIntervalsReader } from "../../consultations/service/busy-intervals.reader";
import type { DoctorSlotInputs, SlotType, SlotWindow } from "../types";

/** Doctors differ from UTC by at most one calendar day; two days of margin on each side cover every local date the window touches. */
function utcDateRange(window: SlotWindow): { fromDate: string; toDate: string } {
    return { fromDate: addDays(localDateOf(window.fromMs, "UTC"), -2), toDate: addDays(localDateOf(window.toMs, "UTC"), 2) };
}

@injectable()
export class SlotInputsLoader {
    constructor(
        @inject(TOKENS.DoctorDiscoveryReader) private readonly doctors: DoctorDiscoveryReader,
        @inject(TOKENS.SlotInputsReader) private readonly schedules: SlotInputsReader,
        @inject(TOKENS.BusyIntervalsReader) private readonly busy: BusyIntervalsReader,
    ) { void this.doctors; }

    async loadForSlots(doctor: SlotDoctor, type: SlotType, window: SlotWindow): Promise<DoctorSlotInputs> {
        const { fromDate, toDate } = utcDateRange(window);
        const [schedule, busy] = await Promise.all([
            this.schedules.loadHoursAndExceptions(doctor.profileId, fromDate, toDate),
            this.busy.listBusy([doctor.userId], window.fromMs, window.toMs),
        ]);
        return { timezone: doctor.timezone, weekly: schedule.weekly, exceptions: schedule.exceptions,
            busy: busy.get(doctor.userId) ?? [], durationMinutes: type.durationMinutes, typeId: type.id };
    }

    /**
     * Inputs of a batch of doctors for their shortest active type (ties: lowest id): four statements however many doctors (callers chunk at
     * 100), run one after the other so a batch holds one pool connection at a time (the worker pool is 6 and the sweep pins one). A doctor
     * without a live active type is absent from the result.
     */
    async loadShortestType(doctors: readonly IndexDoctor[], window: SlotWindow): Promise<Map<number, DoctorSlotInputs>> {
        const inputs = new Map<number, DoctorSlotInputs>();
        if (doctors.length === 0) return inputs;
        const { fromDate, toDate } = utcDateRange(window);
        const schedule = await this.schedules.loadSlotInputs(doctors.map((doctor) => doctor.profileId), fromDate, toDate);
        const busy = await this.busy.listBusy(doctors.map((doctor) => doctor.userId), window.fromMs, window.toMs);
        for (const doctor of doctors) {
            const known = schedule.get(doctor.profileId);
            if (known === undefined || known.shortestType === null) continue;
            inputs.set(doctor.userId, { timezone: doctor.timezone, weekly: known.weekly, exceptions: known.exceptions,
                busy: busy.get(doctor.userId) ?? [], durationMinutes: known.shortestType.durationMinutes, typeId: known.shortestType.id });
        }
        return inputs;
    }
}
