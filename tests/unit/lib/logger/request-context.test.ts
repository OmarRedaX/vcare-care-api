import { currentRequestId, requestContext } from "../../../../src/lib/logger/request-context";

describe("lib/logger/request-context", () => {
    it("should return the request id inside requestContext.run across awaits and timers", async () => {
        const seen = await requestContext.run({ requestId: "ctx-rid" }, async () => {
            const values: Array<string | undefined> = [currentRequestId()];
            await Promise.resolve();
            values.push(currentRequestId());
            await new Promise<void>((resolve) =>
                setTimeout(() => {
                    values.push(currentRequestId());
                    resolve();
                }, 1),
            );
            await new Promise<void>((resolve) =>
                setImmediate(() => {
                    values.push(currentRequestId());
                    resolve();
                }),
            );
            return values;
        });

        expect(seen).toEqual(["ctx-rid", "ctx-rid", "ctx-rid", "ctx-rid"]);
    });

    it("should keep concurrent requests isolated when two contexts interleave", async () => {
        const run = (id: string, waitMs: number) =>
            requestContext.run({ requestId: id }, async () => {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                return currentRequestId();
            });
        await expect(Promise.all([run("a", 5), run("b", 1)])).resolves.toEqual(["a", "b"]);
    });

    it("should return undefined outside any request", () => {
        expect(currentRequestId()).toBeUndefined();
    });
});
