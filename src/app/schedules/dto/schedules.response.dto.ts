import type { ConsultationType } from "../entity/consultation-type.entity";
import type { ScheduleException } from "../entity/schedule-exception.entity";
import type { WorkingHoursView } from "../types";

export class TimeIntervalResponseDto {
    startTime!: string;
    endTime!: string;
}

export class WorkingHoursDayResponseDto {
    weekday!: number;
    intervals!: TimeIntervalResponseDto[];
}

export class WorkingHoursResponseDto {
    timezone!: string;
    days!: WorkingHoursDayResponseDto[];

    static from(view: WorkingHoursView): WorkingHoursResponseDto {
        return {
            timezone: view.timezone,
            days: view.days.map((day) => ({
                weekday: day.weekday,
                intervals: day.intervals.map((interval) => ({ startTime: interval.startTime, endTime: interval.endTime })),
            })),
        };
    }
}

export class ScheduleExceptionResponseDto {
    id!: number;
    date!: string;
    type!: string;
    startTime!: string | null;
    endTime!: string | null;
    reason!: string | null;
    createdAt!: string;

    static from(entity: ScheduleException): ScheduleExceptionResponseDto {
        return {
            id: entity.id, date: entity.date, type: entity.type, startTime: entity.startTime, endTime: entity.endTime,
            reason: entity.reason, createdAt: entity.createdAt.toISOString(),
        };
    }
}

export class ConsultationTypeResponseDto {
    id!: number;
    name!: string;
    durationMinutes!: number;
    price!: number;
    currency!: string;
    isActive!: boolean;
    createdAt!: string;
    updatedAt!: string;

    static from(entity: ConsultationType): ConsultationTypeResponseDto {
        return {
            id: entity.id, name: entity.name, durationMinutes: entity.durationMinutes, price: entity.price, currency: entity.currency,
            isActive: entity.isActive, createdAt: entity.createdAt.toISOString(), updatedAt: entity.updatedAt.toISOString(),
        };
    }
}
