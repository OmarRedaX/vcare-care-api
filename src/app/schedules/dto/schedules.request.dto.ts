import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateIf, ValidateNested } from "class-validator";
import { PaginationQueryDto } from "../../../lib/http/pagination/pagination.request.dto";
import { IsCalendarDate } from "../../../lib/validation/date-decorator";
import { CodePointLength, NoControlCharacters } from "../../../lib/validation/string-decorators";
import { ToBoolean } from "../../../lib/validation/transforms";
import { parseTimeOfDay } from "../../../pkg/slots/local-time";
import {
    DURATION_MAX, DURATION_MIN, MAX_INTERVALS_PER_DAY, MAX_WEEKDAYS, NAME_MAX_LENGTH, NAME_MIN_LENGTH, PRICE_MAX, REASON_MAX_LENGTH,
    TIME_OF_DAY_PATTERN,
} from "../constants";
import { ScheduleExceptionType } from "../enums";
import type { ConsultationTypeChanges, ConsultationTypeInput, ExceptionInput, WorkingHoursInput } from "../types";

export class TimeIntervalDto {
    @Matches(TIME_OF_DAY_PATTERN) startTime!: string;
    @Matches(TIME_OF_DAY_PATTERN) endTime!: string;
}

export class WorkingHoursDayDto {
    @IsInt() @Min(1) @Max(7) weekday!: number;
    @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_INTERVALS_PER_DAY) @ValidateNested({ each: true }) @Type(() => TimeIntervalDto) intervals!: TimeIntervalDto[];
}

export class WorkingHoursReplaceDto {
    @IsArray() @ArrayMaxSize(MAX_WEEKDAYS) @ValidateNested({ each: true }) @Type(() => WorkingHoursDayDto) days!: WorkingHoursDayDto[];
    @ValidateIf((_o, v) => v !== undefined) @IsBoolean() confirmConflicts?: boolean;

    toInput(): WorkingHoursInput {
        return {
            days: this.days.map((day) => ({
                weekday: day.weekday,
                intervals: day.intervals.map((interval) => ({ startMinute: parseTimeOfDay(interval.startTime), endMinute: parseTimeOfDay(interval.endTime) })),
            })),
            confirmConflicts: this.confirmConflicts === true,
        };
    }
}

export class ScheduleExceptionCreateDto {
    @IsIn(Object.values(ScheduleExceptionType)) type!: ScheduleExceptionType;
    @IsCalendarDate() date!: string;
    @ValidateIf((_o, v) => v !== undefined) @IsCalendarDate() endDate?: string;
    @ValidateIf((_o, v) => v !== undefined) @Matches(TIME_OF_DAY_PATTERN) startTime?: string;
    @ValidateIf((_o, v) => v !== undefined) @Matches(TIME_OF_DAY_PATTERN) endTime?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @CodePointLength(0, REASON_MAX_LENGTH) @NoControlCharacters("nul") reason?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsBoolean() confirmConflicts?: boolean;

    toInput(): ExceptionInput {
        return {
            type: this.type, date: this.date, endDate: this.endDate ?? null,
            startMinute: this.startTime === undefined ? null : parseTimeOfDay(this.startTime),
            endMinute: this.endTime === undefined ? null : parseTimeOfDay(this.endTime),
            reason: this.reason ?? null, confirmConflicts: this.confirmConflicts === true,
        };
    }
}

export class ListExceptionsQueryDto extends PaginationQueryDto {
    @IsOptional() @IsCalendarDate() fromDate?: string;
    @IsOptional() @IsCalendarDate() toDate?: string;
}

export class DeleteExceptionQueryDto {
    @IsOptional() @ToBoolean() @IsBoolean() confirmConflicts?: boolean;
}

export class ConsultationTypeCreateDto {
    @IsString() @CodePointLength(NAME_MIN_LENGTH, NAME_MAX_LENGTH) @NoControlCharacters("all") @Matches(/\S/) name!: string;
    @IsInt() @Min(DURATION_MIN) @Max(DURATION_MAX) durationMinutes!: number;
    @IsInt() @Min(0) @Max(PRICE_MAX) price!: number;
    @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;

    toInput(): ConsultationTypeInput {
        return { name: this.name, durationMinutes: this.durationMinutes, price: this.price, currency: this.currency };
    }
}

/** Every member optional; absent = unchanged; `null` is rejected by the member validators. */
export class ConsultationTypeUpdateDto {
    @ValidateIf((_o, v) => v !== undefined) @IsString() @CodePointLength(NAME_MIN_LENGTH, NAME_MAX_LENGTH) @NoControlCharacters("all") @Matches(/\S/) name?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(DURATION_MIN) @Max(DURATION_MAX) durationMinutes?: number;
    @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(PRICE_MAX) price?: number;
    @ValidateIf((_o, v) => v !== undefined) @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
    @ValidateIf((_o, v) => v !== undefined) @IsBoolean() isActive?: boolean;

    /** minProperties: 1 — checks the five members explicitly, never `Object.keys`. */
    isEmpty(): boolean {
        return this.name === undefined && this.durationMinutes === undefined && this.price === undefined &&
            this.currency === undefined && this.isActive === undefined;
    }

    toChanges(): ConsultationTypeChanges {
        const changes: ConsultationTypeChanges = {};
        if (this.name !== undefined) changes.name = this.name;
        if (this.durationMinutes !== undefined) changes.durationMinutes = this.durationMinutes;
        if (this.price !== undefined) changes.price = this.price;
        if (this.currency !== undefined) changes.currency = this.currency;
        if (this.isActive !== undefined) changes.isActive = this.isActive;
        return changes;
    }
}

export class ListTypesQueryDto extends PaginationQueryDto {
    @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean;
}
