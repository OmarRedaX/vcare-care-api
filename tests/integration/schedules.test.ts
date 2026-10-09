import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { DateTime } from "luxon";
import request from "supertest";
import type { Test } from "supertest";
import type { NoopScheduleChangeListener } from "../../src/app/schedules/service/noop-schedule-change-listener";
import type { NoopScheduleImpactProvider } from "../../src/app/schedules/service/noop-schedule-impact.provider";
import { hasActiveTypeQuery, listTypesPageQuery } from "../../src/app/schedules/repository/consultation-types.repo";
import { listExceptionsPageQuery } from "../../src/app/schedules/repository/schedule-exceptions.repo";
import { listLiveHoursQuery } from "../../src/app/schedules/repository/working-hours.repo";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { encodeCursor } from "../../src/lib/http/pagination/cursor";
import { hashBody } from "../../src/lib/idempotency/idempotency";
import { inProgressRecord } from "../../src/lib/idempotency/idempotency-store";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps } from "../helpers/app";
import {
    contractResponseCodes, expectErrorEnvelope, expectPaginationMeta, idempotentOperations, inlineLists, schemaBlock,
} from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signExpiredUserToken, signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(60_000);

const HOURS = "/api/doctors/me/working-hours";
const EXCEPTIONS = "/api/doctors/me/exceptions";
const TYPES = "/api/doctors/me/consultation-types";
const REASON = "SYNTHETIC-REASON-4417";
const TYPE_NAME = "Synthetic Visit 001";
const ROUTE_LABELS = [HOURS, EXCEPTIONS, `${EXCEPTIONS}/:id`, TYPES, `${TYPES}/:id`];

type Actor = "doctor" | "pending" | "rejected" | "suspendedToken" | "otherDoctor" | "patient" | "admin" | "expired";
type Verb = "get" | "put" | "post" | "patch" | "delete";

const today = (offset = 0): string => DateTime.now().setZone("Africa/Cairo").plus({ days: offset }).toISODate() ?? "";
const day = (weekday: number, ...intervals: Array<[string, string]>): object => ({ weekday, intervals: intervals.map(([startTime, endTime]) => ({ startTime, endTime })) });
const typeBody = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({ name: TYPE_NAME, durationMinutes: 30, price: 15000, currency: "EGP", ...changes });
const dayOff = (date: string, changes: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "day_off", date, ...changes });

