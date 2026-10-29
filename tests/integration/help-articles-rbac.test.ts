import request from "supertest";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import { signExpiredUserToken } from "../helpers/tokens";
import { ACTORS, LIST, useHelpArticlesHarness, validCreate } from "../helpers/help-articles-harness";
import type { ActorName } from "../helpers/help-articles-harness";

jest.setTimeout(30_000);

type Row = [label: string, actor: ActorName | undefined, status: number];

/** Every actor, with the status each of the five routes must answer (spec 9.2 RBAC table). */
const ACTOR_ROWS: Array<[label: string, actor: ActorName | undefined, read: number, write: number]> = [
    ["unauthenticated", undefined, 401, 401],
    ["patient active", "patient", 200, 403],
    ["doctor active", "doctor", 200, 403],
    ["doctor pending", "doctorPending", 200, 403],
    ["doctor rejected", "doctorRejected", 200, 403],
    ["admin active", "admin", 200, 201],
    ["patient pending", "patientPending", 403, 403],
    ["admin pending", "adminPending", 403, 403],
    ["patient suspended", "patientSuspended", 403, 403],
    ["doctor suspended", "doctorSuspended", 403, 403],
    ["admin suspended", "adminSuspended", 403, 403],
];
const code = (status: number): string => (status === 401 ? "Unauthorized" : "Forbidden");

