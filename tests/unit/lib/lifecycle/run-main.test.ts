import { runMain } from "../../../../src/lib/lifecycle/run-main";
import { Logger } from "../../../../src/lib/logger/logger";

function collect() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = new Logger({
        level: "info",
        service: "care-service",
        write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    return { logger, lines, exit: jest.fn() };
}

describe("lib/lifecycle/runMain (parity c: boot_failed)", () => {
    it("should write one boot_failed line and exit 1 when main throws synchronously", () => {
        const { logger, lines, exit } = collect();
        runMain(
            () => {
                throw new Error("synthetic boot failure");
            },
            { logger, exit },
        );

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ level: "error", message: "boot_failed", error: { name: "Error", message: "synthetic boot failure" } });
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("should write one boot_failed line and exit 1 when main rejects", async () => {
        const { logger, lines, exit } = collect();
        runMain(() => Promise.reject(new Error("synthetic async boot failure")), { logger, exit });
        await new Promise((resolve) => setImmediate(resolve));

        expect(lines.map((line) => line.message)).toEqual(["boot_failed"]);
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("should neither log nor exit when main succeeds", async () => {
        const { logger, lines, exit } = collect();
        runMain(() => undefined, { logger, exit });
        runMain(() => Promise.resolve(), { logger, exit });
        await new Promise((resolve) => setImmediate(resolve));

        expect(lines).toEqual([]);
        expect(exit).not.toHaveBeenCalled();
    });

    it("should never log a thrown non-Error value when boot fails", () => {
        const { logger, lines, exit } = collect();
        runMain(
            () => {
                throw "SYNTHETIC-COMPLAINT-7731"; // eslint-disable-line @typescript-eslint/only-throw-error
            },
            { logger, exit },
        );
        expect(JSON.stringify(lines)).not.toContain("SYNTHETIC-COMPLAINT-7731");
        expect(exit).toHaveBeenCalledWith(1);
    });
});
