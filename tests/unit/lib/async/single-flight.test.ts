import { createSingleFlight } from "../../../../src/lib/async/single-flight";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
    it("should run the work once when concurrent callers share a key", async () => {
        const flight = createSingleFlight<number, string>();
        const gate = deferred<string>();
        const start = jest.fn(() => gate.promise);
        const first = flight.run(1, start);
        const second = flight.run(1, start);
        expect(start).toHaveBeenCalledTimes(1);
        expect(flight.size()).toBe(1);
        gate.resolve("done");
        await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);
        expect(flight.size()).toBe(0);
    });

    it("should run independent work when the keys differ", async () => {
        const flight = createSingleFlight<number, number>();
        const start = jest.fn((value: number) => Promise.resolve(value));
        await expect(Promise.all([flight.run(1, () => start(1)), flight.run(2, () => start(2))])).resolves.toEqual([1, 2]);
        expect(start).toHaveBeenCalledTimes(2);
    });

    it("should start fresh work after the previous promise settled", async () => {
        const flight = createSingleFlight<string, number>();
        const start = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
        await expect(flight.run("a", start)).resolves.toBe(1);
        await expect(flight.run("a", start)).resolves.toBe(2);
        expect(start).toHaveBeenCalledTimes(2);
    });

    it("should reject every waiter and release the key when the work fails", async () => {
        const flight = createSingleFlight<number, string>();
        const gate = deferred<string>();
        const first = flight.run(7, () => gate.promise);
        const second = flight.run(7, () => Promise.resolve("never"));
        gate.reject(new Error("boom"));
        await expect(first).rejects.toThrow("boom");
        await expect(second).rejects.toThrow("boom");
        expect(flight.size()).toBe(0);
        await expect(flight.run(7, () => Promise.resolve("again"))).resolves.toBe("again");
    });

    it("should keep the first adopted promise when a key is already in flight", async () => {
        const flight = createSingleFlight<number, string>();
        const gate = deferred<string>();
        const winner = flight.adopt(3, gate.promise);
        const loser = flight.adopt(3, Promise.resolve("late"));
        gate.resolve("first");
        await expect(winner).resolves.toBe("first");
        await expect(loser).resolves.toBe("first");
    });
});
