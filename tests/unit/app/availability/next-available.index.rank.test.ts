// Rules covered: AV-R18 (miss = absent member), AV-R19/AV-R20 (fail-soft Redis), AV-R23/AV-R24 (refresh set, sweep stamp), spec 12.2.3 (guarded write).
import type Redis from "ioredis";
import { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import { WRITE_NEXT_AVAILABLE_LUA } from "../../../../src/app/availability/lua";
import type { ComputedEntry } from "../../../../src/app/availability/types";
import type { Env } from "../../../../src/lib/config/types";
import type { Logger } from "../../../../src/lib/logger/logger";
import { FREE_MAP_BYTES, FREE_MAP_VERSION } from "../../../../src/pkg/slots/free-map";

interface FakeClient {
    status: string;
    zmscore: jest.Mock; mgetBuffer: jest.Mock; mget: jest.Mock; zrange: jest.Mock; spop: jest.Mock; sadd: jest.Mock; scard: jest.Mock;
    set: jest.Mock; get: jest.Mock; defineCommand: jest.Mock; pipeline: jest.Mock; multi: jest.Mock;
}

function setup() {
    const pipelineCalls: unknown[][] = [];
    const pipeline: { writeNextAvailable: jest.Mock; exec: jest.Mock } = { writeNextAvailable: jest.fn(), exec: jest.fn() };
    pipeline.writeNextAvailable.mockImplementation((...args: unknown[]) => { pipelineCalls.push(args); return pipeline; });
    const multi = { zrem: jest.fn(), del: jest.fn(), exec: jest.fn().mockResolvedValue([]) };
    multi.zrem.mockReturnValue(multi); multi.del.mockReturnValue(multi);
    const client: FakeClient = {
        status: "ready", zmscore: jest.fn(), mgetBuffer: jest.fn(), mget: jest.fn(), zrange: jest.fn(), spop: jest.fn(), sadd: jest.fn(), scard: jest.fn(),
        set: jest.fn(), get: jest.fn(), defineCommand: jest.fn(), pipeline: jest.fn().mockReturnValue(pipeline), multi: jest.fn().mockReturnValue(multi),
    };
    const warn = jest.fn();
    const index = new NextAvailableIndex(client as unknown as Redis, { warn } as unknown as Logger, { SLOT_CACHE_TTL_SECONDS: 60 } as Env);
    return { client, pipeline, pipelineCalls, multi, warn, index };
}

const validMap = (): Buffer => { const map = Buffer.alloc(FREE_MAP_BYTES); map[0] = FREE_MAP_VERSION; return map; };
const entry = (userId: number, ver: string | null = "3"): ComputedEntry => ({ userId, score: 1_800_000_000_000 + userId, map: new Uint8Array(validMap()), ver });

describe("NextAvailableIndex rank index reads", () => {
    it("should read every score with one ZMSCORE and map absent members to null", async () => {
        const { client, index } = setup();
        client.zmscore.mockResolvedValue(["1800000000000", null, "1000000000000000"]);
        const scores = await index.scores([7, 8, 9]);
        expect(client.zmscore).toHaveBeenCalledTimes(1);
        expect(client.zmscore).toHaveBeenCalledWith("next-available:index", ["7", "8", "9"]);
        expect([...scores!]).toEqual([[7, 1_800_000_000_000], [8, null], [9, 1e15]]);
    });

    it("should not call Redis for an empty id list", async () => {
        const { client, index } = setup();
        expect(await index.scores([])).toEqual(new Map());
        expect(client.zmscore).not.toHaveBeenCalled();
    });

    it("should return undefined when Redis is unusable or the command fails, without throwing", async () => {
        const unusable = setup();
        unusable.client.status = "wait";
        expect(await unusable.index.scores([1])).toBeUndefined();
        expect(unusable.client.zmscore).not.toHaveBeenCalled();
        const failing = setup();
        failing.client.zmscore.mockRejectedValue(new Error("boom"));
        expect(await failing.index.scores([1])).toBeUndefined();
    });

    it("should read free-maps in chunks of 500, mapping a missing value to null and an invalid layout to null with a log", async () => {
        const { client, index, warn } = setup();
        const ids = Array.from({ length: 1200 }, (_, position) => position + 1);
        client.mgetBuffer.mockImplementation((keys: string[]) => Promise.resolve(keys.map((key) => key === "free-map:2" ? Buffer.from([1, 2, 3]) : key === "free-map:3" ? null : validMap())));
        const maps = await index.maps(ids);
        expect(client.mgetBuffer).toHaveBeenCalledTimes(3);
        expect((client.mgetBuffer.mock.calls[0]?.[0] as string[])).toHaveLength(500);
        expect(client.mgetBuffer.mock.calls[0]?.[0]).toContain("free-map:1");
        expect(maps!.get(1)).toBeInstanceOf(Uint8Array);
        expect(maps!.get(2)).toBeNull();
        expect(maps!.get(3)).toBeNull();
        expect(maps!.size).toBe(1200);
        expect(warn).toHaveBeenCalledWith("availability_freemap_invalid");
    });

    it("should treat a wrong map version as invalid", async () => {
        const { client, index } = setup();
        const wrong = validMap(); wrong[0] = 9;
        client.mgetBuffer.mockResolvedValue([wrong]);
        expect((await index.maps([5]))!.get(5)).toBeNull();
    });

    it("should snapshot slots-ver for the given doctors with zero for an absent key", async () => {
        const { client, index } = setup();
        client.mget.mockResolvedValue(["4", null]);
        expect([...(await index.versions([1, 2]))!]).toEqual([[1, "4"], [2, "0"]]);
        expect(client.mget).toHaveBeenCalledWith(["slots-ver:1", "slots-ver:2"]);
        client.mget.mockRejectedValue(new Error("down"));
        expect(await index.versions([1])).toBeUndefined();
    });
});

describe("NextAvailableIndex guarded write (spec 12.2.3)", () => {
    it("should define the guarded command once with three keys and a Lua script that compares slots-ver before writing", async () => {
        const { client, pipeline, index } = setup();
        pipeline.exec.mockResolvedValue([[null, 1]]);
        await index.writeEntries([entry(1)]);
        await index.writeEntries([entry(2)]);
        expect(client.defineCommand).toHaveBeenCalledTimes(1);
        expect(client.defineCommand).toHaveBeenCalledWith("writeNextAvailable", { numberOfKeys: 3, lua: WRITE_NEXT_AVAILABLE_LUA });
        expect(WRITE_NEXT_AVAILABLE_LUA).toContain("if v ~= ARGV[1] then return 0 end");
        expect(WRITE_NEXT_AVAILABLE_LUA.indexOf("return 0")).toBeLessThan(WRITE_NEXT_AVAILABLE_LUA.indexOf("ZADD"));
    });

    it("should send one pipelined command per entry with the version snapshot, member, score, map bytes and a 600 s TTL", async () => {
        const { pipeline, pipelineCalls, index } = setup();
        pipeline.exec.mockResolvedValue([[null, 1], [null, 1]]);
        await index.writeEntries([entry(11, "5"), entry(12, "6")]);
        expect(pipeline.exec).toHaveBeenCalledTimes(1);
        expect(pipelineCalls).toHaveLength(2);
        const first = pipelineCalls[0] ?? [];
        expect(first.slice(0, 7)).toEqual(["slots-ver:11", "next-available:index", "free-map:11", "5", "11", String(1_800_000_000_011), expect.any(Buffer)]);
        expect(first[6]).toHaveLength(FREE_MAP_BYTES);
        expect(first[7]).toBe(600);
    });

    it("should report stored, rejected and failed verdicts in input order", async () => {
        const { pipeline, index } = setup();
        pipeline.exec.mockResolvedValue([[null, 1], [null, 0], [new Error("WRONGTYPE"), null]]);
        expect(await index.writeEntries([entry(1), entry(2), entry(3)])).toEqual(["stored", "rejected", "failed"]);
    });

    it("should return undefined when the pipeline fails or Redis is unusable", async () => {
        const failing = setup();
        failing.pipeline.exec.mockRejectedValue(new Error("down"));
        expect(await failing.index.writeEntries([entry(1)])).toBeUndefined();
        const unusable = setup();
        unusable.client.status = "wait";
        expect(await unusable.index.writeEntries([entry(1)])).toBeUndefined();
        expect(await setup().index.writeEntries([])).toEqual([]);
    });
});

describe("NextAvailableIndex maintenance operations (AV-R23, AV-R24)", () => {
    it("should remove stale members and their free-maps in chunks of 500", async () => {
        const { multi, index } = setup();
        expect(await index.remove(Array.from({ length: 501 }, (_, position) => position + 1))).toBe(true);
        expect(multi.exec).toHaveBeenCalledTimes(2);
        expect(multi.zrem.mock.calls[0]).toHaveLength(501);
        expect(multi.zrem.mock.calls[0]?.[0]).toBe("next-available:index");
        expect(multi.del.mock.calls[0]?.[0]).toBe("free-map:1");
        multi.exec.mockRejectedValue(new Error("down"));
        expect(await index.remove([1])).toBe(false);
    });

    it("should list the members as numbers and ignore garbage", async () => {
        const { client, index } = setup();
        client.zrange.mockResolvedValue(["3", "x", "9"]);
        expect(await index.members()).toEqual([3, 9]);
        expect(client.zrange).toHaveBeenCalledWith("next-available:index", 0, -1);
    });

    it("should pop up to the requested count from the refresh set and return numbers", async () => {
        const { client, index } = setup();
        client.spop.mockResolvedValue(["5", "6"]);
        expect(await index.popRefresh(50)).toEqual([5, 6]);
        expect(client.spop).toHaveBeenCalledWith("next-available:refresh", 50);
        client.spop.mockRejectedValue(new Error("down"));
        expect(await index.popRefresh(50)).toBeUndefined();
    });

    it("should requeue ids, skipping the call for an empty list and reporting a Redis failure", async () => {
        const { client, index } = setup();
        client.sadd.mockResolvedValue(2);
        expect(await index.requeue([])).toBe(true);
        expect(client.sadd).not.toHaveBeenCalled();
        expect(await index.requeue([5, 6])).toBe(true);
        expect(client.sadd).toHaveBeenCalledWith("next-available:refresh", ["5", "6"]);
        client.sadd.mockRejectedValue(new Error("down"));
        expect(await index.requeue([5])).toBe(false);
    });

    it("should stamp the sweep without a TTL and read it back, null when never stamped", async () => {
        const { client, index } = setup();
        client.set.mockResolvedValue("OK");
        expect(await index.markSwept(1_800_000_000_000)).toBe(true);
        expect(client.set).toHaveBeenCalledWith("next-available:swept-at", "1800000000000");
        client.get.mockResolvedValueOnce("1800000000000").mockResolvedValueOnce(null);
        expect(await index.readSweptAt()).toBe(1_800_000_000_000);
        expect(await index.readSweptAt()).toBeNull();
        client.get.mockRejectedValue(new Error("down"));
        expect(await index.readSweptAt()).toBeUndefined();
    });

    it("should expose the refresh queue depth", async () => {
        const { client, index } = setup();
        client.scard.mockResolvedValue(12);
        expect(await index.refreshDepth()).toBe(12);
    });

    it("should report usability from the client status", () => {
        const { client, index } = setup();
        expect(index.isUsable()).toBe(true);
        client.status = "reconnecting";
        expect(index.isUsable()).toBe(false);
    });
});