describe("schedules (integration: real routes, Postgres and Redis)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    const tokens = {} as Record<Actor, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const seen = new Map<string, Set<number>>();
    const provider = container.resolve<NoopScheduleImpactProvider>(TOKENS.ScheduleImpactProvider);
    const listener = container.resolve<NoopScheduleChangeListener>(TOKENS.ScheduleChangeListener);

    const template = (path: string): string => path.split("?")[0]?.replace(/\/(exceptions|consultation-types)\/[^/]+$/, "/$1/{id}") ?? path;
    function tracked(test: Test, verb: Verb, path: string): Test {
        const original = test.end.bind(test) as (callback?: (error: Error | null, res: request.Response) => void) => Test;
        test.end = ((callback?: (error: Error | null, res: request.Response) => void): Test => original((error, res) => {
            if (res !== undefined) { const key = `${verb} ${template(path)}`; const set = seen.get(key) ?? new Set<number>(); set.add(res.status); seen.set(key, set); }
            callback?.(error, res);
        })) as Test["end"];
        return test;
    }
    function call(verb: Verb, path: string, actor?: Actor, payload?: object, headers: Record<string, string> = {}): Test {
        let test = tracked(request(app)[verb](path), verb, path).set(headers);
        if (actor !== undefined) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload !== undefined) test = test.send(payload);
        return test;
    }
    async function seedProfile(userId: number, changes: Record<string, unknown> = {}): Promise<number> {
        const rows = await ownerDb("doctor_profiles").insert({
            user_id: userId, headline: "Synthetic headline", years_experience: 5, consultation_fee: 100, currency: "EGP", default_slot_minutes: 30,
            timezone: "Africa/Cairo", is_accepting_patients: true, verification_status: "draft", identity_sync_status: "not_required", ...changes,
        }).returning("id");
        return (rows[0] as { id: number }).id;
    }
    const liveHours = async (profileId = 1) => (await ownerDb("working_hours").where({ doctor_profile_id: profileId }).whereNull("deleted_at").orderBy("weekday").orderBy("start_time"))
        .map((row) => `${row.weekday}|${String(row.start_time).slice(0, 5)}|${String(row.end_time).slice(0, 5)}`);
    const exceptionRows = (profileId = 1) => ownerDb("schedule_exceptions").where({ doctor_profile_id: profileId }).orderBy("date").orderBy("id");
    const liveExceptions = (profileId = 1) => exceptionRows(profileId).whereNull("deleted_at");
    const typeRows = (profileId = 1) => ownerDb("consultation_types").where({ doctor_profile_id: profileId }).whereNull("deleted_at").orderBy("id");
    const audits = () => ownerDb("audit_logs").select("actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata")
        .where(function () { this.where("action", "like", "schedule.%").orWhere("action", "like", "consultation_type.%"); }).orderBy("id");
    const auditActions = async (): Promise<string[]> => (await audits()).map((row) => row.action as string);

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["schedules"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "doctor" | "patient" | "admin", "pending" | "active" | "rejected" | "suspended"]> = [
            ["doctor", "202", "doctor", "active"], ["pending", "202", "doctor", "pending"], ["rejected", "202", "doctor", "rejected"],
            ["suspendedToken", "202", "doctor", "suspended"], ["otherDoctor", "204", "doctor", "active"],
            ["patient", "101", "patient", "active"], ["admin", "303", "admin", "active"],
        ];
        for (const [name, sub, role, status] of claims) tokens[name] = await signUserToken(fake.key("schedules"), { sub, role, status });
        tokens.expired = await signExpiredUserToken(fake.key("schedules"), { sub: "202", role: "doctor", status: "active" });
    });
    beforeEach(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:"]);
        await seedProfile(202);
    });
    afterEach(() => { jest.restoreAllMocks(); });
    afterAll(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await fake.close(); await closeRedis(); await closeDb();
    });

    // ------------------------------------------------------------------------------------------ RBAC
    const ROUTES: Array<[string, Verb, string, object | undefined, number]> = [
        ["GET working-hours", "get", HOURS, undefined, 200],
        ["PUT working-hours", "put", HOURS, { days: [day(1, ["09:00", "12:00"])] }, 200],
        ["GET exceptions", "get", EXCEPTIONS, undefined, 200],
        ["POST exceptions", "post", EXCEPTIONS, dayOff(today(5)), 201],
        ["DELETE exceptions/{id}", "delete", `${EXCEPTIONS}/999`, undefined, 404],
        ["GET consultation-types", "get", TYPES, undefined, 200],
        ["POST consultation-types", "post", TYPES, typeBody(), 201],
        ["PATCH consultation-types/{id}", "patch", `${TYPES}/999`, { isActive: false }, 404],
    ];

    it.each(ROUTES)("should enforce RBAC on %s for every actor", async (_label, verb, path, payload, allowedStatus) => {
        const unauthenticated = await call(verb, path, undefined, payload);
        expect(unauthenticated.status).toBe(401); expectErrorEnvelope(unauthenticated.body, "Unauthorized", unauthenticated.headers["x-request-id"]);
        const expired = await call(verb, path, "expired", payload);
        expect(expired.status).toBe(401); expectErrorEnvelope(expired.body, "TokenExpired");
        for (const actor of ["patient", "admin", "pending", "rejected", "suspendedToken"] as const) {
            const res = await call(verb, path, actor, payload);
            expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden", res.headers["x-request-id"]);
        }
        const allowed = await call(verb, path, "doctor", payload);
        expect(allowed.status).toBe(allowedStatus);
        if (allowedStatus === 404) expectErrorEnvelope(allowed.body, "NotFound");
        await ownerDb("doctor_profiles").where("user_id", 202).update({ suspended_at: new Date(), suspension_reason: "synthetic reason" });
        const suspended = await call(verb, path, "doctor", payload);
        expect(suspended.status).toBe(403); expectErrorEnvelope(suspended.body, "Forbidden");
    });

    it.each(ROUTES)("should return 404 on %s when the doctor has no live profile", async (_label, verb, path, payload) => {
        await ownerDb("doctor_profiles").where("user_id", 202).update({ deleted_at: new Date() });
        const res = await call(verb, path, "doctor", payload);
        expect(res.status).toBe(404); expectErrorEnvelope(res.body, "NotFound");
    });

    it("should deny a patient token carrying spoofed identity headers on every route", async () => {
        for (const [, verb, path, payload] of ROUTES) {
            const res = await call(verb, path, "patient", payload, { "X-Role": "doctor", "X-User-Id": "202" });
            expect(res.status).toBe(403);
        }
        expect(await liveHours()).toEqual([]);
    });

    it("should answer the wrong role before validating the body", async () => {
        const res = await call("put", HOURS, "patient", { days: "garbage" });
        expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden");
        const admin = await call("post", TYPES, "admin", { name: 5 });
        expect(admin.status).toBe(403);
    });

    it("should never let another doctor see or change a doctor's rows (non-owner)", async () => {
        await seedProfile(204);
        const created = await call("post", EXCEPTIONS, "doctor", dayOff(today(4)));
        const exceptionId = created.body.data[0].id as number;
        const type = await call("post", TYPES, "doctor", typeBody());
        const typeId = type.body.data.id as number;
        await call("put", HOURS, "doctor", { days: [day(2, ["10:00", "11:00"])] });
        const deleted = await call("delete", `${EXCEPTIONS}/${exceptionId}`, "otherDoctor");
        expect(deleted.status).toBe(404); expectErrorEnvelope(deleted.body, "NotFound");
        const patched = await call("patch", `${TYPES}/${typeId}`, "otherDoctor", { name: "Synthetic Hijack" });
        expect(patched.status).toBe(404);
        expect((await call("get", EXCEPTIONS, "otherDoctor")).body.data).toEqual([]);
        expect((await call("get", TYPES, "otherDoctor")).body.data).toEqual([]);
        expect((await call("get", HOURS, "otherDoctor")).body.data.days).toEqual([]);
        expect(await liveExceptions(1)).toHaveLength(1);
        expect((await typeRows(1))[0]?.name).toBe(TYPE_NAME);
        for (const [verb, path, payload] of [["put", HOURS, { days: [], doctorProfileId: 1 }], ["post", EXCEPTIONS, { ...dayOff(today(9)), userId: 202 }],
            ["post", TYPES, typeBody({ doctorProfileId: 1 })], ["patch", `${TYPES}/${typeId}`, { name: "Synthetic Other", doctorProfileId: 1 }]] as const) {
            const res = await call(verb, path, "otherDoctor", payload);
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
        }
    });

    // ------------------------------------------------------------------------------------------ working hours
    describe("working hours", () => {
        it("should return days: [] and the profile timezone before any PUT", async () => {
            const res = await call("get", HOURS, "doctor");
            expect(res.status).toBe(200); expect(res.body.success).toBe(true);
            expect(res.body.data).toEqual({ timezone: "Africa/Cairo", days: [] });
            expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
        });

        it("should store a split shift and 24:00 and return them sorted", async () => {
            const res = await call("put", HOURS, "doctor", { days: [day(3, ["14:00", "24:00"], ["09:00", "12:00"]), day(1, ["08:00", "08:30"])] });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ timezone: "Africa/Cairo", days: [
                { weekday: 1, intervals: [{ startTime: "08:00", endTime: "08:30" }] },
                { weekday: 3, intervals: [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "24:00" }] },
            ] });
            expect((await call("get", HOURS, "doctor")).body.data).toEqual(res.body.data);
            expect(await liveHours()).toEqual(["1|08:00|08:30", "3|09:00|12:00", "3|14:00|24:00"]);
            const [required = []] = inlineLists(schemaBlock("WorkingHours"), "required");
            expect(Object.keys(res.body.data).sort()).toEqual([...required].sort());
        });

        it("should accept touching intervals, seven days and six intervals a day", async () => {
            expect((await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "12:00"], ["12:00", "14:00"])] })).status).toBe(200);
            const six: Array<[string, string]> = [["00:00", "01:00"], ["02:00", "03:00"], ["04:00", "05:00"], ["06:00", "07:00"], ["08:00", "09:00"], ["10:00", "11:00"]];
            const res = await call("put", HOURS, "doctor", { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => day(weekday, ...six)) });
            expect(res.status).toBe(200); expect(await liveHours()).toHaveLength(42);
        });

        it("should replace the whole set and soft-delete the old rows", async () => {
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "12:00"]), day(2, ["09:00", "12:00"])] });
            const before = await ownerDb("working_hours").select("id");
            await call("put", HOURS, "doctor", { days: [day(5, ["10:00", "11:00"])] });
            expect(await liveHours()).toEqual(["5|10:00|11:00"]);
            const all = await ownerDb("working_hours").orderBy("id");
            expect(all).toHaveLength(before.length + 1);
            expect(all.filter((row) => row.deleted_at !== null)).toHaveLength(2);
        });

        it.each([
            ["a duplicate weekday", { days: [day(1, ["09:00", "10:00"]), day(1, ["11:00", "12:00"])] }, "days"],
            ["an overlap", { days: [day(1, ["09:00", "12:00"], ["11:00", "14:00"])] }, "days[0].intervals"],
            ["end equal to start", { days: [day(1, ["09:00", "09:00"])] }, "days[0].intervals"],
            ["end before start", { days: [day(1, ["10:00", "09:00"])] }, "days[0].intervals"],
            ["a 24:00 start", { days: [day(1, ["24:00", "24:00"])] }, "days[0].intervals"],
            ["seven intervals", { days: [day(1, ...Array.from({ length: 7 }, (_u, i): [string, string] => [`0${i}:00`, `0${i}:30`]))] }, "days.0.intervals"],
            ["zero intervals", { days: [day(1)] }, "days.0.intervals"],
            ["an unknown member", { days: [], doctorProfileId: 4 }, "doctorProfileId"],
            ["a bad time", { days: [day(1, ["25:00", "26:00"])] }, "days.0.intervals.0.startTime"],
            ["weekday 8", { days: [day(8, ["09:00", "10:00"])] }, "days.0.weekday"],
            ["a string confirmConflicts", { days: [], confirmConflicts: "true" }, "confirmConflicts"],
        ])("should return 400 for %s and leave the stored set unchanged", async (_label, payload, field) => {
            await call("put", HOURS, "doctor", { days: [day(2, ["09:00", "10:00"])] });
            const res = await call("put", HOURS, "doctor", payload);
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
            expect(await liveHours()).toEqual(["2|09:00|10:00"]);
            expect(await auditActions()).toEqual(["schedule.hours_replaced"]);
        });

        it("should answer an identical PUT with 200, no write, no audit and no listener call", async () => {
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "12:00"]), day(2, ["10:00", "11:00"])] });
            const before = await ownerDb("working_hours").whereNull("deleted_at").select("id", "updated_at").orderBy("id");
            const onChange = jest.spyOn(listener, "onScheduleChanged");
            const findAffected = jest.spyOn(provider, "findAffected");
            const res = await call("put", HOURS, "doctor", { days: [day(2, ["10:00", "11:00"]), day(1, ["09:00", "12:00"])] });
            expect(res.status).toBe(200);
            expect(await ownerDb("working_hours").whereNull("deleted_at").select("id", "updated_at").orderBy("id")).toEqual(before);
            expect(await auditActions()).toEqual(["schedule.hours_replaced"]);
            expect(onChange).not.toHaveBeenCalled(); expect(findAffected).not.toHaveBeenCalled();
        });

        it("should clear all hours for days: []", async () => {
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "12:00"])] });
            const res = await call("put", HOURS, "doctor", { days: [] });
            expect(res.status).toBe(200); expect(res.body.data.days).toEqual([]);
            expect(await liveHours()).toEqual([]);
        });

        it("should write the hours_replaced audit row with actor, request id and counts in the same transaction", async () => {
            const requestId = randomUUID();
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "12:00"], ["14:00", "16:00"]), day(2, ["09:00", "10:00"])] }, { "X-Request-Id": requestId });
            expect(await audits()).toMatchObject([{ actor_user_id: 202, actor_role: "doctor", action: "schedule.hours_replaced", entity_type: "doctor_profile",
                entity_id: 1, request_id: requestId, metadata: { dayCount: 2, intervalCount: 3, confirmed: false } }]);
        });

        it("should roll back the PUT and keep the previous set when the audit insert fails", async () => {
            await call("put", HOURS, "doctor", { days: [day(2, ["09:00", "10:00"])] });
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_hours_replaced_test CHECK (action <> 'schedule.hours_replaced') NOT VALID");
            try {
                const res = await call("put", HOURS, "doctor", { days: [day(5, ["09:00", "10:00"])] });
                expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
                expect(await liveHours()).toEqual(["2|09:00|10:00"]);
                expect(await ownerDb("working_hours")).toHaveLength(1);
            } finally {
                await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_hours_replaced_test");
            }
        });

        it("should serialize eight concurrent PUTs of one doctor into exactly one request's set", async () => {
            const sets = Array.from({ length: 8 }, (_unused, k) => ({
                days: [day((k % 7) + 1, ...[["08:00", "08:30"], ["09:00", "09:30"], ["10:00", "10:30"]].slice(0, (k % 3) + 1) as Array<[string, string]>)],
            }));
            const expected = sets.map((set) => (set.days[0] as { weekday: number; intervals: Array<{ startTime: string; endTime: string }> })
                .intervals.map((i) => `${(set.days[0] as { weekday: number }).weekday}|${i.startTime}|${i.endTime}`).sort().join(","));
            const responses = await Promise.all(sets.map((set) => call("put", HOURS, "doctor", set)));
            expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));
            const live = (await liveHours()).sort().join(",");
            expect(expected).toContain(live);
            const live2 = await ownerDb("working_hours").whereNull("deleted_at");
            expect(new Set(live2.map((row) => row.weekday)).size).toBe(1);
        });

        it("should make the owner's direct overlapping INSERT fail on the exclusion constraint", async () => {
            await ownerDb("working_hours").insert({ doctor_profile_id: 1, weekday: 1, start_time: "09:00", end_time: "12:00" });
            await expect(ownerDb("working_hours").insert({ doctor_profile_id: 1, weekday: 1, start_time: "11:00", end_time: "13:00" }))
                .rejects.toMatchObject({ code: "23P01", constraint: "excl_working_hours_no_overlap" });
            await expect(ownerDb("working_hours").insert({ doctor_profile_id: 1, weekday: 1, start_time: "12:00", end_time: "13:00" })).resolves.toBeDefined();
            await expect(ownerDb("working_hours").insert({ doctor_profile_id: 1, weekday: 2, start_time: "11:00", end_time: "13:00" })).resolves.toBeDefined();
        });
    });

    // ------------------------------------------------------------------------------------------ exceptions
    describe("exceptions", () => {
        it("should create a single day_off and return the contract shape", async () => {
            const res = await call("post", EXCEPTIONS, "doctor", dayOff(today(3), { reason: REASON }));
            expect(res.status).toBe(201);
            const [required = []] = inlineLists(schemaBlock("ScheduleException"), "required");
            expect(res.body.data).toHaveLength(1);
            expect(Object.keys(res.body.data[0]).sort()).toEqual([...required].sort());
            expect(res.body.data[0]).toMatchObject({ date: today(3), type: "day_off", startTime: null, endTime: null, reason: REASON });
            expect((await liveExceptions()).map((row) => String(row.date).length)).toHaveLength(1);
        });

        it("should create 60 rows and one audit row with count 60 for a 60-date range, and reject 61 dates", async () => {
            const res = await call("post", EXCEPTIONS, "doctor", dayOff(today(1), { endDate: today(60) }));
            expect(res.status).toBe(201); expect(res.body.data).toHaveLength(60);
            expect(res.body.data.map((row: { date: string }) => row.date)).toEqual([...res.body.data.map((row: { date: string }) => row.date)].sort());
            expect(await liveExceptions()).toHaveLength(60);
            const rows = await audits();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ action: "schedule.exception_created", entity_type: "doctor_profile", entity_id: 1,
                metadata: { type: "day_off", fromDate: today(1), toDate: today(60), count: 60 } });
            const tooLong = await call("post", EXCEPTIONS, "doctor", dayOff(today(100), { endDate: today(160) }));
            expect(tooLong.status).toBe(400); expectErrorEnvelope(tooLong.body, "ValidationFailed");
            expect(await liveExceptions()).toHaveLength(60);
        });

        it("should create custom_hours with times and keep 24:00", async () => {
            const res = await call("post", EXCEPTIONS, "doctor", { type: "custom_hours", date: today(2), startTime: "10:00", endTime: "24:00" });
            expect(res.status).toBe(201);
            expect(res.body.data[0]).toMatchObject({ type: "custom_hours", startTime: "10:00", endTime: "24:00", reason: null });
        });

        it.each([
            ["custom_hours with endDate", { type: "custom_hours", startTime: "10:00", endTime: "11:00", endDate: "X" }, "endDate"],
            ["day_off with times", { type: "day_off", startTime: "10:00", endTime: "11:00" }, "startTime"],
            ["custom_hours without times", { type: "custom_hours" }, "startTime"],
            ["custom_hours with end before start", { type: "custom_hours", startTime: "11:00", endTime: "10:00" }, "endTime"],
            ["an unknown type", { type: "holiday" }, "type"],
            ["an impossible date", { type: "day_off", date: "2027-02-30" }, "date"],
            ["a null reason", { type: "day_off", reason: null }, "reason"],
            ["a reason over 500 code points", { type: "day_off", reason: "x".repeat(501) }, "reason"],
            ["endDate before date", { type: "day_off", endDate: "2000-01-01" }, "endDate"],
        ])("should return 400 for %s without creating rows", async (_label, change, field) => {
            const payload: Record<string, unknown> = { date: today(3), ...change };
            if (payload.endDate === "X") payload.endDate = today(4);
            const res = await call("post", EXCEPTIONS, "doctor", payload);
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
            expect(await exceptionRows()).toHaveLength(0);
            expect(await auditActions()).toEqual([]);
        });

        it("should reject a date before today in the doctor's timezone and accept today", async () => {
            const past = await call("post", EXCEPTIONS, "doctor", dayOff(today(-1)));
            expect(past.status).toBe(400); expectErrorEnvelope(past.body, "ValidationFailed");
            expect(past.body.error.details.map((d: { field: string }) => d.field)).toContain("date");
            const rangeStartingInPast = await call("post", EXCEPTIONS, "doctor", dayOff(today(-2), { endDate: today(3) }));
            expect(rangeStartingInPast.status).toBe(400);
            expect(await exceptionRows()).toHaveLength(0);
            expect((await call("post", EXCEPTIONS, "doctor", dayOff(today(0)))).status).toBe(201);
        });

        it("should answer 409 Conflict for the whole request and create no partial rows when one date is taken", async () => {
            await call("post", EXCEPTIONS, "doctor", dayOff(today(8)));
            const res = await call("post", EXCEPTIONS, "doctor", dayOff(today(6), { endDate: today(10) }));
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "Conflict");
            expect(res.body.error.details).toEqual([{ field: "date", issue: "already has a schedule exception" }]);
            expect(JSON.stringify(res.body)).not.toContain(today(8));
            expect(await liveExceptions()).toHaveLength(1);
            expect(await auditActions()).toEqual(["schedule.exception_created"]);
        });

        it("should list from today by default, honour toDate, and reach page 2 on the default (date, id) sort", async () => {
            await ownerDb("schedule_exceptions").insert({ doctor_profile_id: 1, date: today(-5), type: "day_off" });
            for (const offset of [9, 3, 6, 4, 5]) await call("post", EXCEPTIONS, "doctor", dayOff(today(offset)));
            const first = await call("get", `${EXCEPTIONS}?limit=2`, "doctor");
            expect(first.status).toBe(200);
            expect(first.body.data.map((row: { date: string }) => row.date)).toEqual([today(3), today(4)]);
            const meta = expectPaginationMeta(first.body.meta);
            expect(meta).toMatchObject({ hasMore: true, count: 2 }); expect(meta.nextCursor).not.toBeNull();
            const second = await call("get", `${EXCEPTIONS}?limit=2&cursor=${meta.nextCursor}`, "doctor");
            expect(second.body.data.map((row: { date: string }) => row.date)).toEqual([today(5), today(6)]);
            const third = await call("get", `${EXCEPTIONS}?limit=2&cursor=${second.body.meta.nextCursor}`, "doctor");
            expect(third.body.data.map((row: { date: string }) => row.date)).toEqual([today(9)]);
            expect(third.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
            const exact = await call("get", `${EXCEPTIONS}?limit=5`, "doctor");
            expect(exact.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 5 });
            const bounded = await call("get", `${EXCEPTIONS}?toDate=${today(4)}`, "doctor");
            expect(bounded.body.data.map((row: { date: string }) => row.date)).toEqual([today(3), today(4)]);
            const withPast = await call("get", `${EXCEPTIONS}?fromDate=${today(-10)}&toDate=${today(-1)}`, "doctor");
            expect(withPast.body.data.map((row: { date: string }) => row.date)).toEqual([today(-5)]);
        });

        it("should hide deleted rows, reject a malformed cursor and fromDate after toDate", async () => {
            const created = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)));
            await call("delete", `${EXCEPTIONS}/${created.body.data[0].id}`, "doctor");
            expect((await call("get", EXCEPTIONS, "doctor")).body.data).toEqual([]);
            for (const query of ["cursor=!!!", `fromDate=${today(5)}&toDate=${today(4)}`, "fromDate=2027-02-30", "limit=0", "limit=101"]) {
                const res = await call("get", `${EXCEPTIONS}?${query}`, "doctor");
                expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            }
        });

        it("should answer 400 ValidationFailed (not 500) for year 0000 in fromDate, toDate or a forged cursor", async () => {
            for (const query of ["fromDate=0000-01-01", "toDate=0000-01-01", `cursor=${encodeCursor("0000-01-01", 1)}`]) {
                const res = await call("get", `${EXCEPTIONS}?${query}`, "doctor");
                expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            }
        });

        it("should soft-delete with 204, answer 404 for a repeat, audit it, and free the date for a new POST", async () => {
            const created = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)));
            const id = created.body.data[0].id as number;
            const deleted = await call("delete", `${EXCEPTIONS}/${id}`, "doctor");
            expect(deleted.status).toBe(204); expect(deleted.text).toBe("");
            expect((await exceptionRows())[0]?.deleted_at).not.toBeNull();
            const again = await call("delete", `${EXCEPTIONS}/${id}`, "doctor");
            expect(again.status).toBe(404); expectErrorEnvelope(again.body, "NotFound");
            expect((await audits()).filter((row) => row.action === "schedule.exception_deleted")).toMatchObject([
                { entity_type: "schedule_exception", entity_id: id, actor_user_id: 202, metadata: { type: "day_off", date: today(3) } }]);
            expect((await call("post", EXCEPTIONS, "doctor", dayOff(today(3)))).status).toBe(201);
            expect(await liveExceptions()).toHaveLength(1);
        });

        it.each([["maybe"], ["1"], ["TRUE"]])("should return 400 for confirmConflicts=%s on DELETE", async (value) => {
            const created = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)));
            const res = await call("delete", `${EXCEPTIONS}/${created.body.data[0].id}?confirmConflicts=${value}`, "doctor");
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await liveExceptions()).toHaveLength(1);
        });

        it.each([["abc"], ["0"], ["-1"], ["1.5"], ["99999999999999999999"]])("should return 404 for the path id %s", async (id) => {
            for (const [verb, base, payload] of [["delete", EXCEPTIONS, undefined], ["patch", TYPES, { isActive: false }]] as const) {
                const res = await call(verb, `${base}/${id}`, "doctor", payload);
                expect(res.status).toBe(404); expectErrorEnvelope(res.body, "NotFound");
            }
        });

        it("should replay an idempotent POST, reject a changed body with 422 and a non-UUID key with 400", async () => {
            const key = randomUUID(); const headers = { "Idempotency-Key": key };
            const first = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)), headers);
            const replay = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)), headers);
            expect(first.status).toBe(201); expect(replay.status).toBe(201); expect(replay.body).toEqual(first.body);
            expect(await liveExceptions()).toHaveLength(1); expect(await auditActions()).toEqual(["schedule.exception_created"]);
            const changed = await call("post", EXCEPTIONS, "doctor", dayOff(today(4)), headers);
            expect(changed.status).toBe(422); expectErrorEnvelope(changed.body, "IdempotencyConflict");
            const bad = await call("post", EXCEPTIONS, "doctor", dayOff(today(5)), { "Idempotency-Key": "not-a-uuid" });
            expect(bad.status).toBe(400); expectErrorEnvelope(bad.body, "ValidationFailed");
            expect((await call("post", EXCEPTIONS, "doctor", dayOff(today(6)))).status).toBe(201);
        });

        it("should answer 409 with Retry-After when the same key is still in flight", async () => {
            const key = randomUUID(); const payload = dayOff(today(3));
            await redis.set(`idem:POST ${EXCEPTIONS}:user:202:${key}`, inProgressRecord(hashBody(payload)), "PX", 5000);
            const res = await call("post", EXCEPTIONS, "doctor", payload, { "Idempotency-Key": key });
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "Conflict");
            expect(res.headers["retry-after"]).toBe("1");
            expect(await exceptionRows()).toHaveLength(0);
        });

        it("should skip the impact check when deleting a past exception or a day_off", async () => {
            const findAffected = jest.spyOn(provider, "findAffected").mockResolvedValue([5]);
            const past = await ownerDb("schedule_exceptions").insert({ doctor_profile_id: 1, date: today(-3), type: "custom_hours", start_time: "10:00", end_time: "11:00" }).returning("id");
            expect((await call("delete", `${EXCEPTIONS}/${(past[0] as { id: number }).id}`, "doctor")).status).toBe(204);
            const off = await ownerDb("schedule_exceptions").insert({ doctor_profile_id: 1, date: today(3), type: "day_off" }).returning("id");
            expect((await call("delete", `${EXCEPTIONS}/${(off[0] as { id: number }).id}`, "doctor")).status).toBe(204);
            expect(findAffected).not.toHaveBeenCalled();
        });
    });

    // ------------------------------------------------------------------------------------------ conflicts
    describe("conflict flow", () => {
        it("should succeed with confirmConflicts absent or true and write no conflicts_confirmed row under the default provider", async () => {
            expect((await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])] })).status).toBe(200);
            expect((await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "11:00"])], confirmConflicts: true })).status).toBe(200);
            expect((await call("post", EXCEPTIONS, "doctor", dayOff(today(3), { confirmConflicts: true }))).status).toBe(201);
            expect(await auditActions()).not.toContain("schedule.conflicts_confirmed");
        });

        function expectConflictBody(body: { conflicts: { consultationIds: number[]; count: number } }, ids: number[]): void {
            expectErrorEnvelope(body, "ScheduleConflictsUnconfirmed");
            const [required = []] = inlineLists(schemaBlock("ScheduleConflicts"), "required");
            for (const key of required) expect(Object.keys(body)).toContain(key);
            expect(body.conflicts.consultationIds).toEqual(ids);
            expect(body.conflicts.count).toBe(ids.length);
            for (const id of body.conflicts.consultationIds) expect(Number.isInteger(id)).toBe(true);
        }

        it("should return 409 with sorted ids for PUT and change nothing, then apply, flag and audit with confirmConflicts", async () => {
            await call("put", HOURS, "doctor", { days: [day(2, ["09:00", "10:00"])] });
            jest.spyOn(provider, "findAffected").mockResolvedValue([11, 7]);
            const flag = jest.spyOn(provider, "flagAffected").mockResolvedValue();
            const onChange = jest.spyOn(listener, "onScheduleChanged");
            const next = { days: [day(5, ["09:00", "10:00"])] };
            const refused = await call("put", HOURS, "doctor", next);
            expect(refused.status).toBe(409); expectConflictBody(refused.body, [7, 11]);
            expect(await liveHours()).toEqual(["2|09:00|10:00"]);
            expect(await auditActions()).toEqual(["schedule.hours_replaced"]);
            expect(flag).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
            const applied = await call("put", HOURS, "doctor", { ...next, confirmConflicts: true });
            expect(applied.status).toBe(200);
            expect(await liveHours()).toEqual(["5|09:00|10:00"]);
            expect(flag).toHaveBeenCalledWith(expect.anything(), [7, 11], expect.anything());
            const rows = await audits();
            expect(rows.map((row) => row.action)).toEqual(["schedule.hours_replaced", "schedule.conflicts_confirmed", "schedule.hours_replaced"]);
            expect(rows[1]).toMatchObject({ entity_type: "doctor_profile", entity_id: 1, actor_user_id: 202,
                metadata: { change: "working_hours", count: 2, consultationIds: "7,11", idsTruncated: false } });
            expect(rows[2]?.metadata).toMatchObject({ confirmed: true });
            expect(onChange).toHaveBeenCalledTimes(1);
        });

        it("should return 409 for POST exceptions with no rows created, then create and audit with confirmConflicts", async () => {
            jest.spyOn(provider, "findAffected").mockResolvedValue([3]);
            jest.spyOn(provider, "flagAffected").mockResolvedValue();
            const refused = await call("post", EXCEPTIONS, "doctor", dayOff(today(3), { endDate: today(5) }));
            expect(refused.status).toBe(409); expectConflictBody(refused.body, [3]);
            expect(await exceptionRows()).toHaveLength(0); expect(await auditActions()).toEqual([]);
            const applied = await call("post", EXCEPTIONS, "doctor", dayOff(today(3), { endDate: today(5), confirmConflicts: true }));
            expect(applied.status).toBe(201); expect(applied.body.data).toHaveLength(3);
            expect(await auditActions()).toEqual(["schedule.conflicts_confirmed", "schedule.exception_created"]);
        });

        it("should return 409 for DELETE of a custom_hours exception and keep it live, then delete and audit with confirmConflicts=true", async () => {
            const created = await call("post", EXCEPTIONS, "doctor", { type: "custom_hours", date: today(3), startTime: "10:00", endTime: "11:00" });
            const id = created.body.data[0].id as number;
            jest.spyOn(provider, "findAffected").mockResolvedValue([21, 4]);
            const flag = jest.spyOn(provider, "flagAffected").mockResolvedValue();
            const refused = await call("delete", `${EXCEPTIONS}/${id}`, "doctor");
            expect(refused.status).toBe(409); expectConflictBody(refused.body, [4, 21]);
            expect(await liveExceptions()).toHaveLength(1);
            const refusedExplicit = await call("delete", `${EXCEPTIONS}/${id}?confirmConflicts=false`, "doctor");
            expect(refusedExplicit.status).toBe(409);
            const applied = await call("delete", `${EXCEPTIONS}/${id}?confirmConflicts=true`, "doctor");
            expect(applied.status).toBe(204);
            expect(await liveExceptions()).toHaveLength(0);
            expect(flag).toHaveBeenCalledTimes(1);
            expect(await auditActions()).toEqual(["schedule.exception_created", "schedule.conflicts_confirmed", "schedule.exception_deleted"]);
        });

        it("should truncate the audited ids at 20 while the 409 body lists all of them", async () => {
            const ids = Array.from({ length: 25 }, (_unused, i) => i + 1);
            jest.spyOn(provider, "findAffected").mockResolvedValue(ids);
            jest.spyOn(provider, "flagAffected").mockResolvedValue();
            const refused = await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])] });
            expect(refused.body.conflicts.consultationIds).toEqual(ids);
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])], confirmConflicts: true });
            const row = (await audits()).find((entry) => entry.action === "schedule.conflicts_confirmed");
            expect(row?.metadata).toMatchObject({ count: 25, consultationIds: ids.slice(0, 20).join(","), idsTruncated: true });
        });

        it("should roll back the write when flagging fails after the impact check", async () => {
            jest.spyOn(provider, "findAffected").mockResolvedValue([1]);
            jest.spyOn(provider, "flagAffected").mockRejectedValue(new Error("flag failed"));
            const res = await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])], confirmConflicts: true });
            expect(res.status).toBe(500);
            expect(await liveHours()).toEqual([]); expect(await auditActions()).toEqual([]);
        });
    });

    // ------------------------------------------------------------------------------------------ listener
    describe("change listener", () => {
        it("should be called once per real change with the right kind and never for no-ops or failures", async () => {
            const onChange = jest.spyOn(listener, "onScheduleChanged");
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])] });
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])] });
            const created = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)));
            await call("post", EXCEPTIONS, "doctor", dayOff(today(3)));
            await call("post", EXCEPTIONS, "doctor", { type: "bogus", date: today(3) });
            await call("delete", `${EXCEPTIONS}/${created.body.data[0].id}`, "doctor");
            const type = await call("post", TYPES, "doctor", typeBody());
            await call("patch", `${TYPES}/${type.body.data.id}`, "doctor", { name: TYPE_NAME });
            await call("patch", `${TYPES}/${type.body.data.id}`, "doctor", { price: 1 });
            const calls = onChange.mock.calls as unknown as Array<[{ kind: string }]>;
            expect(calls.map((callArgs) => callArgs[0].kind)).toEqual(["working_hours", "schedule_exception", "schedule_exception", "consultation_type", "consultation_type"]);
            expect(calls[0]?.[0]).toEqual({ doctorProfileId: 1, doctorUserId: 202, kind: "working_hours" });
        });

        it("should not be called when the write rolls back on a failed audit insert", async () => {
            const onChange = jest.spyOn(listener, "onScheduleChanged");
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_type_created_test CHECK (action <> 'consultation_type.created') NOT VALID");
            try {
                const res = await call("post", TYPES, "doctor", typeBody());
                expect(res.status).toBe(500);
                expect(await typeRows()).toHaveLength(0); expect(onChange).not.toHaveBeenCalled();
            } finally {
                await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_type_created_test");
            }
        });

        it("should keep the 2xx response and the committed rows when the listener rejects", async () => {
            jest.spyOn(listener, "onScheduleChanged").mockRejectedValue(new Error("cache down"));
            const res = await call("post", EXCEPTIONS, "doctor", dayOff(today(3)));
            expect(res.status).toBe(201); expect(await liveExceptions()).toHaveLength(1);
            expect((await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])] })).status).toBe(200);
        });
    });

    // ------------------------------------------------------------------------------------------ consultation types
    describe("consultation types", () => {
        it("should create an active type, return the contract shape and audit numeric fields only", async () => {
            const res = await call("post", TYPES, "doctor", typeBody());
            expect(res.status).toBe(201);
            const [required = []] = inlineLists(schemaBlock("ConsultationType"), "required");
            expect(Object.keys(res.body.data).sort()).toEqual([...required].sort());
            expect(res.body.data).toMatchObject({ name: TYPE_NAME, durationMinutes: 30, price: 15000, currency: "EGP", isActive: true });
            expect(await audits()).toMatchObject([{ action: "consultation_type.created", entity_type: "consultation_type", entity_id: res.body.data.id,
                actor_user_id: 202, metadata: { durationMinutes: 30, price: 15000, currency: "EGP" } }]);
        });

        it("should return 409 for a duplicate live name with field name, but allow the same name for another doctor", async () => {
            await seedProfile(204);
            await call("post", TYPES, "doctor", typeBody());
            const dup = await call("post", TYPES, "doctor", typeBody());
            expect(dup.status).toBe(409); expectErrorEnvelope(dup.body, "Conflict");
            expect(dup.body.error.details).toEqual([{ field: "name", issue: "is already used by another consultation type" }]);
            expect((await call("post", TYPES, "otherDoctor", typeBody())).status).toBe(201);
            expect((await call("post", TYPES, "doctor", typeBody({ name: "synthetic visit 001" }))).status).toBe(201);
            expect(await typeRows(1)).toHaveLength(2);
        });

        it("should accept the 20th type and answer 409 consultationTypes for the 21st, counting inactive types", async () => {
            for (let index = 1; index <= 19; index += 1) expect((await call("post", TYPES, "doctor", typeBody({ name: `Synthetic Visit ${100 + index}` }))).status).toBe(201);
            const twentieth = await call("post", TYPES, "doctor", typeBody({ name: "Synthetic Visit 200" }));
            expect(twentieth.status).toBe(201);
            await call("patch", `${TYPES}/${twentieth.body.data.id}`, "doctor", { isActive: false });
            const twentyFirst = await call("post", TYPES, "doctor", typeBody({ name: "Synthetic Visit 201" }));
            expect(twentyFirst.status).toBe(409); expectErrorEnvelope(twentyFirst.body, "Conflict");
            expect(twentyFirst.body.error.details[0].field).toBe("consultationTypes");
            expect(await typeRows()).toHaveLength(20);
        });

        it("should return 400 for a currency outside ALLOWED_CURRENCIES or different from the profile currency (create and PATCH)", async () => {
            const notAllowed = await call("post", TYPES, "doctor", typeBody({ currency: "USD" }));
            expect(notAllowed.status).toBe(400); expect(notAllowed.body.error.details[0].field).toBe("currency");
            const created = await call("post", TYPES, "doctor", typeBody());
            const patchNotAllowed = await call("patch", `${TYPES}/${created.body.data.id}`, "doctor", { currency: "USD" });
            expect(patchNotAllowed.status).toBe(400); expect(patchNotAllowed.body.error.details[0].field).toBe("currency");
            await ownerDb("doctor_profiles").where("id", 1).update({ currency: "USD" });
            const mismatch = await call("post", TYPES, "doctor", typeBody({ name: "Synthetic Visit 002" }));
            expect(mismatch.status).toBe(400); expect(mismatch.body.error.details[0].field).toBe("currency");
            const patchMismatch = await call("patch", `${TYPES}/${created.body.data.id}`, "doctor", { currency: "EGP" });
            expect(patchMismatch.status).toBe(400);
            expect(await typeRows()).toHaveLength(1);
        });

        it.each([
            ["price 2147483648", { price: 2147483648 }, "price"], ["price -1", { price: -1 }, "price"], ["duration 4", { durationMinutes: 4 }, "durationMinutes"],
            ["duration 241", { durationMinutes: 241 }, "durationMinutes"], ["a one-character name", { name: "a" }, "name"],
            ["a whitespace name", { name: "     " }, "name"], ["a numeric price string", { price: "10" }, "price"],
        ])("should return 400 and never 500 for %s", async (_label, change, field) => {
            const res = await call("post", TYPES, "doctor", typeBody(change));
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
            expect(await typeRows()).toHaveLength(0);
        });

        it("should accept the maximum price and the boundary durations", async () => {
            expect((await call("post", TYPES, "doctor", typeBody({ name: "Synthetic Max", price: 2147483647, durationMinutes: 240 }))).status).toBe(201);
            expect((await call("post", TYPES, "doctor", typeBody({ name: "Synthetic Min", price: 0, durationMinutes: 5 }))).status).toBe(201);
        });

        it("should rename, reprice, deactivate and reactivate with PATCH and audit only the changed wire names", async () => {
            const created = (await call("post", TYPES, "doctor", typeBody())).body.data;
            const renamed = await call("patch", `${TYPES}/${created.id}`, "doctor", { name: "Synthetic Renamed", price: 100 });
            expect(renamed.status).toBe(200); expect(renamed.body.data).toMatchObject({ name: "Synthetic Renamed", price: 100, isActive: true });
            expect(new Date(renamed.body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
            expect((await call("patch", `${TYPES}/${created.id}`, "doctor", { isActive: false })).body.data.isActive).toBe(false);
            expect((await call("patch", `${TYPES}/${created.id}`, "doctor", { isActive: true })).body.data.isActive).toBe(true);
            const rows = (await audits()).filter((row) => row.action === "consultation_type.updated");
            expect(rows.map((row) => row.metadata)).toEqual([{ changedFields: "name,price" }, { changedFields: "isActive" }, { changedFields: "isActive" }]);
            expect(JSON.stringify(rows)).not.toContain("Synthetic Renamed");
        });

        it.each([["an empty body", {}, "body"], ["a null name", { name: null }, "name"], ["a null isActive", { isActive: null }, "isActive"],
            ["a string isActive", { isActive: "false" }, "isActive"], ["an unknown member", { userId: 1 }, "userId"]])("should return 400 for PATCH with %s", async (_label, payload, field) => {
            const created = (await call("post", TYPES, "doctor", typeBody())).body.data;
            const res = await call("patch", `${TYPES}/${created.id}`, "doctor", payload);
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
        });

        it("should answer a no-op PATCH with 200, unchanged updated_at and no audit row", async () => {
            const created = (await call("post", TYPES, "doctor", typeBody())).body.data;
            const before = (await typeRows())[0]?.updated_at;
            const res = await call("patch", `${TYPES}/${created.id}`, "doctor", { name: TYPE_NAME, price: 15000, isActive: true });
            expect(res.status).toBe(200); expect(res.body.data).toEqual(created);
            expect((await typeRows())[0]?.updated_at).toEqual(before);
            expect(await auditActions()).toEqual(["consultation_type.created"]);
        });

        it("should answer 409 when renaming to an existing live name and 404 for an absent id", async () => {
            await call("post", TYPES, "doctor", typeBody());
            const other = (await call("post", TYPES, "doctor", typeBody({ name: "Synthetic Visit 002" }))).body.data;
            const conflict = await call("patch", `${TYPES}/${other.id}`, "doctor", { name: TYPE_NAME });
            expect(conflict.status).toBe(409); expectErrorEnvelope(conflict.body, "Conflict");
            expect((await call("patch", `${TYPES}/9999`, "doctor", { price: 1 })).status).toBe(404);
        });

        it("should filter by isActive and reach page 2 on the default id sort", async () => {
            const ids: number[] = [];
            for (let index = 1; index <= 5; index += 1) ids.push((await call("post", TYPES, "doctor", typeBody({ name: `Synthetic Visit 30${index}` }))).body.data.id);
            await call("patch", `${TYPES}/${ids[1]}`, "doctor", { isActive: false });
            const first = await call("get", `${TYPES}?limit=2`, "doctor");
            expect(first.body.data.map((row: { id: number }) => row.id)).toEqual([ids[0], ids[1]]);
            const meta = expectPaginationMeta(first.body.meta);
            expect(meta).toMatchObject({ hasMore: true, count: 2 });
            const second = await call("get", `${TYPES}?limit=2&cursor=${meta.nextCursor}`, "doctor");
            expect(second.body.data.map((row: { id: number }) => row.id)).toEqual([ids[2], ids[3]]);
            const third = await call("get", `${TYPES}?limit=2&cursor=${second.body.meta.nextCursor}`, "doctor");
            expect(third.body.data.map((row: { id: number }) => row.id)).toEqual([ids[4]]);
            expect(third.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
            const inactive = await call("get", `${TYPES}?isActive=false`, "doctor");
            expect(inactive.body.data.map((row: { id: number }) => row.id)).toEqual([ids[1]]);
            expect((await call("get", `${TYPES}?isActive=true`, "doctor")).body.data).toHaveLength(4);
            for (const query of ["isActive=yes", "cursor=!!!", "limit=0"]) expect((await call("get", `${TYPES}?${query}`, "doctor")).status).toBe(400);
        });

        it("should replay an idempotent create, reject a changed body with 422 and keep a single row", async () => {
            const headers = { "Idempotency-Key": randomUUID() };
            const first = await call("post", TYPES, "doctor", typeBody(), headers);
            const replay = await call("post", TYPES, "doctor", typeBody(), headers);
            expect(replay.status).toBe(201); expect(replay.body).toEqual(first.body);
            expect(await typeRows()).toHaveLength(1); expect(await auditActions()).toEqual(["consultation_type.created"]);
            const changed = await call("post", TYPES, "doctor", typeBody({ price: 1 }), headers);
            expect(changed.status).toBe(422); expectErrorEnvelope(changed.body, "IdempotencyConflict");
        });

        it("should not leak soft-deleted types into lists or the name uniqueness", async () => {
            const created = (await call("post", TYPES, "doctor", typeBody())).body.data;
            await ownerDb("consultation_types").where("id", created.id).update({ deleted_at: new Date() });
            expect((await call("get", TYPES, "doctor")).body.data).toEqual([]);
            expect((await call("patch", `${TYPES}/${created.id}`, "doctor", { price: 1 })).status).toBe(404);
            expect((await call("post", TYPES, "doctor", typeBody())).status).toBe(201);
        });
    });

    // ------------------------------------------------------------------------------------------ rate limits
    describe("rate limits", () => {
        it("should answer the 31st write in a minute with 429 and record the per-user key", async () => {
            const payload = { days: [day(1, ["09:00", "10:00"])] };
            for (let index = 0; index < 30; index += 1) expect((await call("put", HOURS, "doctor", payload)).status).toBe(200);
            const limited = await call("put", HOURS, "doctor", payload);
            expect(limited.status).toBe(429); expectErrorEnvelope(limited.body, "RateLimited");
            expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expect(await redis.exists("rl:schedules-write-user:202")).toBe(1);
            expect((await call("post", TYPES, "doctor", typeBody())).status).toBe(429);
            expect((await call("get", HOURS, "doctor")).status).toBe(200);
        });

        it("should answer the 121st read in a minute with 429 and record the per-user key", async () => {
            for (let index = 0; index < 120; index += 1) expect((await call("get", HOURS, "doctor")).status).toBe(200);
            const limited = await call("get", HOURS, "doctor");
            expect(limited.status).toBe(429); expectErrorEnvelope(limited.body, "RateLimited");
            expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expect(await redis.exists("rl:schedules-read-user:202")).toBe(1);
        });

        it("should not spend another doctor's budget", async () => {
            await seedProfile(204);
            for (let index = 0; index < 31; index += 1) await call("put", HOURS, "doctor", { days: [] });
            expect((await call("put", HOURS, "otherDoctor", { days: [] })).status).toBe(200);
        });
    });

    // ------------------------------------------------------------------------------------------ grants and schema
    describe("grants and schema", () => {
        it.each(["working_hours", "schedule_exceptions", "consultation_types"])("should deny DELETE and TRUNCATE on %s to care_app but allow SELECT", async (table) => {
            await expect(db.raw(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
            await expect(db.raw(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: "42501" });
            await expect(db(table).count()).resolves.toBeDefined();
        });

        it("should reject invalid working_hours rows with the named constraint", async () => {
            const base = { doctor_profile_id: 1, weekday: 1, start_time: "09:00", end_time: "10:00" };
            for (const [change, constraint] of [
                [{ weekday: 0 }, "chk_working_hours_weekday"], [{ weekday: 8 }, "chk_working_hours_weekday"],
                [{ end_time: "09:00" }, "chk_working_hours_time_order"], [{ end_time: "08:00" }, "chk_working_hours_time_order"],
                [{ end_time: "10:00:30" }, "chk_working_hours_whole_minutes"],
            ] as const) await expect(ownerDb("working_hours").insert({ ...base, ...change })).rejects.toMatchObject({ code: "23514", constraint });
            await expect(ownerDb("working_hours").insert({ ...base, start_time: "00:00", end_time: "24:00" })).resolves.toBeDefined();
        });

        it("should reject invalid schedule_exceptions rows and enforce the live-date unique index", async () => {
            const base = { doctor_profile_id: 1, date: today(5) };
            for (const [row, constraint] of [
                [{ type: "day_off", start_time: "10:00", end_time: "11:00" }, "chk_schedule_exceptions_shape"],
                [{ type: "custom_hours" }, "chk_schedule_exceptions_shape"],
                [{ type: "custom_hours", start_time: "11:00", end_time: "10:00" }, "chk_schedule_exceptions_shape"],
                [{ type: "custom_hours", start_time: "10:00:30", end_time: "11:00" }, "chk_schedule_exceptions_whole_minutes"],
            ] as const) await expect(ownerDb("schedule_exceptions").insert({ ...base, ...row })).rejects.toMatchObject({ code: "23514", constraint });
            const [first] = await ownerDb("schedule_exceptions").insert({ ...base, type: "day_off" }).returning("id");
            await expect(ownerDb("schedule_exceptions").insert({ ...base, type: "day_off" })).rejects.toMatchObject({ code: "23505", constraint: "uq_schedule_exceptions_doctor_profile_id_date" });
            await ownerDb("schedule_exceptions").where("id", (first as { id: number }).id).update({ deleted_at: new Date() });
            await expect(ownerDb("schedule_exceptions").insert({ ...base, type: "day_off" })).resolves.toBeDefined();
        });

        it("should reject invalid consultation_types rows and enforce the live-name unique index", async () => {
            const base = { doctor_profile_id: 1, name: "Synthetic Row", duration_minutes: 30, price: 1, currency: "EGP", is_active: true };
            for (const [change, constraint] of [
                [{ duration_minutes: 4 }, "chk_consultation_types_duration"], [{ duration_minutes: 241 }, "chk_consultation_types_duration"],
                [{ price: -1 }, "chk_consultation_types_price"], [{ currency: "egp" }, "chk_consultation_types_currency"],
                [{ name: "a" }, "chk_consultation_types_name_length"],
            ] as const) await expect(ownerDb("consultation_types").insert({ ...base, ...change })).rejects.toMatchObject({ code: "23514", constraint });
            const [first] = await ownerDb("consultation_types").insert(base).returning("id");
            await expect(ownerDb("consultation_types").insert(base)).rejects.toMatchObject({ code: "23505", constraint: "uq_consultation_types_doctor_profile_id_name" });
            await ownerDb("consultation_types").where("id", (first as { id: number }).id).update({ deleted_at: new Date() });
            await expect(ownerDb("consultation_types").insert(base)).resolves.toBeDefined();
        });

        it("should keep the foreign keys restrictive", async () => {
            await ownerDb("working_hours").insert({ doctor_profile_id: 1, weekday: 1, start_time: "09:00", end_time: "10:00" });
            await expect(ownerDb("working_hours").insert({ doctor_profile_id: 9999, weekday: 1, start_time: "09:00", end_time: "10:00" }))
                .rejects.toMatchObject({ code: "23503", constraint: "fk_working_hours_doctor_profile_id" });
            await expect(ownerDb("doctor_profiles").where("id", 1).del()).rejects.toMatchObject({
                code: expect.stringMatching(/^(23001|23503)$/), // restrict_violation or foreign_key_violation, by PG version
                constraint: expect.stringMatching(/^fk_.+_doctor_profile_id$/), // whichever child table PG checks first
            });
        });
    });

    // ------------------------------------------------------------------------------------------ EXPLAIN
    describe("query plans", () => {
        async function plan(build: (conn: typeof db) => { toQuery(): string }): Promise<string> {
            return db.transaction(async (trx) => {
                await trx.raw("SET LOCAL enable_seqscan = off");
                const result = await trx.raw<{ rows: Array<Record<string, string>> }>(`EXPLAIN ${build(trx).toQuery()}`);
                return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
            });
        }
        beforeEach(async () => {
            await ownerDb("working_hours").insert({ doctor_profile_id: 1, weekday: 1, start_time: "09:00", end_time: "10:00" });
            await ownerDb("schedule_exceptions").insert({ doctor_profile_id: 1, date: today(2), type: "day_off" });
            await ownerDb("consultation_types").insert({ doctor_profile_id: 1, name: "Synthetic Plan", duration_minutes: 30, price: 1, currency: "EGP", is_active: true });
            await ownerDb.raw("ANALYZE working_hours; ANALYZE schedule_exceptions; ANALYZE consultation_types");
        });

        it("should serve listLiveHours from idx_working_hours_doctor_profile_id", async () => {
            expect(await plan((conn) => listLiveHoursQuery(1, conn))).toContain("idx_working_hours_doctor_profile_id");
        });
        it("should serve listExceptionsPage from uq_schedule_exceptions_doctor_profile_id_date", async () => {
            expect(await plan((conn) => listExceptionsPageQuery(1, { fromDate: today(0), toDate: null, after: { sortValue: today(1), id: 1 }, fetch: 21 }, conn)))
                .toContain("uq_schedule_exceptions_doctor_profile_id_date");
        });
        // Spec 8 names uq_consultation_types_doctor_profile_id_name, but the query orders by id and the planner may
        // legitimately walk the primary key with a profile filter on a <= 20-row set; either is an index scan, never a seq scan.
        it("should serve listTypesPage from an index scan of consultation_types", async () => {
            const text = await plan((conn) => listTypesPageQuery(1, { isActive: null, afterId: 0, fetch: 21 }, conn));
            expect(text).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
            expect(text).not.toContain("Seq Scan");
            expect(text).toMatch(/consultation_types_pkey|uq_consultation_types_doctor_profile_id_name/);
        });
        it("should serve hasActiveType from idx_consultation_types_doctor_profile_id_active", async () => {
            expect(await plan((conn) => hasActiveTypeQuery(1, conn))).toContain("idx_consultation_types_doctor_profile_id_active");
        });
    });

    // ------------------------------------------------------------------------------------------ logs and contract
    it("should keep tokens, exception reasons and type names out of logs, audit metadata and unexpected route labels", async () => {
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
        const capture = captureLogs();
        try {
            await call("put", HOURS, "doctor", { days: [day(1, ["09:00", "10:00"])] });
            const created = await call("post", EXCEPTIONS, "doctor", dayOff(today(3), { reason: REASON }));
            await call("get", EXCEPTIONS, "doctor");
            const type = await call("post", TYPES, "doctor", typeBody());
            await call("patch", `${TYPES}/${type.body.data.id}`, "doctor", { name: "Synthetic Visit 001 b" });
            await call("get", TYPES, "doctor");
            jest.spyOn(listener, "onScheduleChanged").mockRejectedValue(new Error(`boom ${REASON}`));
            await call("post", EXCEPTIONS, "doctor", dayOff(today(4), { reason: REASON }));
            await call("delete", `${EXCEPTIONS}/${created.body.data[0].id}`, "doctor");
            await call("post", EXCEPTIONS, "doctor", dayOff(today(3), { reason: REASON, startTime: "10:00" }));
        } finally { capture.restore(); jest.restoreAllMocks(); }
        expectNoSensitiveStrings(capture, [REASON, TYPE_NAME, ...Object.values(tokens), "Authorization", "Bearer "]);
        expect(capture.text()).toContain("schedule_change_listener_failed");
        const completed = capture.lines().filter((line) => line.message === "request_completed");
        expect(completed.length).toBeGreaterThanOrEqual(8);
        for (const line of completed) expect(ROUTE_LABELS).toContain(line.route);
        const metadata = JSON.stringify((await audits()).map((row) => row.metadata));
        expect(metadata).not.toContain(REASON); expect(metadata).not.toContain("Synthetic Visit");
        expect(await auditActions()).toEqual(expect.arrayContaining(["schedule.hours_replaced", "schedule.exception_created", "schedule.exception_deleted", "consultation_type.created", "consultation_type.updated"]));
    });

    it("should declare every observed response status in the contract and keep idempotency on exactly the two POSTs", () => {
        expect(seen.size).toBeGreaterThanOrEqual(8);
        for (const [key, statuses] of seen) {
            const [method = "", path = ""] = key.split(" ");
            const declared = contractResponseCodes(path, method as Verb).map(Number);
            for (const status of statuses) expect(declared).toContain(status);
        }
        const mine = idempotentOperations().filter((operation) => [EXCEPTIONS, TYPES].includes(operation.path));
        expect(mine.map((operation) => `${operation.method} ${operation.path}`).sort()).toEqual([`POST ${TYPES}`, `POST ${EXCEPTIONS}`].sort());
    });
});