describe("help-articles RBAC (integration: real wiring, real Postgres as care_app, real Redis)", () => {
    const h = useHelpArticlesHarness();

    describe("GET /api/help-articles", () => {
        const ROWS: Row[] = ACTOR_ROWS.map(([label, actor, read]) => [label, actor, read]);

        it.each(ROWS)("should answer for %s with %i", async (_label, actor, status) => {
            await h.seed([{ title: "Synthetic Patient Article" }, { title: "Synthetic Doctor Article", audience: "doctor" }]);
            const res = await h.get(LIST, actor);
            expect(res.status).toBe(status);
            if (status === 200) {
                const expected = actor === "admin" ? 2 : 1;
                expect(res.body.data).toHaveLength(expected);
            } else {
                expectErrorEnvelope(res.body, code(status), res.headers["x-request-id"]);
            }
        });
    });

    describe("GET /api/help-articles/{id}", () => {
        it.each(ACTOR_ROWS.map(([label, actor, read]) => [label, actor, read] as Row))("should answer for %s with %i", async (_label, actor, status) => {
            // Each reader is given the published article of its own audience, so a 200 is the allowed outcome.
            const [patientId = 0, doctorId = 0] = await h.seed([{ title: "Synthetic Patient Article" }, { title: "Synthetic Doctor Article", audience: "doctor" }]);
            const id = actor === "doctor" || actor === "doctorPending" || actor === "doctorRejected" || actor === "doctorSuspended" ? doctorId : patientId;
            const res = await h.get(`${LIST}/${id}`, actor);
            expect(res.status).toBe(status);
            if (status === 200) {
                expect(res.body.data.id).toBe(id);
            } else {
                expectErrorEnvelope(res.body, code(status));
            }
        });

        it("should answer 404 (not 403) for an allowed reader asking for the other audience's published article", async () => {
            const [patientId = 0, doctorId = 0] = await h.seed([{ title: "Synthetic Patient Article" }, { title: "Synthetic Doctor Article", audience: "doctor" }]);
            expect((await h.get(`${LIST}/${doctorId}`, "patient")).status).toBe(404);
            expect((await h.get(`${LIST}/${patientId}`, "doctor")).status).toBe(404);
        });
    });

    describe("POST /api/help-articles", () => {
        it.each(ACTOR_ROWS.map(([label, actor, , write]) => [label, actor, write] as Row))("should answer for %s with %i", async (_label, actor, status) => {
            const res = await h.post(validCreate(), actor);
            expect(res.status).toBe(status);
            if (status === 201) {
                expect(expectSuccessEnvelope(res.body)).toMatchObject({ title: "Synthetic Article 001" });
            } else {
                expectErrorEnvelope(res.body, code(status));
                expect(await h.dbRows()).toEqual([]);
                expect(await h.auditRows()).toEqual([]);
            }
        });

        it("should answer 403 and not 400 for an invalid body from a patient because the role is checked before validation (HA-R15)", async () => {
            const res = await h.post({ title: "x" }, "patient");
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
        });
    });

    describe("PATCH /api/help-articles/{id}", () => {
        it.each(ACTOR_ROWS.map(([label, actor, , write]) => [label, actor, write === 201 ? 200 : write] as Row))("should answer for %s with %i", async (_label, actor, status) => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const res = await h.patch(id, { title: "Synthetic Renamed" }, actor);
            expect(res.status).toBe(status);
            if (status === 200) {
                expect(res.body.data.title).toBe("Synthetic Renamed");
            } else {
                expectErrorEnvelope(res.body, code(status));
                expect((await h.dbRows())[0]?.title).toBe("Synthetic Article 001");
                expect(await h.auditRows()).toEqual([]);
            }
        });

        it("should answer 403 for a patient and a doctor on a non-numeric id because the role is checked before the id (HA-R15)", async () => {
            for (const actor of ["patient", "doctor"] as const) {
                const res = await h.patch("abc", { title: "Synthetic Renamed" }, actor);
                expect(res.status).toBe(403);
                expectErrorEnvelope(res.body, "Forbidden");
            }
        });
    });

    describe("DELETE /api/help-articles/{id}", () => {
        it.each(ACTOR_ROWS.map(([label, actor, , write]) => [label, actor, write === 201 ? 204 : write] as Row))("should answer for %s with %i", async (_label, actor, status) => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const res = await h.del(id, actor);
            expect(res.status).toBe(status);
            if (status === 204) {
                expect(res.text).toBe("");
                expect((await h.dbRows())[0]?.deleted_at).not.toBeNull();
            } else {
                expectErrorEnvelope(res.body, code(status));
                expect((await h.dbRows())[0]?.deleted_at).toBeNull();
                expect(await h.auditRows()).toEqual([]);
            }
        });

        it("should answer 403 for a patient and a doctor on a non-numeric id (HA-R15)", async () => {
            for (const actor of ["patient", "doctor"] as const) {
                expect((await h.del("abc", actor)).status).toBe(403);
            }
        });
    });

    describe("authentication and caller-supplied identity", () => {
        it("should answer 401 TokenExpired for an expired admin token on every route", async () => {
            const expired = await signExpiredUserToken(h.fake.key("k1"), { sub: "303", role: "admin", status: "active" });
            const bearer = `Bearer ${expired}`;
            for (const res of [
                await request(h.app).get(LIST).set("Authorization", bearer),
                await request(h.app).get(`${LIST}/1`).set("Authorization", bearer),
                await request(h.app).post(LIST).set("Authorization", bearer).send(validCreate()),
                await request(h.app).patch(`${LIST}/1`).set("Authorization", bearer).send({ title: "Synthetic Renamed" }),
                await request(h.app).delete(`${LIST}/1`).set("Authorization", bearer),
            ]) {
                expect(res.status).toBe(401);
                expectErrorEnvelope(res.body, "TokenExpired");
            }
        });

        it("should answer 401 for a malformed bearer token and for a non-bearer scheme", async () => {
            const garbage = await request(h.app).get(LIST).set("Authorization", "Bearer not-a-jwt");
            expect(garbage.status).toBe(401);
            expectErrorEnvelope(garbage.body, "Unauthorized");
            const basic = await request(h.app).get(LIST).set("Authorization", "Basic YWRtaW46YWRtaW4=");
            expect(basic.status).toBe(401);
        });

        it("should ignore X-Role, X-User-Id and X-Forwarded-User headers and keep answering 403 on every write for a patient token", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Article 001" }]);
            const spoof = { "X-Role": "admin", "X-User-Id": "303", "X-Forwarded-User": "303" };
            expect((await h.post(validCreate(), "patient", spoof)).status).toBe(403);
            expect((await h.patch(id, { title: "Synthetic Renamed" }, "patient", spoof)).status).toBe(403);
            expect((await h.del(id, "patient", spoof)).status).toBe(403);
            expect(await h.auditRows()).toEqual([]);
            const rows = await h.dbRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]?.title).toBe("Synthetic Article 001");
            expect(rows[0]?.deleted_at).toBeNull();
        });

        it("should not let an admin header on a doctor token widen the audience filter", async () => {
            await h.seed([{ title: "Synthetic Patient Article" }, { title: "Synthetic Doctor Article", audience: "doctor" }]);
            const res = await h.get(LIST, "doctor", { "X-Role": "admin" });
            expect(res.body.data.map((a: { title: string }) => a.title)).toEqual(["Synthetic Doctor Article"]);
        });
    });

    describe("ids that cannot be an article", () => {
        it.each([["abc"], ["0"], ["007"], ["9007199254740993"], ["999999"], ["-1"], ["1.5"]])("should answer 404 NotFound for an admin on id %s for GET, PATCH and DELETE", async (id) => {
            const get = await h.get(`${LIST}/${id}`, "admin");
            expect(get.status).toBe(404);
            expectErrorEnvelope(get.body, "NotFound");
            const patch = await h.patch(id, { title: "Synthetic Renamed" }, "admin");
            expect(patch.status).toBe(404);
            expectErrorEnvelope(patch.body, "NotFound");
            const del = await h.del(id, "admin");
            expect(del.status).toBe(404);
            expectErrorEnvelope(del.body, "NotFound");
            expect(await h.auditRows()).toEqual([]);
        });

        it("should check the id before the body so an admin PATCH of an unknown id with an empty body is 404 and not 400", async () => {
            expect((await h.patch("abc", {}, "admin")).status).toBe(404);
            expect((await h.patch(424242, {}, "admin")).status).toBe(400);
        });

        it.each([["abc"], ["0"], ["999999"]])("should answer 404 for readers on id %s", async (id) => {
            for (const actor of ["patient", "doctor", "doctorPending", "doctorRejected"] as const) {
                const res = await h.get(`${LIST}/${id}`, actor);
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
            }
        });
    });

    describe("account state versus Care's own suspension (HA-D14)", () => {
        it("should let a doctor whose Care profile is locally suspended keep reading while the token is still active", async () => {
            await ownerDb("doctor_profiles").insert({
                user_id: 202, headline: "Synthetic doctor headline", years_experience: 5, consultation_fee: 100, currency: "EGP",
                default_slot_minutes: 30, timezone: "UTC", is_accepting_patients: true, verification_status: "approved",
                identity_sync_status: "pending", decided_at: new Date(), suspended_at: new Date(), suspension_reason: "SYNTHETIC-SUSPENSION-REASON",
            });
            await h.seed([{ title: "Synthetic Doctor Article", audience: "doctor" }]);
            const list = await h.get(LIST, "doctor");
            expect(list.status).toBe(200);
            expect(list.body.data).toHaveLength(1);
        });

        it("should keep admitting a doctor token in every onboarding state to both reads", async () => {
            const [id = 0] = await h.seed([{ title: "Synthetic Doctor Article", audience: "doctor" }]);
            for (const actor of ["doctor", "doctorPending", "doctorRejected"] as const) {
                expect((await h.get(LIST, actor)).status).toBe(200);
                expect((await h.get(`${LIST}/${id}`, actor)).status).toBe(200);
            }
        });
    });
});
