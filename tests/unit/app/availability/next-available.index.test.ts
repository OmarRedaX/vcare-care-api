import type Redis from "ioredis";
import { AvailabilityChangeListener } from "../../../../src/app/availability/service/availability-change.listener";
import { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { Env } from "../../../../src/lib/config/types";
import type { Logger } from "../../../../src/lib/logger/logger";

describe("NextAvailableIndex slots cache and listeners (AV-R9, AV-R10)", () => {
    function setup() {
        const chain = { incr: jest.fn(), expire: jest.fn(), zrem: jest.fn(), del: jest.fn(), sadd: jest.fn(), exec: jest.fn().mockResolvedValue([[null, 1]]) };
        chain.incr.mockReturnValue(chain); chain.expire.mockReturnValue(chain); chain.zrem.mockReturnValue(chain);
        chain.del.mockReturnValue(chain); chain.sadd.mockReturnValue(chain);
        const client = { status: "ready", get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue("OK"), multi: jest.fn().mockReturnValue(chain) } as unknown as Redis;
        const warn = jest.fn();
        const index = new NextAvailableIndex(client, { warn } as unknown as Logger, { SLOT_CACHE_TTL_SECONDS: 60 } as Env);
        return { client, chain, warn, index };
    }

    it("should use version zero, versioned keys and a 60 second expiry", async () => {
        const { client, index } = setup();
        expect(await index.version(202)).toEqual({ version: "0", usable: true });
        expect(await index.readSlots(202, "0", 9, "2027-01-01", "2027-01-02")).toBeUndefined();
        await index.writeSlots(202, "0", 9, "2027-01-01", "2027-01-02", [{ startMs: 1, endMs: 2 }]);
        expect((client as unknown as { set: jest.Mock }).set).toHaveBeenCalledWith("slots:202:0:9:2027-01-01:2027-01-02", "[[1,2]]", "EX", 60);
    });

    it("should send all four invalidation operations in one transaction", async () => {
        const { index, chain } = setup();
        const listener = new AvailabilityChangeListener(index);
        await listener.onScheduleChanged({ doctorProfileId: 4, doctorUserId: 202, kind: "working_hours" as never });
        expect(chain.incr).toHaveBeenCalledWith("slots-ver:202");
        expect(chain.expire).toHaveBeenCalledWith("slots-ver:202", 604800);
        expect(chain.zrem).toHaveBeenCalledWith("next-available:index", "202");
        expect(chain.del).toHaveBeenCalledWith("free-map:202");
        expect(chain.sadd).toHaveBeenCalledWith("next-available:refresh", "202");
        expect(chain.exec).toHaveBeenCalledTimes(1);
        await listener.onConsultationChanged({ doctorUserId: 202, consultationId: 5, kind: "booked" as never });
        await listener.onDoctorChanged({ doctorUserId: 202, kind: "timezone_changed" as never });
        expect(chain.exec).toHaveBeenCalledTimes(3);
    });

    it("should swallow Redis failure and log once", async () => {
        const { client, warn, index } = setup();
        (client as unknown as { status: string }).status = "wait";
        await index.invalidate(202); await index.invalidate(202);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith("availability_listener_skipped");
    });
});
