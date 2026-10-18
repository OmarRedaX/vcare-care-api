import { randomUUID } from "node:crypto";
import { expectErrorEnvelope } from "../helpers/contract";
import { bookingBody, localStart, MINUTE, OTHER_DOCTOR, OTHER_PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { captureQueries, CHIEF, createRecord, getRecord, insertRecordRow, PLAN, provisionOtherDoctor, recordBody, seedCompleted, seedWithStatus } from "../helpers/records-fixtures";
import { flushByPrefix } from "../helpers/redis";
import { patch, seedSession, sessionStart } from "../helpers/sessions-fixtures";

jest.setTimeout(120_000);

describe("records links: Consultation.hasRecord and the follow-up booking (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("records-links");
    const consultationCount = async (): Promise<number> => (await h.consultationRows()).length;
    const consultation = (id: number, actor: "patient" | "doctor" | "admin") => h.call("get", `/api/consultations/${id}`, actor);

    // ───────────────────────────────────────────── hasRecord (RC-R17)
    describe("hasRecord", () => {
        it("should be false before the record exists and true after, on get-one for the patient, the doctor and an admin", async () => {
            const id = await seedCompleted(h);
            for (const actor of ["patient", "doctor", "admin"] as const) expect([actor, (await consultation(id, actor)).body.data.hasRecord]).toEqual([actor, false]);
            await createRecord(h, id);
            for (const actor of ["patient", "doctor", "admin"] as const) {
                const res = await consultation(id, actor);
                expect([actor, res.status, res.body.data.hasRecord]).toEqual([actor, 200, true]);
            }
        });

        it("should give an admin the flag and no record content", async () => {
            const id = await seedCompleted(h);
            await createRecord(h, id);
            const res = await consultation(id, "admin");
            expect(res.body.data.hasRecord).toBe(true);
            for (const text of [CHIEF, "chiefComplaint", "complaintText", "treatmentPlan"]) expect(JSON.stringify(res.body)).not.toContain(text);
        });

        it("should mark only the completed consultation that has a record in the list for the patient, the doctor and an admin", async () => {
            const withRecord = await seedCompleted(h);
            const without = await seedCompleted(h);
            const booked = await seedWithStatus(h, "booked");
            await createRecord(h, withRecord);
            for (const actor of ["patient", "doctor", "admin"] as const) {
                const res = await h.call("get", "/api/consultations?scope=all", actor);
                expect(res.status).toBe(200);
                const flags = Object.fromEntries((res.body.data as Array<{ id: number; hasRecord: boolean }>).map((item) => [item.id, item.hasRecord]));
                expect([actor, flags]).toEqual([actor, { [withRecord]: true, [without]: false, [booked]: false }]);
            }
        });

        it("should mark the doctor's calendar entries the same way", async () => {
            const withRecord = await seedCompleted(h);
            const without = await seedCompleted(h);
            await createRecord(h, withRecord);
            const starts = (await h.consultationRows()).map((row) => (row.starts_at as Date).getTime());
            const from = new Date(Math.min(...starts) - 60 * MINUTE).toISOString();
            const to = new Date(Math.max(...starts) + 3 * 60 * MINUTE).toISOString();
            const res = await h.call("get", `/api/consultations/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, "doctor");
            expect(res.status).toBe(200);
            const flags = Object.fromEntries((res.body.data.consultations as Array<{ id: number; hasRecord: boolean }>).map((item) => [item.id, item.hasRecord]));
            expect(flags).toEqual({ [withRecord]: true, [without]: false });
        });

        it("should be false for a consultation whose only record is soft-deleted", async () => {
            const id = await seedCompleted(h);
            await insertRecordRow(id, { deleted_at: new Date() });
            expect((await consultation(id, "patient")).body.data.hasRecord).toBe(false);
        });

        it("should answer hasRecord false on the write responses and true on the next read once the record exists", async () => {
            const id = await seedSession(h, { status: "in_progress", started_at: new Date(sessionStart()) });
            h.clock.freeze(sessionStart() + 10 * MINUTE);
            const completed = await patch(h, id, "complete", "doctor");
            expect(completed.status).toBe(200);
            expect(completed.body.data.hasRecord).toBe(false);
            await createRecord(h, id);
            expect((await consultation(id, "doctor")).body.data.hasRecord).toBe(true);
        });

        it("should report hasRecord truthfully when a booking is replayed through the database idempotency path after the consultation was completed and recorded (M9)", async () => {
            const key = randomUUID();
            const body = bookingBody();
            const first = await h.book("patient", body, key);
            expect(first.status).toBe(201);
            expect(first.body.data.hasRecord).toBe(false);
            const id = first.body.data.id as number;
            // Still booked: the replay is the booking-time snapshot, no record possible.
            await flushByPrefix(["idem:"]);
            const early = await h.book("patient", body, key);
            expect([early.status, early.body.data.id, early.body.data.hasRecord]).toEqual([201, id, false]);
            await ownerDb("consultations").where({ id }).update({ status: "completed", completed_at: new Date() });
            // Completed, no record yet: still false.
            await flushByPrefix(["idem:"]);
            expect((await h.book("patient", body, key)).body.data).toMatchObject({ id, status: "completed", hasRecord: false });
            await createRecord(h, id);
            await flushByPrefix(["idem:"]);
            const replay = await h.book("patient", body, key);
            expect(replay.status).toBe(201);
            expect(replay.body.data).toMatchObject({ id, status: "completed", hasRecord: true });
            expect((await consultation(id, "patient")).body.data.hasRecord).toBe(true);
        });

        it("should issue no medical_records query for a page without a completed row, and exactly one for a page with several", async () => {
            await seedWithStatus(h, "booked");
            await seedWithStatus(h, "cancelled");
            const none = await captureQueries(() => h.call("get", "/api/consultations?scope=all", "patient"));
            expect(none.result.status).toBe(200);
            expect(none.sql.filter((sql) => sql.includes("medical_records"))).toHaveLength(0);
            const done = [await seedCompleted(h), await seedCompleted(h), await seedCompleted(h)];
            await createRecord(h, done[0] as number);
            const some = await captureQueries(() => h.call("get", "/api/consultations?scope=all", "patient"));
            expect(some.sql.filter((sql) => sql.includes("medical_records"))).toHaveLength(1);
            expect(some.sql.find((sql) => sql.includes("medical_records"))).toContain("ANY(");
            const single = await captureQueries(() => consultation(done[0] as number, "patient"));
            expect(single.sql.filter((sql) => sql.includes("medical_records"))).toHaveLength(1);
            const bookedId = (await h.consultationRows())[0]?.id as number;
            const bookedOne = await captureQueries(() => consultation(bookedId, "patient"));
            expect(bookedOne.sql.filter((sql) => sql.includes("medical_records"))).toHaveLength(0);
        });

        it("should keep the flag out of other patients' views of the same shape (it is per consultation, never per patient)", async () => {
            const mine = await seedCompleted(h);
            await createRecord(h, mine);
            const theirs = await seedCompleted(h, { patient_user_id: OTHER_PATIENT });
            const res = await h.call("get", "/api/consultations?scope=all", "otherPatient");
            expect((res.body.data as Array<{ id: number; hasRecord: boolean }>).map((item) => [item.id, item.hasRecord])).toEqual([[theirs, false]]);
        });
    });

    // ───────────────────────────────────────────── the follow-up link (RC-R18)
    describe("followUpOfRecordId on booking", () => {
        const followUp = (recordId: unknown, actor: "patient" | "otherPatient" = "patient", extra: Record<string, unknown> = {}, key?: string) =>
            h.book(actor, bookingBody({ followUpOfRecordId: recordId, ...extra }), key);

        it("should accept the patient's own record with the same doctor: 201, the link echoed and stored, hasRecord false on the new consultation", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            const res = await followUp(recordId);
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ followUpOfRecordId: recordId, status: "booked", hasRecord: false });
            const rows = await h.consultationRows();
            expect(rows.find((row) => row.id === res.body.data.id)?.follow_up_of_record_id).toBe(recordId);
            const read = await consultation(res.body.data.id as number, "doctor");
            expect(read.body.data.followUpOfRecordId).toBe(recordId);
        });

        it("should store no link for an ordinary booking", async () => {
            const res = await h.book("patient");
            expect(res.status).toBe(201);
            expect(res.body.data.followUpOfRecordId).toBeNull();
        });

        it("should answer 404 and create no consultation for another patient's record", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            const before = await consultationCount();
            const res = await followUp(recordId, "otherPatient");
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
            expect(await consultationCount()).toBe(before);
            expect(await h.outbox()).toHaveLength(0);
        });

        it("should answer 404 for a record written by a different doctor than the one being booked", async () => {
            await provisionOtherDoctor(h);
            const theirs = await createRecord(h, await seedCompleted(h, { doctor_user_id: OTHER_DOCTOR }), recordBody(), "otherDoctor");
            const before = await consultationCount();
            const res = await followUp(theirs);
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
            expect(await consultationCount()).toBe(before);
        });

        it("should answer the same 404 for an unknown record, a soft-deleted record and a foreign record (no probing)", async () => {
            const foreign = await createRecord(h, await seedCompleted(h, { patient_user_id: OTHER_PATIENT }));
            const deleted = await insertRecordRow(await seedCompleted(h), { deleted_at: new Date() });
            const messages = new Set<string>();
            for (const recordId of [999999, foreign, deleted]) {
                const res = await followUp(recordId);
                expect([recordId, res.status]).toEqual([recordId, 404]);
                expectErrorEnvelope(res.body, "NotFound");
                messages.add(res.body.error.message as string);
            }
            expect(messages.size).toBe(1);
        });

        it.each([["a string", "5"], ["zero", 0], ["a negative", -3], ["a fraction", 1.5], ["null", null]])("should answer 400 on followUpOfRecordId for %s", async (_label, value) => {
            const res = await followUp(value);
            expect(res.status).toBe(400);
            expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toContain("followUpOfRecordId");
        });

        it("should apply no timing or followUpInDays rule: any later free slot with any record of this pair is accepted", async () => {
            const recordId = await createRecord(h, await seedCompleted(h), recordBody({ followUpInDays: 1 }));
            const res = await followUp(recordId, "patient", { startsAt: localStart(20, "11:00") });
            expect(res.status).toBe(201);
        });

        it("should replay the stored consultation for the same key and body, and reject the same key with a different link as an idempotency conflict", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            const key = randomUUID();
            const first = await followUp(recordId, "patient", {}, key);
            const replay = await followUp(recordId, "patient", {}, key);
            expect(first.status).toBe(201);
            expect(replay.status).toBe(201);
            expect(replay.body.data.id).toBe(first.body.data.id);
            expect(replay.body.data.followUpOfRecordId).toBe(recordId);
            expect(await consultationCount()).toBe(2);
            const conflict = await h.book("patient", bookingBody(), key);
            expect(conflict.status).toBe(422);
            expectErrorEnvelope(conflict.body, "IdempotencyConflict");
        });

        it("should keep the link when the record is amended or updated, and let the record be read by the patient who booked the follow-up", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            const booked = await followUp(recordId);
            expect(booked.status).toBe(201);
            expect((await h.call("patch", `/api/records/${recordId}`, "doctor", { treatmentPlan: PLAN })).status).toBe(200);
            expect((await getRecord(h, recordId, "patient")).status).toBe(200);
            expect((await consultation(booked.body.data.id as number, "patient")).body.data.followUpOfRecordId).toBe(recordId);
        });

        it("should be protected by a foreign key: a dangling link and the deletion of a linked record are refused by the database", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            const booked = await followUp(recordId);
            const other = await seedCompleted(h);
            await expect(ownerDb("consultations").where({ id: other }).update({ follow_up_of_record_id: 987654 })).rejects.toMatchObject({ code: "23503", constraint: "fk_consultations_follow_up_of_record_id" });
            // ON DELETE RESTRICT raises restrict_violation (23001), where NO ACTION would raise 23503: either way the named foreign key refuses it.
            const refused = await ownerDb("medical_records").where({ id: recordId }).del().then(() => undefined, (error: { code: string; constraint: string }) => error);
            expect(["23001", "23503"]).toContain(refused?.code);
            expect(refused?.constraint).toBe("fk_consultations_follow_up_of_record_id");
            expect((await h.consultationRows()).find((row) => row.id === booked.body.data.id)?.follow_up_of_record_id).toBe(recordId);
        });

        it("should keep booking free of any Identity call, hydration or record text", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            const calls = h.identityServer.calls.length;
            const res = await followUp(recordId);
            expect(res.status).toBe(201);
            expect(JSON.stringify(res.body)).not.toContain(CHIEF);
            expect(h.identityServer.calls.length).toBe(calls);
        });
    });
});
