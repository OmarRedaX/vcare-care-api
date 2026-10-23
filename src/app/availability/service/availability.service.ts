import { inject, injectable } from "tsyringe";
import type { Env } from "../../../lib/config/types";
import { TOKENS } from "../../../lib/di/tokens";
import { NotFound, ValidationFailed } from "../../../lib/error/errors";
import type { AuthContext, Clock } from "../../../lib/types/types";
import { canonicalIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { computeSlots } from "../../../pkg/slots/compute";
import { localInstant } from "../../../pkg/slots/instant";
import { addDays, localDateOf } from "../../../pkg/slots/local-date";
import type { SlotRange } from "../../../pkg/slots/types";
import { clipWindow } from "../../../pkg/slots/window";
import { parseIsoDateTimeWithOffset } from "../../../pkg/utils/iso-datetime";
import { DoctorDiscoveryReader } from "../../doctors/service/doctor-discovery.reader";
import type { SlotDoctor } from "../../doctors/types";
import { PatientsService } from "../../patients/service/patients.service";
import { SchedulesService } from "../../schedules/service/schedules.service";
import { DAY_MS, SLOTS_MAX_SPAN_DAYS } from "../constants";
import type { DoctorSlotsQuery, SlotResult, SlotType } from "../types";
import { NextAvailableIndex } from "./next-available.index";
import { SlotInputsLoader } from "./slot-inputs.loader";

@injectable()
export class AvailabilityService {
    constructor(
        @inject(TOKENS.DoctorDiscoveryReader) private readonly doctors: DoctorDiscoveryReader,
        @inject(TOKENS.SchedulesService) private readonly schedules: SchedulesService,
        @inject(TOKENS.PatientsService) private readonly patients: PatientsService,
        @inject(TOKENS.SlotInputsLoader) private readonly loader: SlotInputsLoader,
        @inject(TOKENS.NextAvailableIndex) private readonly index: NextAvailableIndex,
        @inject(TOKENS.Env) private readonly env: Env,
        @inject(TOKENS.Clock) private readonly clock: Clock,
    ) {}

    async getSlots(actor: AuthContext, doctorUserId: number, query: DoctorSlotsQuery): Promise<SlotResult> {
        const from = parseIsoDateTimeWithOffset(query.from)?.getTime();
        const to = parseIsoDateTimeWithOffset(query.to)?.getTime();
        if (from === undefined || to === undefined || to <= from) throw ValidationFailed.withDetails([{ field: "to", issue: "must be after from" }]);
        if (to - from > SLOTS_MAX_SPAN_DAYS * DAY_MS) throw ValidationFailed.withDetails([{ field: "to", issue: "must be at most 14 days after from" }]);
        const doctor = await this.doctors.findForSlots(doctorUserId);
        if (doctor === undefined) throw NotFound;
        const type = await this.schedules.findBookableType(doctor.profileId, query.typeId);
        if (type === undefined || !doctor.bookableBase) throw NotFound;
        const timezone = await this.resolveRenderZone(actor, query.timezone);
        const now = this.clock.now();
        const window = clipWindow(from, to, now, now + this.env.BOOKING_HORIZON_DAYS * DAY_MS);
        const result: SlotResult = { slots: [], fromMs: window.fromMs, toMs: window.toMs, timezone, doctorTimezone: doctor.timezone };
        if (window.empty) return result;
        const fromDate = localDateOf(window.fromMs, doctor.timezone);
        const toDate = localDateOf(window.toMs - 1, doctor.timezone);
        const slots = await this.listSlots(doctor, { id: type.id, durationMinutes: type.durationMinutes }, fromDate, toDate);
        result.slots = slots.filter((slot) => slot.startMs > now && slot.startMs >= window.fromMs && slot.startMs < window.toMs);
        return result;
    }

    /** AV-R7: the zone slots are rendered in: the `timezone` parameter (canonical), else a patient's profile zone, else UTC. */
    async resolveRenderZone(actor: AuthContext, timezone: string | undefined): Promise<string> {
        if (timezone !== undefined) return canonicalIanaTimezone(timezone);
        return actor.role === "patient" ? (await this.patients.findProfile(actor.userId))?.timezone ?? "UTC" : "UTC";
    }

    async listSlots(doctor: SlotDoctor, type: SlotType, fromDate: string, toDate: string): Promise<SlotRange[]> {
        const version = await this.index.version(doctor.userId);
        if (version.usable) {
            const cached = await this.index.readSlots(doctor.userId, version.version, type.id, fromDate, toDate);
            if (cached !== undefined) return cached;
        }
        const bounds = { fromMs: localInstant(fromDate, 0, doctor.timezone, "start"),
            toMs: localInstant(addDays(toDate, 1), 0, doctor.timezone, "start") };
        const inputs = await this.loader.loadForSlots(doctor, type, bounds);
        const slots = computeSlots({ ...inputs, bounds });
        if (version.usable) await this.index.writeSlots(doctor.userId, version.version, type.id, fromDate, toDate, slots);
        return slots;
    }
}
