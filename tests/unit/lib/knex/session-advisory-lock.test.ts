import type { Knex } from "knex";
import { withSessionAdvisoryLock } from "../../../../src/lib/knex/session-advisory-lock";

interface FakeDb {
    db: Knex;
    acquire: jest.Mock;
    release: jest.Mock;
    statements: string[];
}

function fakeDb(poolMax: number | undefined, options: { acquired?: boolean; unlockFails?: boolean; acquireError?: Error } = {}): FakeDb {
    const statements: string[] = [];
    let connections = 0;
    const acquire = jest.fn(() => {
        if (options.acquireError) return Promise.reject(options.acquireError);
        connections += 1;
        return Promise.resolve({ connection: connections });
    });
    const release = jest.fn().mockResolvedValue(undefined);
    const raw = jest.fn((sql: string) => ({
        connection: jest.fn(() => {
            statements.push(sql.includes("pg_advisory_unlock") ? "unlock" : "lock");
            if (sql.includes("pg_advisory_unlock") && options.unlockFails) return Promise.reject(new Error("synthetic unlock failure"));
            return Promise.resolve({ rows: [{ acquired: options.acquired ?? true }] });
        }),
    }));
    const config = poolMax === undefined ? {} : { pool: { max: poolMax } };
    const db = { client: { acquireConnection: acquire, releaseConnection: release, config }, raw } as unknown as Knex;
    return { db, acquire, release, statements };
}

function gate(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { promise, open };
}

describe("withSessionAdvisoryLock", () => {
    it("should run the work on a pinned connection and unlock before releasing it", async () => {
        const { db, acquire, release, statements } = fakeDb(4);
        await expect(withSessionAdvisoryLock(db, 1102, 7, () => Promise.resolve("done"))).resolves.toBe("done");
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(statements).toEqual(["lock", "unlock"]);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("should cap pinned connections at pool max minus one so short transactions keep a connection", async () => {
        const { db, acquire } = fakeDb(3);
        const hold = gate();
        const started = gate();
        let running = 0;
        const work = async () => { running += 1; if (running === 2) started.open(); await hold.promise; return "ran"; };
        const first = withSessionAdvisoryLock(db, 1101, 1, work);
        const second = withSessionAdvisoryLock(db, 1101, 2, work);
        await started.promise;
        // Both permitted pins are in use: a third caller backs off without touching the pool.
        await expect(withSessionAdvisoryLock(db, 1101, 3, () => Promise.resolve("never"))).resolves.toBeUndefined();
        expect(acquire).toHaveBeenCalledTimes(2);
        hold.open();
        await expect(Promise.all([first, second])).resolves.toEqual(["ran", "ran"]);
        await expect(withSessionAdvisoryLock(db, 1101, 4, () => Promise.resolve("again"))).resolves.toBe("again");
    });

    it("should leave the only spare connection alone on a two-connection pool", async () => {
        const { db, acquire } = fakeDb(2);
        const hold = gate();
        const started = gate();
        const first = withSessionAdvisoryLock(db, 1102, 1, async () => { started.open(); await hold.promise; return 1; });
        await started.promise;
        await expect(withSessionAdvisoryLock(db, 1102, 2, () => Promise.resolve(2))).resolves.toBeUndefined();
        expect(acquire).toHaveBeenCalledTimes(1);
        hold.open();
        await first;
    });

    it("should never pin when the pool has a single connection", async () => {
        const { db, acquire } = fakeDb(1);
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("never"))).resolves.toBeUndefined();
        expect(acquire).not.toHaveBeenCalled();
    });

    it("should assume a pool of two when the config carries no max", async () => {
        const { db } = fakeDb(undefined);
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("ok"))).resolves.toBe("ok");
    });

    it("should return undefined and free the slot when acquiring a connection times out", async () => {
        const timeout = Object.assign(new Error("Knex: Timeout acquiring a connection"), { name: "KnexTimeoutError" });
        const { db, release } = fakeDb(2, { acquireError: timeout });
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("never"))).resolves.toBeUndefined();
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("never"))).resolves.toBeUndefined();
        expect(release).not.toHaveBeenCalled();
    });

    it("should rethrow any other acquire failure and free the slot", async () => {
        const { db } = fakeDb(2, { acquireError: new Error("synthetic pool failure") });
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("never"))).rejects.toThrow("synthetic pool failure");
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("never"))).rejects.toThrow("synthetic pool failure");
    });

    it("should release the connection without unlocking when another session holds the lock", async () => {
        const { db, release, statements } = fakeDb(4, { acquired: false });
        const work = jest.fn();
        await expect(withSessionAdvisoryLock(db, 1102, 1, work)).resolves.toBeUndefined();
        expect(work).not.toHaveBeenCalled();
        expect(statements).toEqual(["lock"]);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("should unlock, release and rethrow when the work throws, and free the slot", async () => {
        const { db, release, statements } = fakeDb(2);
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.reject(new Error("synthetic work failure")))).rejects.toThrow("synthetic work failure");
        expect(statements).toEqual(["lock", "unlock"]);
        expect(release).toHaveBeenCalledTimes(1);
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("after"))).resolves.toBe("after");
    });

    it("should still release the connection when the unlock itself fails", async () => {
        const { db, release } = fakeDb(2, { unlockFails: true });
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("ok"))).rejects.toThrow("synthetic unlock failure");
        expect(release).toHaveBeenCalledTimes(1);
        await expect(withSessionAdvisoryLock(db, 1102, 1, () => Promise.resolve("ok"))).rejects.toThrow("synthetic unlock failure");
    });
});
