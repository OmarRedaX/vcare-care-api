import type { SlotResult } from "../types";

export class SlotWindowMetaDto {
    from!: string;
    to!: string;
    timezone!: string;
    doctorTimezone!: string;
    count!: number;
    static from(result: SlotResult): SlotWindowMetaDto {
        return { from: new Date(result.fromMs).toISOString(),
            to: new Date(result.toMs).toISOString(), timezone: result.timezone,
            doctorTimezone: result.doctorTimezone, count: result.slots.length };
    }
}
