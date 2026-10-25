// Rules covered: AV-R23 (the boot-time sweep needs a ready Redis client: the daemon awaits the bounded connect before the first tick), AV-R25.
import { logger } from "../../../../src/lib/logger/logger";
import "../../../../src/worker";

const mockOrder: string[] = [];
const mockState: { handshake?: () => void; connectArgs?: unknown[] } = {};

// `import "../worker"` runs `runMain(main)` at load, before this file's own `const`s exist: the captured entry lives on globalThis.
jest.mock("../../../../src/lib/lifecycle/run-main", () => ({
    runMain: (main: () => void | Promise<void>) => { (globalThis as { workerMain?: () => void | Promise<void> }).workerMain = main; },
}));
jest.mock("../../../../src/lib/knex/knex", () => ({ createKnex: () => ({ destroy: jest.fn() }) }));
jest.mock("../../../../src/lib/identity-client/identity-client", () => ({ IdentityClient: jest.fn().mockImplementation(() => ({ close: jest.fn() })) }));
jest.mock("../../../../src/lib/storage/s3.adapter", () => ({ S3Adapter: jest.fn() }));
jest.mock("../../../../src/worker-loops", () => ({ buildWorkerLoops: () => [{ name: "availability-sweep", intervalMs: 1, tick: jest.fn() }] }));
jest.mock("../../../../src/lib/worker/loop-runner", () => ({
    LoopRunner: jest.fn().mockImplementation(() => ({ start: () => mockOrder.push("runner.start"), stop: jest.fn() })),
}));
jest.mock("../../../../src/lib/redis/redis", () => ({
    createRedis: () => ({ name: "care-worker-redis" }),
    closeRedis: jest.fn(),
    connectWithin: (...args: unknown[]) => {
        mockState.connectArgs = args;
        mockOrder.push("connect.begin");
        return new Promise<void>((resolve) => { mockState.handshake = () => { mockOrder.push("connect.end"); resolve(); }; });
    },
}));

describe("care-worker daemon boot", () => {
    beforeAll(() => { jest.spyOn(process, "on").mockImplementation(() => process); });
    afterAll(() => { jest.restoreAllMocks(); });

    it("should start the loops only after the bounded Redis connect settled so the first sweep tick sees a ready client", async () => {
        jest.spyOn(logger, "info").mockImplementation(() => undefined);
        const booting = (globalThis as { workerMain?: () => void | Promise<void> }).workerMain?.();
        expect(booting).toBeInstanceOf(Promise);
        expect(mockOrder).toEqual(["connect.begin"]);
        expect(mockState.connectArgs?.[1]).toBe(3_000);
        mockState.handshake?.();
        await booting;
        expect(mockOrder).toEqual(["connect.begin", "connect.end", "runner.start"]);
    });
});
