import { yieldToEventLoop } from "../../../../src/lib/async/yield-to-event-loop";

describe("yieldToEventLoop", () => {
    it("should let an already scheduled I/O-phase callback run before the awaiting code continues", async () => {
        const order: string[] = [];
        setImmediate(() => order.push("immediate"));
        await yieldToEventLoop();
        order.push("resumed");
        expect(order).toEqual(["immediate", "resumed"]);
    });
});
