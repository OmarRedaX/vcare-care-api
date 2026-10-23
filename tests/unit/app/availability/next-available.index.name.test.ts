// Rules covered: AV-R27 (prefix read, missing index = unavailable), AV-R28 (build in a side key, atomic swap, TTL, stamp), AV-R12/AV-R20 (fail-soft Redis).
import type Redis from "ioredis";
import { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { Env } from "../../../../src/lib/config/types";
import type { Logger } from "../../../../src/lib/logger/logger";

const NUL = String.fromCharCode(0);

function setup() {
    const calls: unknown[][] = [];
    const record = (name: string) => jest.fn((...args: unknown[]) => { calls.push([name, ...args]); return chain; });
    const chain: Record<"exists" | "zrangebylex" | "rename" | "expire" | "set" | "del" | "exec", jest.Mock> = {
        exists: record("exists"), zrangebylex: record("zrangebylex"), rename: record("rename"), expire: record("expire"), set: record("set"), del: record("del"),
        exec: jest.fn().mockResolvedValue([]),
    };
    const client = {
        status: "ready",
        multi: jest.fn(() => chain),
        del: jest.fn().mockResolvedValue(1), zadd: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1), get: jest.fn(),
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
        expect(calls).toContainEqual(["zrangebylex", "name-index", "[ann", "[ann\u{10FFFF}", "LIMIT", 0, 5000]);
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
    it("should build in the side key in chunks of 500 with score 0, give it a TTL, then swap with RENAME, EXPIRE 900 and the stamp in one MULTI", async () => {
        const { client, chain, calls, index } = setup();
        chain.exec.mockResolvedValue([[null, "OK"], [null, 1], [null, "OK"]]);
        const members = Array.from({ length: 1200 }, (_, position) => `name${position}${NUL}${position + 1}`);
        expect(await index.replaceNameIndex(members, 1_800_000_000_000)).toBe(true);
        expect(client.del).toHaveBeenCalledWith("name-index:building");
        expect(client.zadd).toHaveBeenCalledTimes(3);
        const firstChunk = client.zadd.mock.calls[0] as unknown[];
        expect(firstChunk.slice(0, 3)).toEqual(["name-index:building", 0, `name0${NUL}1`]);
        expect(firstChunk).toHaveLength(1 + 500 * 2);
        expect((client.zadd.mock.calls[2] as unknown[])).toHaveLength(1 + 200 * 2);
        expect(client.expire).toHaveBeenCalledWith("name-index:building", 600);
        expect(client.zadd.mock.invocationCallOrder[2]).toBeLessThan(client.expire.mock.invocationCallOrder[0] ?? 0);
        expect(client.multi).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([
            ["rename", "name-index:building", "name-index"],
            ["expire", "name-index", 900],
            ["set", "name-index:built-at", "1800000000000", "EX", 900],
        ]);
    });

    it("should delete the index and stamp the build when the member list is empty", async () => {
        const { client, calls, chain, index } = setup();
        chain.exec.mockResolvedValue([[null, 1], [null, 1], [null, "OK"]]);
        expect(await index.replaceNameIndex([], 5)).toBe(true);
        expect(client.zadd).not.toHaveBeenCalled();
        expect(calls).toEqual([
            ["del", "name-index:building"],
            ["del", "name-index"],
            ["set", "name-index:built-at", "5", "EX", 900],
        ]);
    });

    it("should return false without throwing when Redis is unusable, a write fails or the swap reports an error", async () => {
        const unusable = setup();
        unusable.client.status = "wait";
        expect(await unusable.index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        const failing = setup();
        failing.client.zadd.mockRejectedValue(new Error("boom"));
        expect(await failing.index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        expect(failing.chain.exec).not.toHaveBeenCalled();
        const swapError = setup();
        swapError.chain.exec.mockResolvedValue([[new Error("ERR no such key"), null], [null, 0], [null, "OK"]]);
        expect(await swapError.index.replaceNameIndex([`a${NUL}1`], 1)).toBe(false);
        expect(swapError.warn).toHaveBeenCalledWith("availability_cache_unavailable");
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
