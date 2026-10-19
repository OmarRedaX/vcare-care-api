import "reflect-metadata";
import * as constants from "../../../../src/app/record-attachments/constants";
import { intentLimit, readLimit, writeLimit } from "../../../../src/app/record-attachments/rate-limits";
import * as rateLimitModule from "../../../../src/lib/rate-limit/rate-limit";
import { byUser } from "../../../../src/lib/rate-limit/subjects";
import { contractOperationBlock } from "../../../helpers/contract";

afterEach(() => { jest.restoreAllMocks(); });

function optionsOf(factory: () => unknown) {
    const spy = jest.spyOn(rateLimitModule, "rateLimit").mockReturnValue((() => undefined) as never);
    factory();
    return spy.mock.calls[spy.mock.calls.length - 1]?.[0];
}

describe("record-attachments rate limits (RA-R14)", () => {
    it("should limit intents to 20 per hour per user", () => {
        expect(optionsOf(intentLimit)).toMatchObject({ name: "record-attachments-intent-user", limit: 20, windowMs: 3_600_000, subject: byUser });
    });

    it("should limit complete and delete to 20 per minute per user in one shared bucket", () => {
        expect(optionsOf(writeLimit)).toMatchObject({ name: "record-attachments-write-user", limit: 20, windowMs: 60_000, subject: byUser });
    });

    it("should limit download-url to 120 per minute per user", () => {
        expect(optionsOf(readLimit)).toMatchObject({ name: "record-attachments-read-user", limit: 120, windowMs: 60_000, subject: byUser });
    });

    it("should keep the three buckets distinct, named as the constants do, and apart from the verification intent bucket", () => {
        const names = [optionsOf(intentLimit)?.name, optionsOf(writeLimit)?.name, optionsOf(readLimit)?.name];
        expect(new Set(names).size).toBe(3);
        expect(names).toEqual([constants.RECORD_ATTACHMENTS_INTENT_RATE_NAME, constants.RECORD_ATTACHMENTS_WRITE_RATE_NAME, constants.RECORD_ATTACHMENTS_READ_RATE_NAME]);
        for (const name of names) expect(name).not.toMatch(/verification/);
    });

    it("should key the limiter by the verified user and skip an unauthenticated request", () => {
        const subject = optionsOf(writeLimit)?.subject;
        expect(subject?.({ auth: { userId: 202 } } as never)).toBe("202");
        expect(subject?.({} as never)).toBeNull();
    });

    it("should state the limits the limiters enforce in the contract", () => {
        const flat = (apiPath: string, method: "post" | "delete") => contractOperationBlock(apiPath, method).replace(/\s+/g, " ");
        expect(flat("/api/records/{id}/attachments/uploads", "post")).toContain(`Rate limit ${constants.RECORD_ATTACHMENTS_INTENT_USER_LIMIT} attachment uploads/hour per user`);
        expect(flat("/api/records/{id}/attachments/uploads/{uploadId}/complete", "post")).toContain(`Rate limit ${constants.RECORD_ATTACHMENTS_WRITE_USER_LIMIT} attachment writes/min per user`);
        expect(flat("/api/records/{id}/attachments/{attachmentId}", "delete")).toContain(`Rate limit ${constants.RECORD_ATTACHMENTS_WRITE_USER_LIMIT} attachment writes/min per user`);
        expect(flat("/api/records/{id}/attachments/{attachmentId}/download-url", "post")).toContain(`Rate limit ${constants.RECORD_ATTACHMENTS_READ_USER_LIMIT} attachment reads/min per user`);
    });
});
