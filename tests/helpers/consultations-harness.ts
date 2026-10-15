import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { DateTime } from "luxon";
import request from "supertest";
import type { Test } from "supertest";
import { AdminDoctorsController } from "../../src/app/admin-doctors/controller/admin-doctors.controller";
import { AdminDoctorsService } from "../../src/app/admin-doctors/service/admin-doctors.service";
import { ConsultationsController } from "../../src/app/consultations/controller/consultations.controller";
import { ConsultationQueriesService } from "../../src/app/consultations/service/consultation-queries.service";
import { ConsultationsService } from "../../src/app/consultations/service/consultations.service";
import { SessionsController } from "../../src/app/sessions/controller/sessions.controller";
import { SessionQueriesService } from "../../src/app/sessions/service/session-queries.service";
import { SessionsService } from "../../src/app/sessions/service/sessions.service";
import { IdentitySyncService } from "../../src/app/identity-sync/service/identity-sync.service";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { redis } from "../../src/lib/redis/redis";
import type { Clock } from "../../src/lib/types/types";
import { buildTestApps } from "./app";
import { closeDb, ownerDb, truncateAll } from "./db";
import { FakeIdentityServer } from "./fake-identity-server";
import { buildFakeJwksWiring, startFakeJwks } from "./fake-jwks";
import { closeRedis, ensureRedisReady, flushByPrefix } from "./redis";
import { StubVideoProvider } from "./stub-video-provider";
import { signUserToken } from "./tokens";
import type { FakeJwks, FakeJwksWiring } from "./types";

export const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
export const REASON = "SYNTHETIC-REASON-4417";
export const ALLERGEN = "SYNTHETIC-ALLERGEN-5521";
export const DOCTOR = 202;
export const OTHER_DOCTOR = 204;
export const PATIENT = 101;
export const OTHER_PATIENT = 102;
export const ADMIN = 303;

export type Actor = "patient" | "otherPatient" | "unverified" | "suspendedPatient" | "doctor" | "otherDoctor" | "suspendedToken" | "admin";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The registered `Clock`: real time until a test freezes it (DST scenarios), real time again after `release`. */
export class ControlledClock implements Clock {
    private fixed: number | undefined;
    now = (): number => this.fixed ?? Date.now();
    freeze(timestamp: number): void { this.fixed = timestamp; }
    release(): void { this.fixed = undefined; }
}

/** Doctor-local wall time `days` from today at `HH:mm` as ISO-8601 with offset (real time). */
export function localStart(days: number, time: string, zone = "Africa/Cairo"): string {
    const [hour = 0, minute = 0] = time.split(":").map(Number);
    return DateTime.now().setZone(zone).plus({ days }).set({ hour, minute, second: 0, millisecond: 0 }).toISO({ suppressMilliseconds: true }) ?? "";
}
export const bookingBody = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    doctorId: DOCTOR, typeId: 1, startsAt: localStart(3, "10:00"), complaintText: COMPLAINT, patientTimezone: "America/New_York", ...changes,
});

export interface ConsultationsHarness {
    clock: ControlledClock;
    identityServer: FakeIdentityServer;
    tokens: Record<Actor, string>;
    /** The video provider bound for the app under test (system-external): call log plus failing/slow modes; reset before each test. */
    video: StubVideoProvider;
    app(): Express;
    call(verb: "get" | "post" | "patch" | "put", path: string, actor?: Actor, payload?: object, headers?: Record<string, string>): Test;
    write(verb: "post" | "patch", path: string, actor: Actor, payload: object, key?: string): Test;
    /** A signed token for an ad hoc principal (more patients than the fixed actors). */
    signFor(userId: number, role?: "patient" | "doctor" | "admin", status?: "active" | "pending" | "rejected" | "suspended"): Promise<string>;
    /** Like `call` with a raw bearer token. */
    callWith(token: string, verb: "get" | "post" | "patch" | "put", path: string, payload?: object, headers?: Record<string, string>): Test;
    book(actor?: Actor, payload?: object, key?: string): Test;
    reschedule(id: number, actor: Actor, payload: object, key?: string): Test;
    cancel(id: number, actor: Actor, payload?: object, key?: string): Test;
    seedDoctor(userId: number, changes?: Record<string, unknown>, shape?: { timezone?: string; start?: string; end?: string }): Promise<number>;
    seedConsultation(changes?: Record<string, unknown>): Promise<number>;
    consultationRows(): Promise<Array<Record<string, any>>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    outbox(): Promise<Array<Record<string, any>>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    audits(...actions: string[]): Promise<Array<Record<string, any>>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    resetRateLimits(): Promise<void>;
}

