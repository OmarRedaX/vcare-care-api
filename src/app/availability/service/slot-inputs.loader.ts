import { inject, injectable } from "tsyringe";
import { DateTime } from "luxon";
import { TOKENS } from "../../../lib/di/tokens";
import { addDays } from "../../../pkg/slots/local-date";
import type { SlotDoctor } from "../../doctors/types";
import type { DoctorDiscoveryReader } from "../../doctors/service/doctor-discovery.reader";
import { SlotInputsReader } from "../../schedules/service/slot-inputs.reader";
import { BusyIntervalsReader } from "../../consultations/service/busy-intervals.reader";
import type { DoctorSlotInputs, SlotType, SlotWindow } from "../types";

@injectable()
export class SlotInputsLoader {
    constructor(
        @inject(TOKENS.DoctorDiscoveryReader) private readonly doctors: DoctorDiscoveryReader,
        @inject(TOKENS.SlotInputsReader) private readonly schedules: SlotInputsReader,
        @inject(TOKENS.BusyIntervalsReader) private readonly busy: BusyIntervalsReader,
    ) { void this.doctors; }

    async loadForSlots(doctor: SlotDoctor, type: SlotType, window: SlotWindow): Promise<DoctorSlotInputs> {
        const fromDate = addDays(DateTime.fromMillis(window.fromMs, { zone: "utc" }).toISODate()!, -2);
        const toDate = addDays(DateTime.fromMillis(window.toMs, { zone: "utc" }).toISODate()!, 2);
        const [schedule, busy] = await Promise.all([
            this.schedules.loadHoursAndExceptions(doctor.profileId, fromDate, toDate),
            this.busy.listBusy([doctor.userId], window.fromMs, window.toMs),
        ]);
        return { timezone: doctor.timezone, weekly: schedule.weekly, exceptions: schedule.exceptions,
            busy: busy.get(doctor.userId) ?? [], durationMinutes: type.durationMinutes, typeId: type.id };
    }
}
