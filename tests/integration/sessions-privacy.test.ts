import { getEnv } from "../../src/lib/config/env";
import { logger } from "../../src/lib/logger/logger";
import { COMPLAINT, HOUR, MINUTE, REASON, useConsultationsHarness } from "../helpers/consultations-harness";
import { captureLogs } from "../helpers/log-capture";
import { GRACE_MS, NOTE, patch, seedSession, sessionStart } from "../helpers/sessions-fixtures";

jest.setTimeout(120_000);

describe("sessions log hygiene (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("sessions-privacy");

    it("should keep join tokens, room ids, the video key, the no-show note, complaint text and names out of every log line across success, outage and degrade paths", async () => {
        // The suite runs at LOG_LEVEL=warn; lower the root logger so every request_completed line (info) is emitted and checked too.
        const level = logger as unknown as { level: string };
        const previousLevel = level.level;
        level.level = "debug";
        const logs = captureLogs();
        const issued: string[] = [];
        let degradedRequestId = "";
        try {
            const first = await seedSession(h);
            const second = await seedSession(h, {}, sessionStart() + 2 * HOUR);
            const third = await seedSession(h, {}, sessionStart() + 4 * HOUR);
            h.clock.freeze(sessionStart());
            const join = await patch(h, first, "join", "patient");
            const start = await patch(h, first, "start", "doctor");
            issued.push(join.body.data.joinToken as string, start.body.data.joinToken as string);
            await patch(h, first, "join", "admin"); // 403
            await patch(h, 999999, "join", "patient"); // 404
            h.clock.freeze(sessionStart() + 10 * MINUTE);
            await patch(h, first, "complete", "doctor");
            // Provider outages: the failure log carries a code only.
            h.clock.freeze(sessionStart() + 2 * HOUR);
            h.video.failEnsure = true;
            await patch(h, second, "join", "patient");
            h.video.failEnsure = false;
            h.video.failIssue = true;
            await patch(h, second, "start", "doctor");
            h.video.failIssue = false;
            issued.push((await patch(h, second, "join", "doctor")).body.data.joinToken as string);
            // Case 2 degrade: Identity down while reading the waiting room and the calendar.
            h.identityServer.options.down = true;
            degradedRequestId = crypto.randomUUID();
            await h.call("get", "/api/consultations/waiting-room", "doctor");
            await h.call("get", `/api/consultations/calendar?from=${encodeURIComponent(new Date(sessionStart()).toISOString())}&to=${encodeURIComponent(new Date(sessionStart() + 6 * HOUR).toISOString())}`, "doctor",
                undefined, { "X-Request-Id": degradedRequestId });
            h.identityServer.options.down = false;
            // No-show with a note, by an admin and by the doctor, plus a rejected note.
            h.clock.freeze(sessionStart() + 4 * HOUR + GRACE_MS);
            await h.call("patch", `/api/consultations/${third}/no-show`, "doctor", { note: `${NOTE} ${"x".repeat(2000)}` }); // 400 carrying the text
            await h.call("patch", `/api/consultations/${third}/no-show`, "admin", { note: NOTE, reason: REASON });
            await h.call("patch", `/api/consultations/${third}/no-show`, "admin", { note: NOTE });
        } finally {
            logs.restore();
            level.level = previousLevel;
        }
        const text = logs.text();
        expect(issued.every((token) => token.length > 20)).toBe(true);
        const secrets = [...issued, "fake-room-", "joinToken", getEnv().VIDEO_PROVIDER_KEY, NOTE, COMPLAINT, REASON, "Pat Synthetic", "Pat Other Synthetic", "Dr Synthetic",
            "example.test", ...Object.values(h.tokens), "Authorization", "Bearer "];
        for (const secret of secrets) expect([secret.slice(0, 24), text.includes(secret)]).toEqual([secret.slice(0, 24), false]);
        const lines = logs.lines();
        // Not vacuous: the session routes logged, and the provider failures were recorded with a code and nothing else of the provider.
        const completed = lines.filter((line) => line.message === "request_completed" && typeof line.route === "string" && /consultations\/(:id\/(join|start|complete|no-show)|waiting-room|calendar)/.test(line.route));
        expect(completed.length).toBeGreaterThanOrEqual(12);
        for (const line of completed) {
            expect(Object.keys(line).every((key) => ["level", "message", "timestamp", "service", "requestId", "userId", "role", "route", "method", "status", "code", "durationMs"].includes(key))).toBe(true);
        }
        const failures = lines.filter((line) => line.message === "video_provider_failed");
        expect(failures.map((line) => [line.operation, line.code])).toEqual([["ensure_room", "stub_ensure_failed"], ["issue_token", "stub_issue_failed"]]);
        expect(failures.every((line) => Object.keys(line).sort().join() === ["code", "level", "message", "operation", "requestId", "role", "service", "timestamp", "userId"].sort().join())).toBe(true);
        // Case 2: the degraded hydration is logged against the request, with an id and nothing about the patients.
        const degraded = lines.filter((line) => line.requestId === degradedRequestId && line.message === "identity_hydration_degraded");
        expect(degraded).toHaveLength(1);
        expect(degraded[0]?.level).toBe("warn");
    });
});