/**
 * Real routes, real services, real Postgres and Redis. Only Identity is faked (a contract-based HTTP server) and the
 * `Clock` token is replaceable. Registers its own hooks, so call it inside `describe`.
 */
export function useConsultationsHarness(suite: string): ConsultationsHarness {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    let identity: IdentityClient;
    const clock = new ControlledClock();
    const identityServer = new FakeIdentityServer();
    const tokens = {} as Record<Actor, string>;
    const video = new StubVideoProvider(getEnv().VIDEO_PROVIDER_KEY);
    const previous: Array<{ token: symbol; value: unknown }> = [];

    const call: ConsultationsHarness["call"] = (verb, path, actor, payload, headers = {}) => {
        let test = request(app)[verb](path).set(headers);
        if (actor !== undefined) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload !== undefined) test = test.send(payload);
        return test;
    };
    const write: ConsultationsHarness["write"] = (verb, path, actor, payload, key = randomUUID()) => call(verb, path, actor, payload, { "Idempotency-Key": key });

    const harness: ConsultationsHarness = {
        clock, identityServer, tokens, video, call, write,
        signFor: (userId, role = "patient", status = "active") => signUserToken(fake.key(suite), { sub: String(userId), role, status, ev: true }),
        callWith: (token, verb, path, payload, headers = {}) => {
            let test = request(app)[verb](path).set(headers).set("Authorization", `Bearer ${token}`);
            if (payload !== undefined) test = test.send(payload);
            return test;
        },
        app: () => app,
        book: (actor = "patient", payload = bookingBody(), key) => write("post", "/api/consultations", actor, payload, key),
        reschedule: (id, actor, payload, key) => write("patch", `/api/consultations/${id}/reschedule`, actor, payload, key),
        cancel: (id, actor, payload = {}, key) => write("patch", `/api/consultations/${id}/cancel`, actor, payload, key),
        async seedDoctor(userId, changes = {}, shape = {}) {
            const rows = await ownerDb("doctor_profiles").insert({
                user_id: userId, headline: "Synthetic headline", years_experience: 5, consultation_fee: 15000, currency: "EGP", default_slot_minutes: 30,
                timezone: shape.timezone ?? "Africa/Cairo", is_accepting_patients: true, verification_status: "approved", identity_sync_status: "synced",
                decided_at: new Date(), ...changes,
            }).returning("id");
            const profileId = (rows[0] as { id: number }).id;
            await ownerDb("working_hours").insert([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
                doctor_profile_id: profileId, weekday, start_time: shape.start ?? "09:00", end_time: shape.end ?? "17:00" })));
            await ownerDb("consultation_types").insert({ doctor_profile_id: profileId, name: "Synthetic Visit", duration_minutes: 30, price: 15000, currency: "EGP", is_active: true });
            return profileId;
        },
        async seedConsultation(changes = {}) {
            const start = Date.now() + 3 * DAY;
            const rows = await ownerDb("consultations").insert({
                doctor_user_id: DOCTOR, patient_user_id: PATIENT, consultation_type_id: 1, starts_at: new Date(start), ends_at: new Date(start + 30 * MINUTE),
                status: "booked", complaint_text: COMPLAINT, patient_timezone: "UTC", price: 15000, currency: "EGP", idempotency_key: randomUUID(),
                request_hash: "a".repeat(64), ...changes,
            }).returning("id");
            return (rows[0] as { id: number }).id;
        },
        consultationRows: () => ownerDb("consultations").select("*").orderBy("id"),
        outbox: () => ownerDb("notification_outbox").select("*").orderBy("id"),
        audits: (...actions) => ownerDb("audit_logs").select("actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata")
            .whereIn("action", actions).orderBy("id"),
        resetRateLimits: () => flushByPrefix(["rl:"]),
    };

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks([suite]);
        wiring = await buildFakeJwksWiring(fake);
        const url = await identityServer.start();
        identity = new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis, sleep: () => Promise.resolve() });
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier, TOKENS.IDENTITY_CLIENT, TOKENS.Clock, TOKENS.IdentitySyncService, TOKENS.AdminDoctorsService,
            TOKENS.AdminDoctorsController, TOKENS.ConsultationsService, TOKENS.ConsultationQueriesService, TOKENS.ConsultationsController,
            TOKENS.VideoProvider, TOKENS.SessionsService, TOKENS.SessionQueriesService, TOKENS.SessionsController])
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        container.registerInstance(TOKENS.IDENTITY_CLIENT, identity);
        container.registerInstance(TOKENS.Clock, clock);
        // Boot-time singletons hold the boot-time Identity client and clock: rebuild every consumer on the test doubles.
        container.registerSingleton(TOKENS.IdentitySyncService, IdentitySyncService);
        container.registerSingleton(TOKENS.AdminDoctorsService, AdminDoctorsService);
        container.registerSingleton(TOKENS.AdminDoctorsController, AdminDoctorsController);
        container.registerSingleton(TOKENS.ConsultationsService, ConsultationsService);
        container.registerSingleton(TOKENS.ConsultationQueriesService, ConsultationQueriesService);
        container.registerSingleton(TOKENS.ConsultationsController, ConsultationsController);
        // Sessions hold the clock and the Identity client too; the provider is external, so the stub takes its place.
        container.registerInstance(TOKENS.VideoProvider, video);
        container.registerSingleton(TOKENS.SessionsService, SessionsService);
        container.registerSingleton(TOKENS.SessionQueriesService, SessionQueriesService);
        container.registerSingleton(TOKENS.SessionsController, SessionsController);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "doctor" | "patient" | "admin", "active" | "suspended", boolean]> = [
            ["patient", String(PATIENT), "patient", "active", true], ["otherPatient", String(OTHER_PATIENT), "patient", "active", true],
            ["unverified", "103", "patient", "active", false], ["suspendedPatient", "104", "patient", "suspended", true],
            ["doctor", String(DOCTOR), "doctor", "active", true], ["otherDoctor", String(OTHER_DOCTOR), "doctor", "active", true],
            ["suspendedToken", String(DOCTOR), "doctor", "suspended", true], ["admin", String(ADMIN), "admin", "active", true],
        ];
        for (const [name, sub, role, status, ev] of claims) tokens[name] = await signUserToken(fake.key(suite), { sub, role, status, ev });
    });
    beforeEach(async () => {
        clock.release();
        video.reset();
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:"]);
        identityServer.users.clear(); identityServer.calls.length = 0; identityServer.statusBodies.length = 0;
        for (const key of Object.keys(identityServer.options)) delete (identityServer.options as Record<string, unknown>)[key];
        identityServer.users.set(DOCTOR, { id: DOCTOR, fullName: "Dr Synthetic", avatarUrl: null, status: "active" });
        identityServer.users.set(OTHER_DOCTOR, { id: OTHER_DOCTOR, fullName: "Dr Other Synthetic", avatarUrl: null, status: "active" });
        identityServer.users.set(PATIENT, { id: PATIENT, fullName: "Pat Synthetic", avatarUrl: "https://example.test/a.png", status: "active" });
        identityServer.users.set(OTHER_PATIENT, { id: OTHER_PATIENT, fullName: "Pat Other Synthetic", avatarUrl: null, status: "active" });
        await harness.seedDoctor(DOCTOR);
    });
    afterAll(async () => {
        clock.release();
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await identity.close(); await fake.close(); await identityServer.close(); await closeRedis(); await closeDb();
    });
    return harness;
}
