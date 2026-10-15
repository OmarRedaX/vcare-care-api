import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { IsIsoDateTimeWithOffset } from "../../../lib/validation/date-decorator";
import { CodePointLength, NoControlCharacters, NotBlank } from "../../../lib/validation/string-decorators";
import { IsIanaTimezone } from "../../../lib/validation/timezone-decorator";
import { ToBoolean, ToCommaList, ToInt } from "../../../lib/validation/transforms";
import { parseIsoDateTimeWithOffset } from "../../../pkg/utils/iso-datetime";
import { COMPLAINT_MAX_LENGTH, COMPLAINT_MIN_LENGTH, MAX_STATUS_FILTER, REASON_MAX_LENGTH, REASON_MIN_LENGTH } from "../constants";
import { ConsultationScope, ConsultationStatus } from "../enums";
import type { BookInput, CancelInput, ConsultationListQuery, RescheduleInput } from "../types";

/** The validated string is an instant by construction (`IsIsoDateTimeWithOffset`); `NaN` would only mean a validator bug. */
function instantMs(value: string): number {
    return parseIsoDateTimeWithOffset(value)?.getTime() ?? Number.NaN;
}

/** No duration, end, patient id or price from the client: all derived server-side. */
export class ConsultationCreateDto {
    @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) doctorId!: number;
    @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) typeId!: number;
    @IsString() @IsIsoDateTimeWithOffset() startsAt!: string;
    @IsString() @NotBlank() @CodePointLength(COMPLAINT_MIN_LENGTH, COMPLAINT_MAX_LENGTH) @NoControlCharacters("nul") complaintText!: string;
    @IsString() @IsIanaTimezone() patientTimezone!: string;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) followUpOfRecordId?: number;

    toInput(): BookInput {
        return { doctorId: this.doctorId, typeId: this.typeId, startsAtMs: instantMs(this.startsAt), complaintText: this.complaintText,
            patientTimezone: this.patientTimezone, followUpOfRecordId: this.followUpOfRecordId };
    }
}

export class RescheduleDto {
    @IsString() @IsIsoDateTimeWithOffset() startsAt!: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(REASON_MIN_LENGTH, REASON_MAX_LENGTH) @NoControlCharacters("nul") reason?: string;

    toInput(): RescheduleInput {
        return { startsAtMs: instantMs(this.startsAt), reason: this.reason };
    }
}

export class CancelDto {
    @ValidateIf((_o, v) => v !== undefined) @IsString() @NotBlank() @CodePointLength(REASON_MIN_LENGTH, REASON_MAX_LENGTH) @NoControlCharacters("nul") reason?: string;

    toInput(): CancelInput {
        return { reason: this.reason };
    }
}

export class ListConsultationsQueryDto extends PaginationQueryDto {
    @IsIn(Object.values(ConsultationScope)) scope: ConsultationScope = ConsultationScope.Upcoming;
    @IsOptional() @ToCommaList() @IsArray() @ArrayMaxSize(MAX_STATUS_FILTER) @IsIn(Object.values(ConsultationStatus), { each: true }) status?: ConsultationStatus[];
    @IsOptional() @IsString() @IsIsoDateTimeWithOffset() from?: string;
    @IsOptional() @IsString() @IsIsoDateTimeWithOffset() to?: string;
    @IsOptional() @ToInt() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) doctorUserId?: number;
    @IsOptional() @ToInt() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) patientUserId?: number;
    @IsOptional() @ToBoolean() @IsBoolean() needsAdminFollowup?: boolean;
    @IsOptional() @IsString() @IsIanaTimezone() timezone?: string;

    toQuery(): ConsultationListQuery {
        return {
            scope: this.scope, statuses: this.status === undefined ? undefined : [...new Set(this.status)],
            fromMs: this.from === undefined ? undefined : instantMs(this.from), toMs: this.to === undefined ? undefined : instantMs(this.to),
            doctorUserId: this.doctorUserId, patientUserId: this.patientUserId, needsAdminFollowup: this.needsAdminFollowup,
            timezone: this.timezone, cursor: this.cursor, limit: this.limit,
        };
    }
}

export class GetConsultationQueryDto {
    @IsOptional() @IsString() @IsIanaTimezone() timezone?: string;
}
