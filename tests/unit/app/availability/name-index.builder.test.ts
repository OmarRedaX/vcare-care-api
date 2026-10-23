// Rules covered: AV-R28 (hydrate through the Identity client, only active users with a name, degraded keeps the previous build, swap), AV-R29 (counts only in logs).
import { NameIndexBuilder } from "../../../../src/app/availability/service/name-index.builder";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import { NameIndexOutcome } from "../../../../src/app/availability/enums";
import type { IndexDoctor } from "../../../../src/app/doctors/types";
import type { HydratedUser } from "../../../../src/lib/identity-client/types";
import type { Logger } from "../../../../src/lib/logger/logger";

const NUL = String.fromCharCode(0);
const NOW = 1_800_000_000_000;
const SECRET_NAME = "SYNTHETIC  Builder   NAME-5521";
const doctors = (count: number): IndexDoctor[] => Array.from({ length: count }, (_, position) => ({ profileId: position + 1, userId: position + 1001, timezone: "UTC" }));
const user = (displayName: string, status: HydratedUser["status"] = "active"): HydratedUser => ({ displayName, avatarUrl: null, status });

function setup(directory: (userId: number) => HydratedUser | undefined = (userId) => user(`Doctor ${userId}`)) {
    const logged: unknown[][] = [];
    const record = (...args: unknown[]): void => { logged.push(args); };
    const logger = { info: jest.fn(record), warn: jest.fn(record), debug: jest.fn(record), error: jest.fn(record), metric: jest.fn(record) };
    const identity = { getUsersBatch: jest.fn((ids: number[], _requestId: string) => Promise.resolve({
        users: new Map(ids.flatMap((id) => { const found = directory(id); return found === undefined ? [] : [[id, found] as [number, HydratedUser]]; })), degraded: false })) };
    const index = { replaceNameIndex: jest.fn().mockResolvedValue(true) };
    const builder = new NameIndexBuilder(identity, index as unknown as NextAvailableIndex, logger as unknown as Logger, { now: () => NOW });
    return { builder, identity, index, logger, logged };
}
const signal = (): AbortSignal => new AbortController().signal;

describe("NameIndexBuilder.rebuild", () => {
    it("should hydrate in chunks of 100 ids, each call carrying a request id, and swap in one member per active named user", async () => {
        const s = setup();
        expect(await s.builder.rebuild(doctors(250), signal())).toBe(NameIndexOutcome.Built);
        expect(s.identity.getUsersBatch.mock.calls.map((call) => call[0].length)).toEqual([100, 100, 50]);
        expect(s.identity.getUsersBatch.mock.calls.every((call) => call[1].length > 0)).toBe(true);
        const [members, builtAt] = s.index.replaceNameIndex.mock.calls[0] as [string[], number];
        expect(members).toHaveLength(250);
        expect(members[0]).toBe(`doctor 1001${NUL}1001`);
        expect(builtAt).toBe(NOW);
        expect(s.logger.info).toHaveBeenCalledWith("availability_name_index_built", { members: 250 });
    });

    it("should normalise the stored name exactly like the query (NFC, trim, collapse, lower-case)", async () => {
        const s = setup(() => user(`  ${SECRET_NAME}  `));
        await s.builder.rebuild(doctors(1), signal());
        expect(s.index.replaceNameIndex.mock.calls[0]?.[0]).toEqual([`synthetic builder name-5521${NUL}1001`]);
    });

    it("should index only Identity-active users that have a name, skipping unknown, suspended, pending, rejected and blank-named ones", async () => {
        const directoryByUser = new Map<number, HydratedUser | undefined>([
            [1001, user("Active One")], [1002, user("Suspended", "suspended")], [1003, user("Pending", "pending")], [1004, user("Rejected", "rejected")],
            [1005, user("   ")], [1006, undefined], [1007, user("Active Two")],
        ]);
        const s = setup((userId) => directoryByUser.get(userId));
        await s.builder.rebuild(doctors(7), signal());
        expect(s.index.replaceNameIndex.mock.calls[0]?.[0]).toEqual([`active one${NUL}1001`, `active two${NUL}1007`]);
    });

    it("should swap in an empty list (which deletes the index) when no doctor qualifies", async () => {
        const s = setup(() => undefined);
        expect(await s.builder.rebuild(doctors(3), signal())).toBe(NameIndexOutcome.Built);
        expect(s.index.replaceNameIndex).toHaveBeenCalledWith([], NOW);
        expect(s.logger.info).toHaveBeenCalledWith("availability_name_index_built", { members: 0 });
    });

    it("should keep the previous build and log stale when a hydration chunk is degraded, stopping at the first failed chunk", async () => {
        const s = setup();
        s.identity.getUsersBatch.mockResolvedValueOnce({ users: new Map(), degraded: false });
        s.identity.getUsersBatch.mockResolvedValueOnce({ users: new Map(), degraded: true });
        expect(await s.builder.rebuild(doctors(450), signal())).toBe(NameIndexOutcome.Stale);
        expect(s.identity.getUsersBatch).toHaveBeenCalledTimes(2);
        expect(s.index.replaceNameIndex).not.toHaveBeenCalled();
        expect(s.logger.warn).toHaveBeenCalledWith("availability_name_index_stale");
    });

    it("should keep the previous build when aborted before or between chunks", async () => {
        const before = setup();
        const controller = new AbortController();
        controller.abort();
        expect(await before.builder.rebuild(doctors(5), controller.signal)).toBe(NameIndexOutcome.Stale);
        expect(before.identity.getUsersBatch).not.toHaveBeenCalled();
        const between = setup();
        const second = new AbortController();
        between.identity.getUsersBatch.mockImplementation(() => { second.abort(); return Promise.resolve({ users: new Map(), degraded: false }); });
        expect(await between.builder.rebuild(doctors(250), second.signal)).toBe(NameIndexOutcome.Stale);
        expect(between.identity.getUsersBatch).toHaveBeenCalledTimes(1);
        expect(between.index.replaceNameIndex).not.toHaveBeenCalled();
    });

    it("should report failed, without logging a built event, when the swap could not be written", async () => {
        const s = setup();
        s.index.replaceNameIndex.mockResolvedValue(false);
        expect(await s.builder.rebuild(doctors(2), signal())).toBe(NameIndexOutcome.Failed);
        expect(s.logger.info).not.toHaveBeenCalled();
    });

    it("should propagate an unexpected Identity client error to the caller", async () => {
        const s = setup();
        s.identity.getUsersBatch.mockRejectedValue(new Error("unexpected"));
        await expect(s.builder.rebuild(doctors(2), signal())).rejects.toThrow("unexpected");
    });

    it("should never log a display name, only counts (AV-R29)", async () => {
        const s = setup(() => user(SECRET_NAME));
        await s.builder.rebuild(doctors(3), signal());
        s.identity.getUsersBatch.mockResolvedValueOnce({ users: new Map(), degraded: true });
        await s.builder.rebuild(doctors(3), signal());
        const text = JSON.stringify(s.logged);
        expect(text).not.toContain("SYNTHETIC");
        expect(text).not.toContain("synthetic");
        expect(text).not.toContain("5521");
    });
});
