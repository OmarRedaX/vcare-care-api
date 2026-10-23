import type { Express } from "express";
import { DateTime } from "luxon";
import request from "supertest";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps } from "../helpers/app";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(180_000);

describe("availability slots HTTP latency budget (real Postgres and Redis)", () => {
    let app: Express;
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let token: string;
    let typeId: number;
    let path: string;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const prefixes = ["slots:", "slots-ver:", "next-available:", "free-map:", "rl:", "idem:"];

    async function clearSlots(): Promise<void> { await flushByPrefix(["slots:"]); }
    async function call(): Promise<void> {
        const response = await request(app).get(path).set("Authorization", `Bearer ${token}`);
        expect(response.status).toBe(200);
    }
    async function measure(kind: "hit" | "miss"): Promise<number> {
        const durations: number[] = [];
        for (let i = 0; i < 110; i += 1) {
            if (kind === "miss") await clearSlots();
            await flushByPrefix(["rl:"]);
            const start = performance.now();
            await call();
            if (i >= 10) durations.push(performance.now() - start);
        }
        const p95 = durations.sort((a, b) => a - b)[94]!;
        process.stderr.write(`availability HTTP 14-day/150-busy ${kind} p95: ${p95.toFixed(2)} ms\n`);
        return p95;
    }

    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
        await flushByPrefix(prefixes);
        fake = await startFakeJwks(["availability-http-bench"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const binding of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) previous.push({ token: binding, value: container.resolve(binding) });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp;
        token = await signUserToken(fake.key("availability-http-bench"), { sub: "101", role: "patient", status: "active" });
        const local = DateTime.now().setZone("Africa/Cairo").plus({ days: 1 }).startOf("day");
        const profile = await ownerDb("doctor_profiles").insert({ user_id: 202, headline: "Synthetic benchmark doctor", years_experience: 5,
            consultation_fee: 1000, currency: "EGP", default_slot_minutes: 30, timezone: "Africa/Cairo", is_accepting_patients: true,
            verification_status: "approved", identity_sync_status: "synced", decided_at: new Date() }).returning("id");
        const profileId = Number(profile[0]?.id);
        await ownerDb("working_hours").insert([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ doctor_profile_id: profileId,
            weekday, start_time: "08:00", end_time: "20:00" })));
        const types = await ownerDb("consultation_types").insert({ doctor_profile_id: profileId, name: "Synthetic benchmark visit",
            duration_minutes: 30, price: 1000, currency: "EGP", is_active: true }).returning("id");
        typeId = Number(types[0]?.id);
        const from = local.toISO()!;
        // API span is measured in elapsed milliseconds; a local 14-day span may gain an hour at DST.
        const to = DateTime.fromMillis(local.toMillis() + 14 * 86_400_000).toUTC().toISO()!;
        path = `/api/doctors/202/slots?typeId=${typeId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        const start = local.plus({ hours: 8 });
        const consultations = Array.from({ length: 150 }, (_, i) => {
            const time = start.plus({ days: Math.floor(i / 12), minutes: (i % 12) * 30 });
            return { doctor_user_id: 202, patient_user_id: 1000 + i, consultation_type_id: typeId,
                starts_at: time.toJSDate(), ends_at: time.plus({ minutes: 30 }).toJSDate(), status: "booked", complaint_text: "Synthetic benchmark complaint",
                patient_timezone: "UTC", price: 1000, currency: "EGP", idempotency_key: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
                request_hash: "a".repeat(64) };
        });
        await ownerDb("consultations").insert(consultations);
        expect(await redis.ping()).toBe("PONG");
    });

    afterAll(async () => {
        await flushByPrefix(prefixes);
        await truncateAll();
        for (const entry of previous) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await fake.close(); await closeRedis(); await closeDb();
    });

    it("should serve cache misses and hits below 300 ms p95 when a doctor has 150 bookings", async () => {
        const miss = await measure("miss");
        await flushByPrefix(["rl:"]);
        await call();
        const hit = await measure("hit");
        expect(miss).toBeLessThan(300);
        expect(hit).toBeLessThan(300);
    });
});
