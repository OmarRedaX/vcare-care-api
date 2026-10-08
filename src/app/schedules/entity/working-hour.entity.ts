export class WorkingHour {
    id!: number;
    weekday!: number;
    /** `HH:mm` (the pg `TIME` text sliced; `24:00` round-trips). */
    startTime!: string;
    endTime!: string;

    constructor(data: Partial<WorkingHour>) {
        Object.assign(this, data);
    }
}
