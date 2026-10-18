import "reflect-metadata";
import * as rateLimitModule from "../../../../src/lib/rate-limit/rate-limit";
import { byUser } from "../../../../src/lib/rate-limit/subjects";
import * as constants from "../../../../src/app/records/constants";
import { readLimit, timelineLimit, writeLimit } from "../../../../src/app/records/rate-limits";

afterEach(() => { jest.restoreAllMocks(); });

function optionsOf(factory: () => unknown) {
    const spy = jest.spyOn(rateLimitModule, "rateLimit").mockReturnValue((() => undefined) as never);
    factory();
    return spy.mock.calls[spy.mock.calls.length - 1]?.[0];
}

describe("records rate limits (RC-R20)", () => {
    it("should limit record writes to 20 per minute per user in one shared bucket", () => {
        expect(optionsOf(writeLimit)).toMatchObject({ name: "records-write-user", limit: 20, windowMs: 60_000, subject: byUser });
    });

    it("should limit the read of one record to 120 per minute per user", () => {
        expect(optionsOf(readLimit)).toMatchObject({ name: "records-read-user", limit: 120, windowMs: 60_000, subject: byUser });
    });

    it("should limit the timeline to 60 per minute per user", () => {
        expect(optionsOf(timelineLimit)).toMatchObject({ name: "records-timeline-user", limit: 60, windowMs: 60_000, subject: byUser });
    });

    it("should keep the three buckets distinct and name them as the constants do", () => {
        const names = [optionsOf(writeLimit)?.name, optionsOf(readLimit)?.name, optionsOf(timelineLimit)?.name];
        expect(new Set(names).size).toBe(3);
        expect(names).toEqual([constants.RECORDS_WRITE_RATE_NAME, constants.RECORDS_READ_RATE_NAME, constants.RECORDS_TIMELINE_RATE_NAME]);
    });

    it("should key the limiter by the verified user and skip an unauthenticated request", () => {
        const subject = optionsOf(writeLimit)?.subject;
        expect(subject?.({ auth: { userId: 202 } } as never)).toBe("202");
        expect(subject?.({} as never)).toBeNull();
    });
});
