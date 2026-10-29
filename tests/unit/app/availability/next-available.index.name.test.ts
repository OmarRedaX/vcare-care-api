// Rules covered: AV-R27 (prefix read, missing index = unavailable), AV-R28 (build in a side key, atomic swap, TTL, stamp), AV-R12/AV-R20 (fail-soft Redis).
import type Redis from "ioredis";
import { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { Env } from "../../../../src/lib/config/types";
import type { Logger } from "../../../../src/lib/logger/logger";

const NUL = String.fromCharCode(0);

function setup() {
    const calls: unknown[][] = [];
    const record = (name: string) => jest.fn((...args: unknown[]) => { calls.push([name, ...args]); return chain; });
    const chain: Record<"exists" | "zrangebylex" | "zadd" | "expire" | "set" | "del" | "exec", jest.Mock> = {
        exists: record("exists"), zrangebylex: record("zrangebylex"), zadd: record("zadd"), expire: record("expire"), set: record("set"), del: record("del"),
        exec: jest.fn().mockResolvedValue([]),
    };
    const client = {
        status: "ready",
        multi: jest.fn(() => chain),
        del: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1), rename: jest.fn().mockResolvedValue("OK"),
        set: jest.fn().mockResolvedValue("OK"), get: jest.fn(),
    };
    const warn = jest.fn();
    const index = new NextAvailableIndex(client as unknown as Redis, { warn } as unknown as Logger, { SLOT_CACHE_TTL_SECONDS: 60 } as Env);
    return { client, chain, calls, warn, index };
}

describe("NextAvailableIndex.readNameMatches", () => {
    it("should read the existence and the prefix range in one MULTI and parse the user id after the last NUL", async () => {
        const { chain, index, calls } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, [`ann${NUL}7`, `anna${NUL}12`, `ann${NUL}x${NUL}13`]]]);
        expect(await index.readNameMatches("ann")).toEqual([7, 12, 13]);
        expect(calls).toContainEqual(["exists", "name-index"]);
        expect(calls).toContainEqual(["zrangebylex", "name-index", "[ann", "[ann\u{10FFFF}", "LIMIT", 0, 5001]);
    });

    it("should return every match and not warn when the reply holds exactly the limit", async () => {
        const { chain, index, warn } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, Array.from({ length: 5000 }, (_, position) => `ann${NUL}${position + 1}`)]]);
        const ids = await index.readNameMatches("ann");
        expect(ids).toHaveLength(5000);
        expect(ids?.[4999]).toBe(5000);
        expect(warn).not.toHaveBeenCalled();
    });

    it("should use only the first 5000 and log a count-only warning when the reply reaches the limit plus one", async () => {
        const { chain, index, warn } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, Array.from({ length: 5001 }, (_, position) => `ann${NUL}${position + 1}`)]]);
        const ids = await index.readNameMatches("ann");
        expect(ids).toHaveLength(5000);
        expect(ids).not.toContain(5001);
        expect(warn).toHaveBeenCalledWith("availability_name_index_truncated", { limit: 5000 });
        expect(JSON.stringify(warn.mock.calls)).not.toContain("ann");
    });

    it("should return an empty list, not undefined, when the index exists and nothing matches", async () => {
        const { chain, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, []]]);
        expect(await index.readNameMatches("zz")).toEqual([]);
    });

    it("should return undefined when the index key is absent (never built, expired, or built empty)", async () => {
        const { chain, index } = setup();
        chain.exec.mockResolvedValue([[null, 0], [null, []]]);
        expect(await index.readNameMatches("ann")).toBeUndefined();
    });

    it("should skip members whose id part is not a positive integer", async () => {
        const { chain, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, [`ann${NUL}0`, `ann${NUL}-4`, `ann${NUL}abc`, `ann${NUL}5`, "no-separator"]]]);
        expect(await index.readNameMatches("ann")).toEqual([5]);
    });

    it("should return undefined without throwing when Redis is unusable, the MULTI fails or a command errors", async () => {
        const unusable = setup();
        unusable.client.status = "wait";
        expect(await unusable.index.readNameMatches("ann")).toBeUndefined();
        expect(unusable.client.multi).not.toHaveBeenCalled();
        const failing = setup();
        failing.chain.exec.mockRejectedValue(new Error("boom"));
        expect(await failing.index.readNameMatches("ann")).toBeUndefined();
        const aborted = setup();
        aborted.chain.exec.mockResolvedValue(null);
        expect(await aborted.index.readNameMatches("ann")).toBeUndefined();
        const errored = setup();
        errored.chain.exec.mockResolvedValue([[new Error("WRONGTYPE"), null], [null, []]]);
        expect(await errored.index.readNameMatches("ann")).toBeUndefined();
    });
});

