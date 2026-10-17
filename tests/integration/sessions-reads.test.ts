import { DateTime } from "luxon";
import { expectErrorEnvelope } from "../helpers/contract";
import { COMPLAINT, DAY, DOCTOR, HOUR, MINUTE, OTHER_DOCTOR, OTHER_PATIENT, PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { flushByPrefix } from "../helpers/redis";
import { OPEN_MS, OVERRUN_MS, patch, seedSession, SESSION_MS, sessionStart } from "../helpers/sessions-fixtures";

jest.setTimeout(120_000);

interface Item {
    id: number; status: string; startsAt: string; startsAtLocal: string; timezone: string;
    patient: { userId: number; displayName: string | null; avatarUrl: string | null; profileHydrated: boolean };
    doctor: { userId: number; displayName: string | null; profileHydrated: boolean };
}

describe("sessions read side: waiting room and calendar (integration: real routes, Postgres, Redis; Identity faked)", () => {
    const h = useConsultationsHarness("sessions-reads");
    const batchCalls = (): string[] => h.identityServer.calls.filter((entry) => entry.path.startsWith("/internal/users?ids=")).map((entry) => entry.path);
    const iso = (ms: number): string => encodeURIComponent(new Date(ms).toISOString());
    const calendar = (fromMs: number, toMs: number, extra = "", actor: "doctor" | "otherDoctor" | "admin" = "doctor") =>
        h.call("get", `/api/consultations/calendar?from=${iso(fromMs)}&to=${iso(toMs)}${extra}`, actor);
    const waitingRoom = () => h.call("get", "/api/consultations/waiting-room", "doctor");
    const idsOf = (body: { data: Array<{ id: number }> }): number[] => body.data.map((entry) => entry.id);

    // ───────────────────────────────────────────── waiting room (SS-R17)
    describe("GET /api/consultations/waiting-room", () => {
        const BOUNDARY: Array<[string, number, boolean]> = [
            ["1 ms before opensAt", -OPEN_MS - 1, false], ["exactly opensAt", -OPEN_MS, true], ["exactly the start", 0, true],
            ["1 ms before closesAt", SESSION_MS + OVERRUN_MS - 1, true], ["exactly closesAt", SESSION_MS + OVERRUN_MS, false],
        ];

        it.each(BOUNDARY)("should treat the window half-open at %s: listed=%s", async (_label, offset, listed) => {
            const id = await seedSession(h);
            h.clock.freeze(sessionStart() + offset);
            const res = await waitingRoom();
            expect(res.status).toBe(200);
            expect(idsOf(res.body)).toEqual(listed ? [id] : []);
        });

        it.each(["in_progress", "completed", "no_show"])("should leave a %s consultation out even inside its window", async (status) => {
            await seedSession(h, { status });
            h.clock.freeze(sessionStart() + MINUTE);
            expect((await waitingRoom()).body.data).toEqual([]);
        });

        it("should leave a cancelled consultation out even inside its window", async () => {
            await seedSession(h, { status: "cancelled", cancelled_at: new Date(), cancelled_by: "patient" });
            h.clock.freeze(sessionStart() + MINUTE);
            expect((await waitingRoom()).body.data).toEqual([]);
        });

        it("should list booked and waiting rows of the caller only, ordered by start, hydrated for the patient with no complaint text", async () => {
            const t0 = sessionStart();
            h.clock.freeze(t0);
            const later = await seedSession(h, { patient_user_id: OTHER_PATIENT }, t0 + 10 * MINUTE); // opens exactly now
            const earlier = await seedSession(h, { status: "waiting", joined_at: new Date(t0), room_id: "fake-room-x" }, t0 - 20 * MINUTE);
            await seedSession(h, {}, t0 + 40 * MINUTE); // opens in 30 minutes: not yet
            await seedSession(h, { doctor_user_id: OTHER_DOCTOR }, t0 + 5 * MINUTE); // another doctor's row
            const res = await waitingRoom();
            expect(res.status).toBe(200);
            expect(res.body).not.toHaveProperty("meta");
            const items = res.body.data as Item[];
            expect(items.map((item) => item.id)).toEqual([earlier, later]);
            expect(items.map((item) => item.status)).toEqual(["waiting", "booked"]);
            expect(items[0]?.patient).toEqual({ userId: PATIENT, displayName: "Pat Synthetic", avatarUrl: "https://example.test/a.png", profileHydrated: true });
            expect(items[1]?.patient).toMatchObject({ userId: OTHER_PATIENT, displayName: "Pat Other Synthetic", profileHydrated: true });
            expect(items[0]?.doctor).toMatchObject({ userId: DOCTOR, displayName: null, profileHydrated: false }); // the caller's own side is not hydrated
            expect(items[0]?.timezone).toBe("Africa/Cairo");
            expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
            expect(items.every((item) => !("complaintText" in item) && !("roomId" in item))).toBe(true);
        });

        it("should hydrate all patients with ONE batched Identity call, and none on a cached repeat", async () => {
            const t0 = sessionStart();
            h.clock.freeze(t0);
            await seedSession(h, {}, t0 - 20 * MINUTE);
            await seedSession(h, { patient_user_id: OTHER_PATIENT }, t0 + 10 * MINUTE);
            expect((await waitingRoom()).status).toBe(200);
            expect(batchCalls()).toHaveLength(1);
            expect(batchCalls()[0]).toContain(`ids=${PATIENT},${OTHER_PATIENT}`);
            expect((await waitingRoom()).status).toBe(200);
            expect(batchCalls()).toHaveLength(1); // served from the identity:user: cache
        });

        it("should make no Identity call for an empty waiting room", async () => {
            h.clock.freeze(sessionStart());
            expect((await waitingRoom()).body.data).toEqual([]);
            expect(batchCalls()).toHaveLength(0);
        });

        it.each([
            ["down", () => { h.identityServer.options.down = true; }],
            ["failing", () => { h.identityServer.options.batchFailures = 10; }],
            ["malformed", () => { h.identityServer.options.malformed = true; }],
        ])("should still answer 200 with unhydrated patients when Identity is %s (Case 2 degrade)", async (_label, breakIdentity) => {
            const t0 = sessionStart();
            h.clock.freeze(t0);
            const id = await seedSession(h, {}, t0 - 20 * MINUTE);
            breakIdentity();
            const res = await waitingRoom();
            expect(res.status).toBe(200);
            expect(idsOf(res.body)).toEqual([id]);
            expect(res.body.data[0].patient).toEqual({ userId: PATIENT, displayName: null, avatarUrl: null, profileHydrated: false });
            expect(res.body.data[0]).toMatchObject({ status: "booked", startsAt: new Date(t0 - 20 * MINUTE).toISOString() });
        });

        it("should answer 200 with unhydrated patients when Identity is slower than its client timeout", async () => {
            const t0 = sessionStart();
            h.clock.freeze(t0);
            await seedSession(h, {}, t0 - 20 * MINUTE);
            h.identityServer.options.slowMs = 2600;
            const res = await waitingRoom();
            expect(res.status).toBe(200);
            expect(res.body.data[0].patient.profileHydrated).toBe(false);
        });

        it("should serve cached profiles when Identity goes down after a first hydrated read", async () => {
            const t0 = sessionStart();
            h.clock.freeze(t0);
            await seedSession(h, {}, t0 - 20 * MINUTE);
            expect((await waitingRoom()).body.data[0].patient.profileHydrated).toBe(true);
            h.identityServer.options.down = true;
            const res = await waitingRoom();
            expect(res.status).toBe(200);
            expect(res.body.data[0].patient).toMatchObject({ displayName: "Pat Synthetic", profileHydrated: true });
        });

        it("should answer 400 ValidationFailed for any query member", async () => {
            const res = await h.call("get", "/api/consultations/waiting-room?limit=5", "doctor");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
        });

        it("should not be captured by GET /api/consultations/:id", async () => {
            h.clock.freeze(sessionStart());
            const res = await waitingRoom();
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
        });
    });

    // ───────────────────────────────────────────── calendar (SS-R18)
    describe("GET /api/consultations/calendar", () => {
        const from = (): number => sessionStart() - 2 * HOUR;
        const to = (): number => from() + DAY;

        it.each([
            ["from is missing", (): string => `to=${iso(to())}`], ["to is missing", (): string => `from=${iso(from())}`],
            ["from equals to", (): string => `from=${iso(from())}&to=${iso(from())}`], ["from is after to", (): string => `from=${iso(to())}&to=${iso(from())}`],
            ["the window is 7 days and 1 ms", (): string => `from=${iso(from())}&to=${iso(from() + 7 * DAY + 1)}`],
            ["from has no offset", (): string => `from=2026-10-18T10:00:00&to=${iso(to())}`], ["from is not a date", (): string => `from=tomorrow&to=${iso(to())}`],
            ["timezone is not an IANA zone", (): string => `from=${iso(from())}&to=${iso(to())}&timezone=Mars/Base`], ["a query member is unknown", (): string => `from=${iso(from())}&to=${iso(to())}&status=booked`],
        ])("should answer 400 ValidationFailed when %s", async (_label, query) => {
            const res = await h.call("get", `/api/consultations/calendar?${query()}`, "doctor");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
        });

        it("should name the field in the details of a reversed and of an over-long window", async () => {
            const reversed = await calendar(to(), from());
            expect(reversed.body.error.details).toEqual([expect.objectContaining({ field: "from" })]);
            const longer = await calendar(from(), from() + 7 * DAY + 1);
            expect(longer.body.error.details).toEqual([expect.objectContaining({ field: "to" })]);
        });

        it("should accept a window of exactly 7 days", async () => {
            const res = await calendar(from(), from() + 7 * DAY);
            expect(res.status).toBe(200);
        });

        it("should return every status that overlaps [from, to) in (startsAt, id) order and nothing else", async () => {
            const f = from();
            const t = to();
            const inside = await seedSession(h, {}, f + 3 * HOUR);
            const completed = await seedSession(h, { status: "completed", started_at: new Date(f), completed_at: new Date(f) }, f + 5 * HOUR);
            const cancelled = await seedSession(h, { status: "cancelled", cancelled_at: new Date(f), cancelled_by: "patient" }, f + 3 * HOUR); // overlaps `inside`: allowed once cancelled
            const noShow = await seedSession(h, { status: "no_show", no_show_marked_at: new Date(f) }, f + 7 * HOUR);
            const startsBefore = await seedSession(h, {}, f - 20 * MINUTE); // ends 10 minutes after `from`: overlaps
            await seedSession(h, { status: "cancelled", cancelled_at: new Date(f), cancelled_by: "patient" }, f - SESSION_MS); // ends exactly at `from`: outside (half-open)
            await seedSession(h, {}, f - 3 * HOUR);
            const lastIn = await seedSession(h, {}, t - SESSION_MS); // ends exactly at `to`: inside
            await seedSession(h, {}, t); // starts exactly at `to`: outside
            await seedSession(h, {}, t + 2 * HOUR);
            await seedSession(h, { doctor_user_id: OTHER_DOCTOR }, f + 4 * HOUR);
            const res = await calendar(f, t);
            expect(res.status).toBe(200);
            const items = res.body.data.consultations as Item[];
            expect(items.map((item) => item.id)).toEqual([startsBefore, inside, cancelled, completed, noShow, lastIn]);
            expect(items.map((item) => item.status)).toEqual(["booked", "booked", "cancelled", "completed", "no_show", "booked"]);
            expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
            expect(items.every((item) => !("complaintText" in item))).toBe(true);
            expect(Object.keys(res.body.data).sort()).toEqual(["consultations", "exceptions", "from", "timezone", "to"]);
        });

        it("should order rows with equal start times by id", async () => {
            const f = from();
            const first = await seedSession(h, { status: "cancelled", cancelled_at: new Date(f), cancelled_by: "patient" }, f + HOUR);
            const second = await seedSession(h, { status: "no_show", no_show_marked_at: new Date(f) }, f + HOUR);
            const third = await seedSession(h, {}, f + HOUR);
            const res = await calendar(f, to());
            expect(idsOf({ data: res.body.data.consultations as Item[] })).toEqual([first, second, third]);
        });

        it("should render in the doctor's zone by default, echo from and to in that zone, and honour a timezone override", async () => {
            const f = from();
            await seedSession(h, {}, f + 3 * HOUR);
            const byDefault = await calendar(f, to());
            expect(byDefault.body.data.timezone).toBe("Africa/Cairo");
            expect(DateTime.fromISO(byDefault.body.data.from as string, { setZone: true }).zoneName).not.toBe("UTC"); // an offset, not Z
            expect(Date.parse(byDefault.body.data.from as string)).toBe(f);
            expect(Date.parse(byDefault.body.data.to as string)).toBe(to());
            expect(byDefault.body.data.consultations[0].timezone).toBe("Africa/Cairo");
            expect(byDefault.body.data.consultations[0].startsAtLocal).toBe(DateTime.fromMillis(f + 3 * HOUR).setZone("Africa/Cairo").toISO({ suppressMilliseconds: true }));
            const override = await calendar(f, to(), "&timezone=America/New_York");
            expect(override.status).toBe(200);
            expect(override.body.data.timezone).toBe("America/New_York");
            expect(Date.parse(override.body.data.from as string)).toBe(f);
            expect(override.body.data.consultations[0].timezone).toBe("America/New_York");
            expect(override.body.data.consultations[0].startsAtLocal).toBe(DateTime.fromMillis(f + 3 * HOUR).setZone("America/New_York").toISO({ suppressMilliseconds: true }));
            expect(override.body.data.consultations[0].startsAt).toBe(byDefault.body.data.consultations[0].startsAt);
        });

        it("should list live exceptions by doctor-local date for the window, regardless of the render timezone", async () => {
            const profile = await ownerDb("doctor_profiles").where({ user_id: DOCTOR }).first("id");
            // Window starts at 00:30 doctor-local, so its UTC date is the day BEFORE the first local date.
            const day = DateTime.now().setZone("Africa/Cairo").plus({ days: 3 }).startOf("day");
            const f = day.plus({ minutes: 30 }).toMillis();
            const t = f + 2 * DAY; // covers local dates D, D+1 and (00:29 of) D+2
            const dateOf = (offsetDays: number): string => day.plus({ days: offsetDays }).toISODate() as string;
            await ownerDb("schedule_exceptions").insert([
                { doctor_profile_id: profile.id, date: dateOf(-1), type: "day_off", reason: "SYNTHETIC-before" },
                { doctor_profile_id: profile.id, date: dateOf(0), type: "day_off", reason: "SYNTHETIC-first" },
                { doctor_profile_id: profile.id, date: dateOf(1), type: "custom_hours", start_time: "10:00", end_time: "12:00" },
                { doctor_profile_id: profile.id, date: dateOf(2), type: "day_off" },
                { doctor_profile_id: profile.id, date: dateOf(3), type: "day_off" },
                { doctor_profile_id: profile.id, date: dateOf(4), type: "day_off", deleted_at: new Date() },
            ]);
            for (const extra of ["", "&timezone=Pacific/Kiritimati"]) {
                const res = await calendar(f, t, extra);
                expect(res.status).toBe(200);
                expect((res.body.data.exceptions as Array<{ date: string }>).map((entry) => entry.date)).toEqual([dateOf(0), dateOf(1), dateOf(2)]);
                expect(res.body.data.exceptions[1]).toMatchObject({ type: "custom_hours", startTime: "10:00", endTime: "12:00" });
            }
        });

        it("should omit exceptions of another doctor and soft-deleted ones", async () => {
            const other = await h.seedDoctor(OTHER_DOCTOR);
            const mine = await ownerDb("doctor_profiles").where({ user_id: DOCTOR }).first("id");
            const date = DateTime.fromMillis(from() + 3 * HOUR).setZone("Africa/Cairo").toISODate() as string;
            await ownerDb("schedule_exceptions").insert([{ doctor_profile_id: other, date, type: "day_off" }, { doctor_profile_id: mine.id, date, type: "day_off", deleted_at: new Date() }]);
            expect((await calendar(from(), to())).body.data.exceptions).toEqual([]);
        });

        it("should hydrate the patients with one batched Identity call and degrade to unhydrated when Identity is down", async () => {
            const f = from();
            await seedSession(h, {}, f + HOUR);
            await seedSession(h, { patient_user_id: OTHER_PATIENT }, f + 3 * HOUR);
            await seedSession(h, { status: "completed", started_at: new Date(f), completed_at: new Date(f) }, f + 5 * HOUR);
            const ok = await calendar(f, to());
            expect(ok.status).toBe(200);
            expect(batchCalls()).toHaveLength(1);
            expect((ok.body.data.consultations as Item[]).map((item) => item.patient.profileHydrated)).toEqual([true, true, true]);
            await flushByPrefix(["identity:"]);
            h.identityServer.options.down = true;
            const degraded = await calendar(f, to());
            expect(degraded.status).toBe(200);
            expect(degraded.body.data.consultations).toHaveLength(3);
            expect((degraded.body.data.consultations as Item[]).every((item) => item.patient.displayName === null && item.patient.profileHydrated === false)).toBe(true);
            expect(degraded.body.data.exceptions).toEqual([]);
        });

        it("should keep calendar rows of a no-show consultation visible after the interval was released", async () => {
            const f = from();
            const id = await seedSession(h, {}, f + HOUR);
            h.clock.freeze(f + 3 * HOUR);
            expect((await patch(h, id, "no-show", "doctor")).status).toBe(200);
            const res = await calendar(f, to());
            expect((res.body.data.consultations as Item[]).map((item) => [item.id, item.status])).toEqual([[id, "no_show"]]);
        });

        it("should serve a 7-day window of 300 consultations with hydration under 200 ms (warm, best of three)", async () => {
            const f = from();
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone,
                    price, currency, idempotency_key, request_hash)
                SELECT ?, 100 + (i % 30), 1, ?::timestamptz + i * interval '30 minutes', ?::timestamptz + i * interval '30 minutes' + interval '30 minutes',
                    (ARRAY['booked','completed','no_show'])[1 + (i % 3)], 'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64)
                FROM generate_series(0, 299) AS i`, [DOCTOR, new Date(f).toISOString(), new Date(f).toISOString()]);
            await ownerDb.raw("ANALYZE consultations");
            for (let id = 100; id < 130; id += 1) h.identityServer.users.set(id, { id, fullName: `Pat ${id}`, avatarUrl: null, status: "active" });
            const warm = await calendar(f, f + 7 * DAY);
            expect(warm.status).toBe(200);
            expect(warm.body.data.consultations).toHaveLength(300);
            const timings: number[] = [];
            for (let run = 0; run < 3; run += 1) {
                await flushByPrefix(["identity:", "rl:"]); // a cold hydration cache: the fake Identity is part of the measured path
                const began = performance.now();
                const res = await calendar(f, f + 7 * DAY);
                timings.push(performance.now() - began);
                expect(res.status).toBe(200);
            }
            expect(batchCalls().length).toBeGreaterThanOrEqual(4);
            expect(Math.min(...timings)).toBeLessThan(200);
        });
    });
});
