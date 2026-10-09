import { resolveAuditWindow } from "../../../../src/app/audit/window";
import { toMs } from "../../../../src/pkg/utils/time";

const NOW = Date.parse("2026-04-15T12:00:00.000Z");
const at = (iso: string): Date => new Date(iso);
const FROM_AFTER_TO = { code: "ValidationFailed", details: [{ field: "from", issue: "must not be later than to" }] };
function thrown(fn: () => unknown): unknown {
    try { fn(); } catch (error) { return error; }
    throw new Error("expected a throw");
}

describe("resolveAuditWindow", () => {
    it("should default to to the clock and from to 30 days before to", () => {
        const now = jest.fn(() => NOW);
        const window = resolveAuditWindow(now, undefined, undefined, undefined);
        expect(window.to.toISOString()).toBe("2026-04-15T12:00:00.000Z");
        expect(window.from.toISOString()).toBe("2026-03-16T12:00:00.000Z");
        expect(window.empty).toBe(false);
        expect(now).toHaveBeenCalledTimes(1);
    });

    it("should compute the default span with toMs(30, d)", () => {
        const window = resolveAuditWindow(() => NOW, undefined, undefined, undefined);
        expect(window.to.getTime() - window.from.getTime()).toBe(toMs(30, "d"));
    });

    it("should use cursor.to and never read the clock when query.to is absent", () => {
        const now = jest.fn(() => NOW);
        const window = resolveAuditWindow(now, undefined, undefined, at("2026-04-01T00:00:00.000Z"));
        expect(window.to.toISOString()).toBe("2026-04-01T00:00:00.000Z");
        expect(window.from.toISOString()).toBe("2026-03-02T00:00:00.000Z");
        expect(now).not.toHaveBeenCalled();
    });

    it("should prefer query.to over cursor.to and not read the clock", () => {
        const now = jest.fn(() => NOW);
        const window = resolveAuditWindow(now, undefined, at("2026-04-10T00:00:00.000Z"), at("2026-04-01T00:00:00.000Z"));
        expect(window.to.toISOString()).toBe("2026-04-10T00:00:00.000Z");
        expect(now).not.toHaveBeenCalled();
    });

    it("should honour an explicit from and take to from the clock", () => {
        const window = resolveAuditWindow(() => NOW, at("2020-01-01T00:00:00.000Z"), undefined, undefined);
        expect(window.from.toISOString()).toBe("2020-01-01T00:00:00.000Z");
        expect(window.to.toISOString()).toBe("2026-04-15T12:00:00.000Z");
    });

    it("should reject from later than to with the field from", () => {
        expect(thrown(() => resolveAuditWindow(() => NOW, at("2026-04-02T00:00:00.000Z"), at("2026-04-01T00:00:00.000Z"), undefined))).toMatchObject(FROM_AFTER_TO);
    });

    it("should reject a lone from later than the clock now", () => {
        expect(thrown(() => resolveAuditWindow(() => NOW, at("2026-04-15T12:00:00.001Z"), undefined, undefined))).toMatchObject(FROM_AFTER_TO);
    });

    it("should reject a lone from later than the frozen cursor to", () => {
        expect(thrown(() => resolveAuditWindow(() => NOW, at("2026-04-02T00:00:00.000Z"), undefined, at("2026-04-01T00:00:00.000Z")))).toMatchObject(FROM_AFTER_TO);
    });

    it("should accept from equal to to and report an empty window", () => {
        const window = resolveAuditWindow(() => NOW, at("2026-04-01T00:00:00.000Z"), at("2026-04-01T00:00:00.000Z"), undefined);
        expect(window.empty).toBe(true);
    });

    it("should report a one-millisecond window as not empty", () => {
        const window = resolveAuditWindow(() => NOW, at("2026-04-01T00:00:00.000Z"), at("2026-04-01T00:00:00.001Z"), undefined);
        expect(window.empty).toBe(false);
    });

    it("should accept a window of any size (no span cap)", () => {
        const window = resolveAuditWindow(() => NOW, at("1970-01-01T00:00:00.000Z"), at("9999-12-31T23:59:59.999Z"), undefined);
        expect(window.empty).toBe(false);
    });
});
