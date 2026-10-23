import { toIsoInZone } from "../../../pkg/utils/time";
import type { SlotRange } from "../../../pkg/slots/types";

export class SlotResponseDto {
    startsAt!: string;
    endsAt!: string;
    startsAtLocal!: string;
    endsAtLocal!: string;
    timezone!: string;

    static from(slot: SlotRange, timezone: string): SlotResponseDto {
        return { startsAt: new Date(slot.startMs).toISOString(),
            endsAt: new Date(slot.endMs).toISOString(),
            startsAtLocal: toIsoInZone(slot.startMs, timezone), endsAtLocal: toIsoInZone(slot.endMs, timezone), timezone };
    }
}
