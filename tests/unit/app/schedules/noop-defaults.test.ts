import "reflect-metadata";
import { container } from "../../../../src/lib/di/container";
import { TOKENS } from "../../../../src/lib/di/tokens";
import { NoopScheduleChangeListener } from "../../../../src/app/schedules/service/noop-schedule-change-listener";
import { NoopScheduleImpactProvider } from "../../../../src/app/schedules/service/noop-schedule-impact.provider";
import type { ScheduleChangeListener, ScheduleImpactProvider } from "../../../../src/app/schedules/types";

describe("no-op schedule defaults", () => {
    it("should return no affected consultations and never block a write", async () => {
        const provider = new NoopScheduleImpactProvider();
        await expect(provider.findAffected()).resolves.toEqual([]);
        await expect(provider.flagAffected()).resolves.toBeUndefined();
    });

    it("should resolve the listener without side effects", async () => {
        await expect(new NoopScheduleChangeListener().onScheduleChanged()).resolves.toBeUndefined();
    });

    it("should keep the no-op listener in the container while consultations bind the real impact provider", async () => {
        const provider = container.resolve<ScheduleImpactProvider>(TOKENS.ScheduleImpactProvider);
        const listener = container.resolve<ScheduleChangeListener>(TOKENS.ScheduleChangeListener);
        expect(provider).not.toBeInstanceOf(NoopScheduleImpactProvider);
        expect(listener).toBeInstanceOf(NoopScheduleChangeListener);
        await expect(listener.onScheduleChanged({ doctorProfileId: 1, doctorUserId: 202, kind: "working_hours" as never })).resolves.toBeUndefined();
    });
});
