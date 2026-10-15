import { IsString, ValidateIf } from "class-validator";
import { IsIsoDateTimeWithOffset } from "../../../lib/validation/date-decorator";
import { CodePointLength, NoControlCharacters } from "../../../lib/validation/string-decorators";
import { canonicalIanaTimezone, IsIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { parseIsoDateTimeWithOffset } from "../../../pkg/utils/iso-datetime";
import { NO_SHOW_NOTE_MAX_LENGTH } from "../constants";
import type { CalendarQuery, NoShowInput } from "../types";

/** The validated string is an instant by construction (`IsIsoDateTimeWithOffset`); `NaN` would only mean a validator bug. */
function instantMs(value: string): number {
    return parseIsoDateTimeWithOffset(value)?.getTime() ?? Number.NaN;
}

/** Optional free text, blank allowed (the contract has no `minLength`); never stored, only its length is audited. */
export class NoShowDto {
    @ValidateIf((_o, v) => v !== undefined) @IsString() @CodePointLength(0, NO_SHOW_NOTE_MAX_LENGTH) @NoControlCharacters("nul") note?: string;

    toInput(): NoShowInput {
        return { note: this.note };
    }
}

export class CalendarQueryDto {
    @IsString() @IsIsoDateTimeWithOffset() from!: string;
    @IsString() @IsIsoDateTimeWithOffset() to!: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @IsIanaTimezone() timezone?: string;

    toQuery(): CalendarQuery {
        return { fromMs: instantMs(this.from), toMs: instantMs(this.to), timezone: this.timezone === undefined ? undefined : canonicalIanaTimezone(this.timezone) };
    }
}
