import { expectErrorEnvelope, expectPaginationMeta } from "../helpers/contract";
import type { Actor } from "../helpers/consultations-harness";
import {
    COMPLAINT, DAY, DOCTOR, HOUR, MINUTE, OTHER_DOCTOR, OTHER_PATIENT, PATIENT, useConsultationsHarness,
} from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { flushByPrefix } from "../helpers/redis";

jest.setTimeout(120_000);

interface Item { id: number; startsAt: string; doctor: { userId: number; displayName: string | null; profileHydrated: boolean }; patient: { userId: number; displayName: string | null; profileHydrated: boolean } }

describe("consultations read side (integration: real routes, Postgres, Redis; Identity faked)", () => {
    const h = useConsultationsHarness("consultations-reads");
    const batchCalls = (): string[] => h.identityServer.calls.filter((entry) => entry.path.startsWith("/internal/users?ids=")).map((entry) => entry.path);
    const seedAt = (startsAt: Date, changes: Record<string, unknown> = {}): Promise<number> =>
        h.seedConsultation({ starts_at: startsAt, ends_at: new Date(startsAt.getTime() + 30 * MINUTE), ...changes });

    async function walk(actor: Actor, query: string, limit: number): Promise<{ ids: number[]; pages: number }> {
        const ids: number[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
            const res = await h.call("get", `/api/consultations?limit=${limit}${query}${suffix}`, actor);
            expect(res.status).toBe(200);
            const meta = expectPaginationMeta(res.body.meta);
            const data = res.body.data as Item[];
            expect(meta.count).toBe(data.length);
            expect(data.length).toBeLessThanOrEqual(limit);
            expect(meta.hasMore).toBe(meta.nextCursor !== null);
            if (meta.hasMore) expect(data).toHaveLength(limit);
            ids.push(...data.map((item) => item.id));
            cursor = meta.nextCursor;
            pages += 1;
            expect(pages).toBeLessThan(30);
        } while (cursor !== null);
        return { ids, pages };
    }

    it("should answer 400 on the cursor field (not 500) for a forged cursor with year 0000", async () => {
        const forged = Buffer.from('["0000-01-01T00:00:00.000000Z",1]').toString("base64url");
        const res = await h.call("get", `/api/consultations?cursor=${encodeURIComponent(forged)}`, "patient");
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
    });

    describe("pagination by scope", () => {
        const future = { patient: [] as number[], other: [] as number[] };
        const past: number[] = [];
        let tied: number[] = [];

        beforeEach(async () => {
            future.patient = []; future.other = []; past.length = 0;
            // Five upcoming and five past consultations of one patient with one doctor, two upcoming of another patient (same doctor, other days).
            for (let day = 1; day <= 5; day += 1) future.patient.push(await seedAt(new Date(Date.now() + day * DAY)));
            for (let day = 1; day <= 5; day += 1) past.push(await seedAt(new Date(Date.now() - day * DAY), { status: "completed" }));
            for (let day = 6; day <= 7; day += 1) future.other.push(await seedAt(new Date(Date.now() + day * DAY), { patient_user_id: OTHER_PATIENT }));
            // Three consultations of the patient that start at the very same instant with three different doctors (ties on the sort column).
            const instant = new Date(Date.now() + 20 * DAY);
            tied = [await seedAt(instant), await seedAt(instant, { doctor_user_id: OTHER_DOCTOR }), await seedAt(instant, { doctor_user_id: 207 })];
        });

        it("should reach page 2 on the default sort (upcoming, ascending) for a patient and end exactly at the last row", async () => {
            const expected = [...future.patient, ...tied];
            const first = await h.call("get", "/api/consultations?limit=3", "patient");
            expect(first.body.data.map((item: Item) => item.id)).toEqual(expected.slice(0, 3));
            expect(first.body.meta).toMatchObject({ hasMore: true, count: 3 });
            const second = await h.call("get", `/api/consultations?limit=3&cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`, "patient");
            expect(second.status).toBe(200);
            expect(second.body.data.map((item: Item) => item.id)).toEqual(expected.slice(3, 6));
            expect(second.body.meta).toMatchObject({ hasMore: true, count: 3 });
            const walked = await walk("patient", "", 3);
            expect(walked.ids).toEqual(expected);
            expect(walked.pages).toBe(3);
        });

        it("should set hasMore and nextCursor exactly at the boundary: limit equal to the total is one page, one less is two", async () => {
            const total = future.patient.length + tied.length;
            const exact = await h.call("get", `/api/consultations?limit=${total}`, "patient");
            expect(exact.body.data).toHaveLength(total);
            expect(exact.body.meta).toEqual({ nextCursor: null, hasMore: false, count: total });
            const short = await h.call("get", `/api/consultations?limit=${total - 1}`, "patient");
            expect(short.body.meta).toMatchObject({ hasMore: true, count: total - 1 });
            const rest = await h.call("get", `/api/consultations?limit=${total - 1}&cursor=${encodeURIComponent(short.body.meta.nextCursor as string)}`, "patient");
            expect(rest.body.data).toHaveLength(1);
            expect(rest.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
        });

        it("should page rows that share one start instant without losing or repeating any across the page boundary", async () => {
            const ids: number[] = [];
            let cursor: string | null = null;
            do {
                const suffix: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
                const res = await h.call("get", `/api/consultations?limit=1&from=${encodeURIComponent(new Date(Date.now() + 19 * DAY).toISOString())}${suffix}`, "patient");
                ids.push(...(res.body.data as Item[]).map((item) => item.id));
                cursor = res.body.meta.nextCursor as string | null;
            } while (cursor !== null);
            expect(ids).toEqual(tied);
        });

        it("should walk the past scope newest first, with page 2 reachable", async () => {
            const walked = await walk("patient", "&scope=past", 2);
            expect(walked.ids).toEqual(past);
            expect(walked.pages).toBe(3);
            const first = await h.call("get", "/api/consultations?scope=past&limit=2", "patient");
            const second = await h.call("get", `/api/consultations?scope=past&limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`, "patient");
            expect(second.body.data.map((item: Item) => item.id)).toEqual(past.slice(2, 4));
        });

        it("should walk the all scope ascending: past oldest first, then upcoming", async () => {
            const walked = await walk("patient", "&scope=all", 4);
            expect(walked.ids).toEqual([...[...past].reverse(), ...future.patient, ...tied]);
        });

        it.each<[Actor]>([["doctor"], ["admin"]])("should page the default scope for %s with the same boundaries", async (actor) => {
            const expected = actor === "doctor" ? [...future.patient, ...future.other, tied[0]] : [...future.patient, ...future.other, ...tied];
            const walked = await walk(actor, "", 4);
            expect(walked.ids).toEqual(expected);
            const exact = await h.call("get", `/api/consultations?limit=${expected.length}`, actor);
            expect(exact.body.meta).toEqual({ nextCursor: null, hasMore: false, count: expected.length });
            const short = await h.call("get", `/api/consultations?limit=${expected.length - 1}`, actor);
            expect(short.body.meta).toMatchObject({ hasMore: true, count: expected.length - 1 });
        });

        it("should keep every viewer's pages inside their own rows", async () => {
            expect((await walk("otherPatient", "", 1)).ids).toEqual(future.other);
            expect((await walk("otherDoctor", "", 1)).ids).toEqual([tied[1]]);
            const all = await walk("admin", "&scope=all", 7);
            expect(all.ids).toHaveLength(5 + 5 + 2 + 3);
        });

        it("should combine the scope with from, to, status and the follow-up queue for an admin", async () => {
            await ownerDb("consultations").where("id", future.patient[1]).update({ needs_admin_followup: true, followup_reason: "doctor_suspended" });
            await ownerDb("consultations").where("id", past[0]).update({ needs_admin_followup: true, followup_reason: "doctor_suspended" });
            const queue = await walk("admin", "&needsAdminFollowup=true&scope=all", 1);
            expect(queue.ids).toEqual([future.patient[1]]);
            const window = await h.call("get", `/api/consultations?scope=all&from=${encodeURIComponent(new Date(Date.now() + 2.5 * DAY).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 4.5 * DAY).toISOString())}`, "patient");
            expect(window.body.data.map((item: Item) => item.id)).toEqual([future.patient[2], future.patient[3]]);
            const completed = await h.call("get", "/api/consultations?scope=all&status=completed&limit=2", "patient");
            expect(completed.body.data).toHaveLength(2);
            expect(completed.body.meta.hasMore).toBe(true);
            const none = await h.call("get", "/api/consultations?scope=upcoming&status=completed", "patient");
            expect(none.body.data).toEqual([]);
        });

        it("should treat the end of a running consultation as the upcoming/past boundary", async () => {
            const running = await seedAt(new Date(Date.now() - 10 * MINUTE));
            const upcoming = (await h.call("get", "/api/consultations?limit=1", "patient")).body.data as Item[];
            expect(upcoming[0]?.id).toBe(running);
            const finished = await seedAt(new Date(Date.now() - 31 * MINUTE), { doctor_user_id: OTHER_DOCTOR });
            const pastFirst = (await h.call("get", "/api/consultations?scope=past&limit=1", "patient")).body.data as Item[];
            expect(pastFirst[0]?.id).toBe(finished);
        });
    });

    describe("Case 2 hydration", () => {
        it("should use one batched Identity call for a whole page, not one per row", async () => {
            for (let index = 0; index < 8; index += 1) await seedAt(new Date(Date.now() + (index + 1) * DAY), { doctor_user_id: 400 + index, patient_user_id: 500 + index });
            const res = await h.call("get", "/api/consultations?limit=8", "admin");
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(8);
            const calls = batchCalls();
            expect(calls).toHaveLength(1);
            const ids = new URL(calls[0] ?? "", "http://localhost").searchParams.get("ids")?.split(",").map(Number).sort((a, b) => a - b);
            expect(ids).toEqual([400, 401, 402, 403, 404, 405, 406, 407, 500, 501, 502, 503, 504, 505, 506, 507]);
        });

        it("should ask for the distinct counterpart only when many rows share one doctor", async () => {
            for (let day = 1; day <= 4; day += 1) await seedAt(new Date(Date.now() + day * DAY));
            await h.call("get", "/api/consultations", "patient");
            const calls = batchCalls();
            expect(calls).toHaveLength(1);
            expect(new URL(calls[0] ?? "", "http://localhost").searchParams.get("ids")).toBe(String(DOCTOR));
        });

        it("should serve the second page from the read-through cache and survive an Identity outage afterwards", async () => {
            await seedAt(new Date(Date.now() + DAY));
            const warm = await h.call("get", "/api/consultations", "patient");
            expect(warm.body.data[0].doctor).toMatchObject({ userId: DOCTOR, displayName: "Dr Synthetic", profileHydrated: true });
            expect(batchCalls()).toHaveLength(1);
            const cached = await h.call("get", "/api/consultations", "patient");
            expect(cached.body.data[0].doctor.profileHydrated).toBe(true);
            expect(batchCalls()).toHaveLength(1);
            h.identityServer.options.down = true;
            const outage = await h.call("get", "/api/consultations", "patient");
            expect(outage.status).toBe(200);
            expect(outage.body.data[0].doctor).toMatchObject({ displayName: "Dr Synthetic", profileHydrated: true });
        });

        it("should answer 200 with profileHydrated:false and complete rows when Identity is down and nothing is cached, with at most one retry", async () => {
            const id = await seedAt(new Date(Date.now() + DAY));
            h.identityServer.options.down = true;
            const res = await h.call("get", "/api/consultations", "patient");
            expect(res.status).toBe(200);
            const [item] = res.body.data as Array<Record<string, unknown>>;
            expect(item).toMatchObject({ id, status: "booked", price: { amount: 15000, currency: "EGP" },
                doctor: { userId: DOCTOR, displayName: null, avatarUrl: null, profileHydrated: false } });
            expect(item?.startsAt).toEqual(expect.any(String));
            expect(batchCalls().length).toBeLessThanOrEqual(2);
        });

        it("should answer 200 and degrade when Identity is slower than the per-attempt timeout", async () => {
            await seedAt(new Date(Date.now() + DAY));
            h.identityServer.options.slowMs = 2_500;
            const started = Date.now();
            const res = await h.call("get", "/api/consultations", "patient");
            expect(res.status).toBe(200);
            expect(res.body.data[0].doctor).toMatchObject({ displayName: null, profileHydrated: false });
            expect(Date.now() - started).toBeLessThan(9_000);
            h.identityServer.options.slowMs = undefined;
        });

        it("should degrade on a malformed Identity response and recover on the single retry after one failure", async () => {
            await seedAt(new Date(Date.now() + DAY));
            h.identityServer.options.malformed = true;
            const malformed = await h.call("get", "/api/consultations", "patient");
            expect(malformed.status).toBe(200);
            expect(malformed.body.data[0].doctor.profileHydrated).toBe(false);
            h.identityServer.options.malformed = false;
            h.identityServer.calls.length = 0;
            h.identityServer.options.batchFailures = 1;
            const retried = await h.call("get", "/api/consultations", "patient");
            expect(retried.status).toBe(200);
            expect(retried.body.data[0].doctor).toMatchObject({ displayName: "Dr Synthetic", profileHydrated: true });
            expect(batchCalls()).toHaveLength(2);
        });

        it("should hydrate the users Identity knows and degrade only the rest", async () => {
            await seedAt(new Date(Date.now() + DAY));
            h.identityServer.users.delete(PATIENT);
            const res = await h.call("get", "/api/consultations", "admin");
            expect(res.body.data[0].doctor).toMatchObject({ displayName: "Dr Synthetic", profileHydrated: true });
            expect(res.body.data[0].patient).toMatchObject({ userId: PATIENT, displayName: null, profileHydrated: false });
        });

        it("should degrade get-one the same way while still returning the clinical text to the participant and auditing the read", async () => {
            const id = await seedAt(new Date(Date.now() + DAY));
            h.identityServer.options.down = true;
            const res = await h.call("get", `/api/consultations/${id}`, "patient");
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ complaintText: COMPLAINT, doctor: { profileHydrated: false } });
            expect(await h.audits("consultation.read")).toHaveLength(1);
        });

        it("should never answer 5xx on a read because of Identity, whatever the failure mode", async () => {
            const id = await seedAt(new Date(Date.now() + DAY));
            for (const options of [{ down: true }, { malformed: true }, { batchFailures: 5 }, { forceUnauthorized: 5 }]) {
                await h.resetRateLimits(); await flushByPrefix(["identity:"]);
                Object.assign(h.identityServer.options, { down: false, malformed: false, batchFailures: 0, forceUnauthorized: 0 }, options);
                for (const path of ["/api/consultations", `/api/consultations/${id}`]) {
                    const res = await h.call("get", path, "patient");
                    expect([path, JSON.stringify(options), res.status]).toEqual([path, JSON.stringify(options), 200]);
                }
                await h.call("get", "/api/consultations", "admin").then((res) => expect(res.status).toBe(200));
            }
        });

        it("should write nothing to Identity and make no Identity call on any write", async () => {
            const id = (await h.book()).body.data.id as number;
            await h.reschedule(id, "patient", { startsAt: new Date(Date.now() + 5 * DAY).toISOString() });
            await h.cancel(id, "patient");
            expect(h.identityServer.calls.filter((entry) => entry.path.startsWith("/internal/users"))).toHaveLength(0);
        });
    });

    describe("rendering zones", () => {
        it("should default to the patient's stored zone, the doctor's zone and UTC, and honour an explicit zone for every role", async () => {
            await seedAt(new Date("2031-01-15T10:00:00Z"), { patient_timezone: "Asia/Tokyo" });
            const local = async (actor: Actor, suffix = ""): Promise<{ timezone: string; startsAtLocal: string }> => {
                const res = await h.call("get", `/api/consultations?scope=all${suffix}`, actor);
                return res.body.data[0] as { timezone: string; startsAtLocal: string };
            };
            expect(await local("patient")).toMatchObject({ timezone: "Asia/Tokyo", startsAtLocal: "2031-01-15T19:00:00+09:00" });
            expect(await local("doctor")).toMatchObject({ timezone: "Africa/Cairo", startsAtLocal: "2031-01-15T12:00:00+02:00" });
            expect(await local("admin")).toMatchObject({ timezone: "UTC", startsAtLocal: "2031-01-15T10:00:00Z" });
            for (const actor of ["patient", "doctor", "admin"] as const) {
                expect(await local(actor, "&timezone=America/New_York")).toMatchObject({ timezone: "America/New_York", startsAtLocal: "2031-01-15T05:00:00-05:00" });
            }
            const bad = await h.call("get", "/api/consultations?timezone=Mars/Olympus", "patient");
            expect(bad.status).toBe(400); expectErrorEnvelope(bad.body, "ValidationFailed");
        });

        it("should keep list ordering and HOUR math independent of the viewer zone", async () => {
            await seedAt(new Date(Date.now() + 2 * HOUR));
            await seedAt(new Date(Date.now() + 5 * HOUR), { doctor_user_id: OTHER_DOCTOR });
            const a = await h.call("get", "/api/consultations?timezone=Pacific/Kiritimati", "patient");
            const b = await h.call("get", "/api/consultations?timezone=Pacific/Pago_Pago", "patient");
            expect(a.body.data.map((item: Item) => item.id)).toEqual(b.body.data.map((item: Item) => item.id));
        });
    });
});
