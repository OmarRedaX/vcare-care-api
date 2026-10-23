import { IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { IsIsoDateTimeWithOffset } from "../../../lib/validation/date-decorator";
import { IsIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { ToInt } from "../../../lib/validation/transforms";
import type { DoctorSlotsQuery } from "../types";

export class DoctorSlotsQueryDto {
    @ToInt() @IsInt() @Min(1) typeId!: number;
    @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset() from!: string;
    @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset() to!: string;
    @IsOptional() @IsString() @MaxLength(64) @IsIanaTimezone() timezone?: string;
    toQuery(): DoctorSlotsQuery { return { typeId: this.typeId, from: this.from, to: this.to, timezone: this.timezone }; }
}
