import type { ScheduleExceptionType } from "../enums";

export class ScheduleException {
    id!: number;
    /** Doctor-local `YYYY-MM-DD`. */
    date!: string;
    type!: ScheduleExceptionType;
    startTime!: string | null;
    endTime!: string | null;
    reason!: string | null;
    createdAt!: Date;

    constructor(data: Partial<ScheduleException>) {
        Object.assign(this, data);
    }
}
