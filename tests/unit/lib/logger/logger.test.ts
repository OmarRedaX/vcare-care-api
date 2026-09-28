import { Logger, serializeError } from "../../../../src/lib/logger/logger";
import { requestContext } from "../../../../src/lib/logger/request-context";
import type { LogLevel } from "../../../../src/lib/config/types";

const FIXED_NOW = new Date("2026-09-25T10:11:12.345Z");

function collectingLogger(level: LogLevel = "debug", bindings?: Record<string, unknown>) {
    const lines: string[] = [];
    const logger = new Logger({
        level,
        service: "care-service",
        bindings,
        write: (line) => lines.push(line),
        now: () => FIXED_NOW,
    });
    const parsed = (): Array<Record<string, unknown>> => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { logger, lines, parsed };
}

describe("lib/logger/Logger", () => {
    it("should emit the fields in parity order when logging (F7)", () => {
        const { logger, lines } = collectingLogger();
        logger.info("request_completed", {
            extra: "last",
            durationMs: 1.5,
            code: "NotFound",
            status: 404,
            method: "GET",
            route: "/api/x",
            clientId: "svc",
            role: "patient",
            userId: 7,
            requestId: "rid",
        });

        expect(lines).toHaveLength(1);
        expect(lines[0]?.endsWith("\n")).toBe(true);
        expect(Object.keys(JSON.parse(lines[0] ?? "{}") as object)).toEqual([
            "level",
            "message",
            "timestamp",
            "service",
            "requestId",
            "userId",
            "role",
            "clientId",
            "route",
            "method",
            "status",
            "code",
            "durationMs",
            "extra",
        ]);
        expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
            level: "info",
            message: "request_completed",
            timestamp: "2026-09-25T10:11:12.345Z",
            service: "care-service",
        });
    });

    it("should drop entries below LOG_LEVEL", () => {
        const { logger, parsed } = collectingLogger("warn");
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");
        expect(parsed().map((line) => line.message)).toEqual(["w", "e"]);
    });

    it("should include bindings when a child logger is used", () => {
        const { logger, parsed } = collectingLogger("debug", { component: "root" });
        const child = logger.child({ requestId: "child-rid", component: "child" });
        child.info("hello", { extra: 1 });
        expect(parsed()[0]).toMatchObject({ requestId: "child-rid", component: "child", extra: 1 });
    });

    it("should redact sensitive keys in fields when logging (F7)", () => {
        const { logger, lines } = collectingLogger();
        logger.warn("x", {
            email: "synthetic.patient@example.test",
            nested: { complaintText: "SYNTHETIC-COMPLAINT-7731" },
            authorization: "Bearer synthetic-token-abc",
        });
        const text = lines.join("");
        expect(text).not.toContain("synthetic.patient@example.test");
        expect(text).not.toContain("SYNTHETIC-COMPLAINT-7731");
        expect(text).not.toContain("synthetic-token-abc");
        expect(text).toContain("[REDACTED]");
    });

    it("should serialize an Error without pg detail or parameters when error is passed", () => {
        const { logger, parsed } = collectingLogger();
        const pgError = Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            detail: "Key (email)=(synthetic.patient@example.test) already exists.",
            where: "SQL statement",
            parameters: ["synthetic.patient@example.test"],
            query: "INSERT INTO t VALUES ($1)",
            bindings: ["synthetic.patient@example.test"],
        });

        logger.error("db_failed", { error: pgError });

        const error = parsed()[0]?.error as Record<string, unknown>;
        expect(Object.keys(error).sort()).toEqual(["code", "name", "stack"]);
        expect(error.code).toBe("23505");
        expect(JSON.stringify(parsed())).not.toContain("synthetic.patient@example.test");
    });

    it.each([
        ["22P02", 'invalid input syntax for type integer: "SYNTHETIC-COMPLAINT-7731"'],
        ["22007", 'invalid input syntax for type timestamp with time zone: "SYNTHETIC-COMPLAINT-7731"'],
        ["22008", 'date/time field value out of range: "SYNTHETIC-COMPLAINT-7731"'],
        ["22003", 'value "SYNTHETIC-COMPLAINT-7731" is out of range for type integer'],
    ])(
        "should drop the message and rebuild the stack from frames when a pg error's message was mutated after construction (%s)",
        (code, pgMessage) => {
            // pg builds the error; Knex later rewrites `message` with the SQL prefix. V8 formats `stack` lazily, so the
            // first read of `stack` would repeat the rewritten message (the leak this rule closes).
            const pgError = Object.assign(new Error(pgMessage), { code, severity: "ERROR", routine: "pg_strtoint32_safe" });
            pgError.message = `select $1::int as n - ${pgMessage}\nsecond line "SYNTHETIC-COMPLAINT-7731"`;

            const serialized = serializeError(pgError);

            expect(serialized.message).toBeUndefined();
            expect(serialized).toMatchObject({ name: "Error", code, severity: "ERROR", routine: "pg_strtoint32_safe" });
            expect(JSON.stringify(serialized)).not.toContain("SYNTHETIC-COMPLAINT-7731");
            const [header, ...frames] = (serialized.stack ?? "").split("\n");
            expect(header).toBe("Error");
            expect(frames.length).toBeGreaterThan(0);
            expect(frames.every((line) => /^\s+at /.test(line))).toBe(true);
        },
    );

    it("should keep pg identifier fields and drop detail, where, hint, and the message when serializing a CHECK violation", () => {
        const pgError = Object.assign(new Error('new row for relation "t" violates check constraint "chk_t_x"'), {
            code: "23514",
            severity: "ERROR",
            constraint: "chk_t_x",
            table: "t",
            column: "x",
            schema: "public",
            detail: "Failing row contains (1, SYNTHETIC-COMPLAINT-7731).",
            where: "SQL statement",
            hint: "SYNTHETIC-COMPLAINT-7731",
        });

        const serialized = serializeError(pgError) as unknown as Record<string, unknown>;

        expect(Object.keys(serialized).sort()).toEqual(["code", "column", "constraint", "name", "severity", "stack", "table"]);
        expect(JSON.stringify(serialized)).not.toContain("SYNTHETIC-COMPLAINT-7731");
    });

    it("should keep the message but rebuild the stack from frames when a non-database Error is serialized", () => {
        const error = new Error("Knex: Timeout acquiring a connection");
        error.message = "Knex: Timeout acquiring a connection\nsecond line";

        const serialized = serializeError(error);

        expect(serialized.message).toBe("Knex: Timeout acquiring a connection\nsecond line");
        expect(serialized.stack?.split("\n")[0]).toBe("Error");
        expect(serialized.stack).not.toContain("second line");
    });

    it("should never log a non-Error value when error is not an Error", () => {
        expect(serializeError({ secret: "x" })).toEqual({ name: "NonError", message: "A non-Error value was thrown" });
        expect(serializeError("SYNTHETIC-COMPLAINT-7731")).toEqual({ name: "NonError", message: "A non-Error value was thrown" });
    });

    it("should emit a metric line with metric, value, and dims when metric is called", () => {
        const { logger, parsed } = collectingLogger("warn");
        logger.metric("worker_heartbeat", 1, { loop: "runner" });
        expect(parsed()).toEqual([
            {
                level: "info",
                message: "metric",
                timestamp: "2026-09-25T10:11:12.345Z",
                service: "care-service",
                metric: "worker_heartbeat",
                value: 1,
                dims: { loop: "runner" },
            },
        ]);
    });

    it("should drop metrics when LOG_LEVEL is error", () => {
        const { logger, lines } = collectingLogger("error");
        logger.metric("worker_heartbeat", 1);
        expect(lines).toHaveLength(0);
    });

    it("should redact metric dims when a dim key is sensitive", () => {
        const { logger, lines } = collectingLogger();
        logger.metric("rate_limiter_degraded", 1, { email: "synthetic.patient@example.test" });
        expect(lines.join("")).not.toContain("synthetic.patient@example.test");
    });

    it.each(["WorkerHeartbeat", "1metric", "metric-name", ""])(
        "should throw in test when a metric name is not snake_case (%p)",
        (name) => {
            const { logger } = collectingLogger();
            expect(() => logger.metric(name, 1)).toThrow("Invalid metric");
        },
    );

    it("should throw in test when a metric value is not finite", () => {
        const { logger } = collectingLogger();
        expect(() => logger.metric("ok_name", Number.NaN)).toThrow("Invalid metric");
    });

    it("should add requestId from the AsyncLocalStorage store when logging outside the middleware", async () => {
        const { logger, parsed } = collectingLogger();
        await requestContext.run({ requestId: "store-rid", userId: 5, role: "doctor" }, async () => {
            await Promise.resolve();
            logger.info("deep");
        });
        expect(parsed()[0]).toMatchObject({ requestId: "store-rid", userId: 5, role: "doctor" });
    });

    it("should prefer explicit fields over the store when both set requestId", () => {
        const { logger, parsed } = collectingLogger();
        requestContext.run({ requestId: "store-rid" }, () => {
            logger.info("explicit", { requestId: "explicit-rid" });
        });
        expect(parsed()[0]?.requestId).toBe("explicit-rid");
    });

    it("should omit requestId when logging outside any request", () => {
        const { logger, parsed } = collectingLogger();
        logger.info("outside");
        expect(parsed()[0]).not.toHaveProperty("requestId");
    });
});
