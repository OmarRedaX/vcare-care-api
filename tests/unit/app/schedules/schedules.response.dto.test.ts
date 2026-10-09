import { ConsultationTypeResponseDto, ScheduleExceptionResponseDto, WorkingHoursResponseDto } from "../../../../src/app/schedules/dto/schedules.response.dto";
import { ConsultationType } from "../../../../src/app/schedules/entity/consultation-type.entity";
import { ScheduleException } from "../../../../src/app/schedules/entity/schedule-exception.entity";
import { inlineLists, schemaBlock } from "../../../helpers/contract";

const required = (schema: string): string[] => inlineLists(schemaBlock(schema), "required")[0] ?? [];

describe("schedules response DTOs", () => {
    it("should produce exactly the contract required keys for WorkingHours and WorkingHoursDay", () => {
        const dto = WorkingHoursResponseDto.from({ timezone: "Africa/Cairo", days: [{ weekday: 1, intervals: [{ startTime: "09:00", endTime: "24:00" }] }] });
        expect(Object.keys(dto).sort()).toEqual([...required("WorkingHours")].sort());
        expect(Object.keys(dto.days[0]!).sort()).toEqual([...required("WorkingHoursDay")].sort());
        expect(Object.keys(dto.days[0]!.intervals[0]!).sort()).toEqual(["endTime", "startTime"]);
    });

    it("should produce exactly the contract required keys for ScheduleException, with nulls for a day_off", () => {
        const dto = ScheduleExceptionResponseDto.from(new ScheduleException({
            id: 4, date: "2027-05-01", type: "day_off" as never, startTime: null, endTime: null, reason: null, createdAt: new Date("2027-01-01T10:00:00.123Z"),
        }));
        expect(Object.keys(dto).sort()).toEqual([...required("ScheduleException")].sort());
        expect(dto).toEqual({ id: 4, date: "2027-05-01", type: "day_off", startTime: null, endTime: null, reason: null, createdAt: "2027-01-01T10:00:00.123Z" });
    });

    it("should produce exactly the contract required keys for ConsultationType and render both timestamps with toISOString", () => {
        const dto = ConsultationTypeResponseDto.from(new ConsultationType({
            id: 9, name: "Synthetic Visit 001", durationMinutes: 30, price: 15000, currency: "EGP", isActive: true,
            createdAt: new Date("2027-01-01T10:00:00Z"), updatedAt: new Date("2027-01-02T11:30:00.500Z"),
        }));
        expect(Object.keys(dto).sort()).toEqual([...required("ConsultationType")].sort());
        expect(dto.createdAt).toBe("2027-01-01T10:00:00.000Z");
        expect(dto.updatedAt).toBe("2027-01-02T11:30:00.500Z");
    });

    it("should never expose doctor_profile_id, deleted_at or row-shaped members even when the entity carries extras", () => {
        const leaky = new ConsultationType({ id: 1, name: "Synthetic", durationMinutes: 5, price: 0, currency: "EGP", isActive: false, createdAt: new Date(0), updatedAt: new Date(0) });
        Object.assign(leaky, { doctor_profile_id: 7, doctorProfileId: 7, deleted_at: null, deletedAt: null });
        const exception = new ScheduleException({ id: 1, date: "2027-05-01", type: "day_off" as never, startTime: null, endTime: null, reason: null, createdAt: new Date(0) });
        Object.assign(exception, { doctor_profile_id: 7, doctorProfileId: 7, deleted_at: null, deletedAt: null });
        const text = JSON.stringify([ConsultationTypeResponseDto.from(leaky), ScheduleExceptionResponseDto.from(exception)]);
        expect(text).not.toMatch(/doctor_?[pP]rofile_?[iI]d|deleted_?[aA]t/);
    });

    it("should copy the view rather than alias it", () => {
        const view = { timezone: "UTC", days: [{ weekday: 2, intervals: [{ startTime: "10:00", endTime: "11:00" }] }] };
        const dto = WorkingHoursResponseDto.from(view);
        expect(dto.days).not.toBe(view.days);
        expect(dto.days[0]!.intervals[0]).not.toBe(view.days[0]!.intervals[0]);
    });
});