describe("NextAvailableIndex.replaceNameIndex", () => {
    it("should build in the side key in chunks of 500 with score 0 and a TTL on every chunk, then EXPIRE 900, RENAME and stamp in that order", async () => {
        const { client, chain, calls, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, 1]]);
        const members = Array.from({ length: 1200 }, (_, position) => `name${position}${NUL}${position + 1}`);
        expect(await index.replaceNameIndex(members, 1_800_000_000_000)).toBe(true);
        expect(client.del).toHaveBeenCalledWith("name-index:building");
        const adds = calls.filter((call) => call[0] === "zadd");
        expect(adds).toHaveLength(3);
        expect((adds[0] as unknown[]).slice(0, 4)).toEqual(["zadd", "name-index:building", 0, `name0${NUL}1`]);
        expect(adds[0]).toHaveLength(2 + 500 * 2);
        expect(adds[2]).toHaveLength(2 + 200 * 2);
        expect(calls.filter((call) => call[0] === "expire")).toEqual(Array(3).fill(["expire", "name-index:building", 600]));
        expect(client.multi).toHaveBeenCalledTimes(3);
        expect(client.expire).toHaveBeenCalledWith("name-index:building", 900);
        expect(client.rename).toHaveBeenCalledWith("name-index:building", "name-index");
        expect(client.set).toHaveBeenCalledWith("name-index:built-at", "1800000000000", "EX", 900);
        const lastChunkOrder = chain.exec.mock.invocationCallOrder[2] ?? 0;
        expect(lastChunkOrder).toBeLessThan(client.expire.mock.invocationCallOrder[0] ?? 0);
        expect(client.expire.mock.invocationCallOrder[0]).toBeLessThan(client.rename.mock.invocationCallOrder[0] ?? 0);
        expect(client.rename.mock.invocationCallOrder[0]).toBeLessThan(client.set.mock.invocationCallOrder[0] ?? 0);
    });

    it("should delete the index and stamp the build when the member list is empty", async () => {
        const { client, calls, chain, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, 1], [null, "OK"]]);
        expect(await index.replaceNameIndex([], 5)).toBe(true);
        expect(chain.zadd).not.toHaveBeenCalled();
        expect(client.rename).not.toHaveBeenCalled();
        expect(calls).toEqual([
            ["del", "name-index:building"],
            ["del", "name-index"],
            ["set", "name-index:built-at", "5", "EX", 900],
        ]);
    });

    it("should return false without throwing when Redis is unusable", async () => {
        const unusable = setup();
        unusable.client.status = "wait";
        expect(await unusable.index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        expect(unusable.client.multi).not.toHaveBeenCalled();
    });

    it("should leave no building key without a TTL when a middle ZADD chunk fails", async () => {
        const { client, chain, calls, index, warn } = setup();
        chain.exec.mockResolvedValueOnce([[null, 1], [null, 1]]).mockRejectedValueOnce(new Error("boom"));
        const members = Array.from({ length: 1200 }, (_, position) => `name${position}${NUL}${position + 1}`);
        expect(await index.replaceNameIndex(members, 1)).toBe(false);
        expect(calls.filter((call) => call[0] === "zadd")).toHaveLength(2);
        expect(calls.filter((call) => call[0] === "expire")).toEqual(Array(2).fill(["expire", "name-index:building", 600]));
        expect(client.del).toHaveBeenCalledTimes(2);
        expect(client.del).toHaveBeenLastCalledWith("name-index:building");
        expect(client.rename).not.toHaveBeenCalled();
        expect(client.set).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("availability_cache_unavailable");
    });

    it("should delete the building key and report false when a chunk replies with a command error", async () => {
        const { client, chain, index } = setup();
        chain.exec.mockResolvedValue([[new Error("OOM"), null], [null, 0]]);
        expect(await index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        expect(client.del).toHaveBeenLastCalledWith("name-index:building");
        expect(client.rename).not.toHaveBeenCalled();
        expect(client.set).not.toHaveBeenCalled();
    });

    it("should touch neither the live index TTL nor the stamp and return false when RENAME fails", async () => {
        const { client, chain, calls, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, 1]]);
        client.rename.mockRejectedValue(new Error("ERR no such key"));
        expect(await index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        expect(client.set).not.toHaveBeenCalled();
        expect(client.expire.mock.calls).toEqual([["name-index:building", 900]]);
        expect(calls.some((call) => call[0] === "expire" && call[1] === "name-index")).toBe(false);
        expect(client.del).toHaveBeenLastCalledWith("name-index:building");
    });

    it("should return false without renaming or stamping when the building key vanished before the swap", async () => {
        const { client, chain, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, 1]]);
        client.expire.mockResolvedValue(0);
        expect(await index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        expect(client.rename).not.toHaveBeenCalled();
        expect(client.set).not.toHaveBeenCalled();
    });
});

describe("NextAvailableIndex.readNameBuiltAt", () => {
    it("should parse the stamp, return null when absent or malformed and undefined when Redis failed", async () => {
        const present = setup();
        present.client.get.mockResolvedValue("1800000000000");
        expect(await present.index.readNameBuiltAt()).toBe(1_800_000_000_000);
        expect(present.client.get).toHaveBeenCalledWith("name-index:built-at");
        const absent = setup();
        absent.client.get.mockResolvedValue(null);
        expect(await absent.index.readNameBuiltAt()).toBeNull();
        const garbage = setup();
        garbage.client.get.mockResolvedValue("not-a-number");
        expect(await garbage.index.readNameBuiltAt()).toBeNull();
        const failing = setup();
        failing.client.get.mockRejectedValue(new Error("boom"));
        expect(await failing.index.readNameBuiltAt()).toBeUndefined();
    });
});
