import { randomUUID } from "node:crypto";
import { contractNoStoreValue, expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { bookingBody, DOCTOR, MINUTE, OTHER_DOCTOR, OTHER_PATIENT, PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import {
    allRecordAudits, amendmentRows, audits, CHIEF, createRecord, DX_CODE, DX_TEXT, getRecord, insertRecordRow, NOTES, patchRecord, PLAN, postRecord, provisionOtherDoctor,
    recordBody, recordRows, relate, scanRedis, seedCompleted, seedWithStatus, STRANGER_DOCTOR, suspendLocally, timeline, withFailingAudit,
} from "../helpers/records-fixtures";
import { patch } from "../helpers/sessions-fixtures";

jest.setTimeout(120_000);

describe("records: the creation gate, concurrency and atomicity (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("records");

    // ───────────────────────────────────────────── the happy path through the real lifecycle (RC-R1, RC-R4, RC-R5, RC-R15)
    describe("creating a record", () => {
        it("should create the record of a consultation that was booked, joined, started and completed through the real routes", async () => {
            const booked = await h.book("patient");
            expect(booked.status).toBe(201);
            const consultationId = booked.body.data.id as number;
            const start = Date.parse(booked.body.data.startsAt as string);
            h.clock.freeze(start - 5 * MINUTE);
            expect((await patch(h, consultationId, "join", "patient")).status).toBe(200);
            h.clock.freeze(start + MINUTE);
            expect((await patch(h, consultationId, "start", "doctor")).status).toBe(200);
            h.clock.freeze(start + 20 * MINUTE);
            expect((await patch(h, consultationId, "complete", "doctor")).status).toBe(200);
            h.clock.release();

            const res = await postRecord(h, consultationId, recordBody(), "doctor");
            expect(res.status).toBe(201);
            const data = expectSuccessEnvelope(res.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
            expect(data).toMatchObject({ consultationId, patientUserId: PATIENT, doctorUserId: DOCTOR, chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisText: DX_TEXT,
                diagnosisCode: DX_CODE, treatmentPlan: PLAN, followUpInDays: 14, isLocked: false, amendments: [], attachments: [] });
            expect(Date.parse(data.lockedAt) - Date.parse(data.createdAt)).toBe(24 * 60 * MINUTE);
            expect(data.updatedAt).toBe(data.createdAt);
            expect(res.headers["cache-control"]).toBe(contractNoStoreValue());

            const rows = await recordRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ id: data.id, consultation_id: consultationId, patient_user_id: PATIENT, doctor_user_id: DOCTOR, deleted_at: null });
            const exact = await ownerDb.raw("SELECT (locked_at = created_at + interval '24 hours') AS exact, (locked_at <= NOW()) AS locked FROM medical_records WHERE id = ?", [data.id]);
            expect(exact.rows[0]).toEqual({ exact: true, locked: false });
            const [audit] = await audits("record.created");
            expect(audit).toMatchObject({ actor_user_id: DOCTOR, actor_role: "doctor", entity_type: "medical_record", entity_id: data.id, request_id: res.headers["x-request-id"] });
            expect(audit?.metadata).toEqual({ consultationId, patientUserId: PATIENT, doctorUserId: DOCTOR,
                providedFields: "chiefComplaint,examinationNotes,diagnosisText,diagnosisCode,treatmentPlan,followUpInDays" });
            expect(await allRecordAudits()).toHaveLength(1);
        });

        it("should create a record with only the chief complaint and render every other member as null", async () => {
            const id = await seedCompleted(h);
            const res = await postRecord(h, id, { chiefComplaint: CHIEF }, "doctor");
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ chiefComplaint: CHIEF, examinationNotes: null, diagnosisText: null, diagnosisCode: null, treatmentPlan: null, followUpInDays: null });
            expect((await audits("record.created"))[0]?.metadata).toMatchObject({ providedFields: "chiefComplaint" });
        });

        it("should copy the patient and doctor ids from the consultation, whoever the caller or the body names", async () => {
            const id = await seedCompleted(h, { patient_user_id: OTHER_PATIENT });
            const res = await postRecord(h, id, recordBody(), "doctor");
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ patientUserId: OTHER_PATIENT, doctorUserId: DOCTOR });
            const forged = await seedCompleted(h);
            for (const forgery of [{ patientUserId: 999 }, { doctorUserId: 999 }, { consultationId: 1 }, { id: 5 }, { lockedAt: "2020-01-01T00:00:00Z" }]) {
                const rejected = await postRecord(h, forged, recordBody(forgery), "doctor");
                expect([forgery, rejected.status]).toEqual([forgery, 400]);
                expectErrorEnvelope(rejected.body, "ValidationFailed");
            }
            expect(await recordRows()).toHaveLength(1);
        });

        it("should return the same record on read that the create returned", async () => {
            const id = await seedCompleted(h);
            const created = await postRecord(h, id, recordBody(), "doctor");
            const read = await getRecord(h, created.body.data.id as number, "patient");
            expect(read.status).toBe(200);
            expect(read.body.data).toEqual(created.body.data);
        });

        it("should store lock time from database time, not from anything the client sends", async () => {
            const id = await seedCompleted(h);
            const res = await h.call("post", `/api/consultations/${id}/record`, "doctor", recordBody(), { Date: "Mon, 01 Jan 2001 00:00:00 GMT", "X-Forwarded-Date": "2001-01-01" });
            expect(res.status).toBe(201);
            const drift = Math.abs(Date.parse(res.body.data.createdAt as string) - Date.now());
            expect(drift).toBeLessThan(30_000);
        });
    });

    // ───────────────────────────────────────────── the gate, one failure per error code (RC-R1, RC-R2, RC-R3)
    describe("the creation gate", () => {
        it.each(["booked", "waiting", "in_progress", "cancelled", "no_show"] as const)("should answer 409 RecordRequiresCompleted for a %s consultation and write nothing", async (status) => {
            const id = await seedWithStatus(h, status);
            const res = await postRecord(h, id, recordBody(), "doctor");
            expect(res.status).toBe(409);
            expectErrorEnvelope(res.body, "RecordRequiresCompleted");
            expect(await recordRows()).toHaveLength(0);
            expect(await allRecordAudits()).toHaveLength(0);
        });

        it("should answer 409 Conflict for a second create and leave the first record and its single audit row untouched", async () => {
            const id = await seedCompleted(h);
            const first = await postRecord(h, id, recordBody(), "doctor");
            expect(first.status).toBe(201);
            const before = await recordRows();
            const second = await postRecord(h, id, recordBody({ chiefComplaint: "SYNTHETIC-CHIEF-OTHER" }), "doctor");
            expect(second.status).toBe(409);
            expectErrorEnvelope(second.body, "Conflict");
            expect(second.headers["retry-after"]).toBeUndefined();
            expect(await recordRows()).toEqual(before);
            expect(await audits("record.created")).toHaveLength(1);
        });

        it("should answer 409 Conflict for a retried create with the same Idempotency-Key and keep no Redis idempotency record (no Idempotency-Key on record routes)", async () => {
            const id = await seedCompleted(h);
            const key = randomUUID();
            expect((await h.call("post", `/api/consultations/${id}/record`, "doctor", recordBody(), { "Idempotency-Key": key })).status).toBe(201);
            const retry = await h.call("post", `/api/consultations/${id}/record`, "doctor", recordBody(), { "Idempotency-Key": key });
            expect(retry.status).toBe(409);
            expectErrorEnvelope(retry.body, "Conflict");
            const keys = (await scanRedis()).map((entry) => entry.key);
            expect(keys.filter((name) => name.startsWith("idem:"))).toEqual([]);
            expect(await recordRows()).toHaveLength(1);
        });

        it("should create the record without an Idempotency-Key and ignore a malformed one", async () => {
            const id = await seedCompleted(h);
            const res = await h.call("post", `/api/consultations/${id}/record`, "doctor", recordBody(), { "Idempotency-Key": "not-a-uuid" });
            expect(res.status).toBe(201);
        });

        it("should answer 404 NotFound, never NotAssignedDoctor, to a doctor who has a relationship with the patient but is not the consultation's doctor (M1)", async () => {
            await provisionOtherDoctor(h);
            const id = await seedCompleted(h);
            const res = await postRecord(h, id, recordBody(), "otherDoctor");
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
            expect(await recordRows()).toHaveLength(0);
            expect(await allRecordAudits()).toHaveLength(0);
        });

        it("should give a related doctor probing cancelled, no-show, booked, other-doctor, recorded and record-less consultations of the same patient the identical 404 as an absent id (M1 existence oracle)", async () => {
            await provisionOtherDoctor(h);
            await h.seedDoctor(STRANGER_DOCTOR);
            const probes: Record<string, number> = {
                cancelled: await seedWithStatus(h, "cancelled"), noShow: await seedWithStatus(h, "no_show"), booked: await seedWithStatus(h, "booked"),
                waiting: await seedWithStatus(h, "waiting", { joined_at: new Date() }), recordLess: await seedCompleted(h),
                otherDoctorCompleted: await seedCompleted(h, { doctor_user_id: STRANGER_DOCTOR }), otherDoctorBooked: await relate(h, STRANGER_DOCTOR, PATIENT, "booked"),
            };
            probes.recorded = await seedCompleted(h);
            await createRecord(h, probes.recorded);
            const shape = (body: { error: { requestId?: string } }): unknown => ({ ...body, error: { ...body.error, requestId: "<id>" } });
            const absent = await postRecord(h, 999999, recordBody(), "otherDoctor");
            expect(absent.status).toBe(404);
            const before = { records: await recordRows(), audits: await allRecordAudits() };
            for (const [label, id] of Object.entries(probes)) {
                // A valid body and an empty one: neither may be told apart from an absent id (an empty body must not reach validation).
                for (const body of [recordBody(), {}]) {
                    const res = await postRecord(h, id, body, "otherDoctor");
                    expect([label, res.status]).toEqual([label, 404]);
                    expect([label, shape(res.body)]).toEqual([label, shape(absent.body)]);
                }
            }
            expect({ records: await recordRows(), audits: await allRecordAudits() }).toEqual(before);
        });

        it("should answer 404 to a doctor with no relationship to the patient, for an unknown id and for a non-numeric id", async () => {
            const id = await seedCompleted(h);
            const stranger = await h.signFor(STRANGER_DOCTOR, "doctor");
            const unrelated = await h.callWith(stranger, "post", `/api/consultations/${id}/record`, recordBody());
            expect(unrelated.status).toBe(404);
            expectErrorEnvelope(unrelated.body, "NotFound");
            for (const missing of ["999999", "abc", "0", "-1", "1.5"]) {
                const res = await postRecord(h, missing, recordBody(), "doctor");
                expect([missing, res.status]).toEqual([missing, 404]);
                expectErrorEnvelope(res.body, "NotFound");
            }
            expect(await recordRows()).toHaveLength(0);
        });

        it("should give a doctor whose only relationship is a cancelled consultation the same 404 as a stranger", async () => {
            await h.seedDoctor(OTHER_DOCTOR);
            await relate(h, OTHER_DOCTOR, PATIENT, "cancelled");
            await relate(h, OTHER_DOCTOR, PATIENT, "no_show");
            const id = await seedCompleted(h);
            const res = await postRecord(h, id, recordBody(), "otherDoctor");
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
        });

        it("should not let the related doctor learn the consultation status: 404, neither NotAssignedDoctor nor RecordRequiresCompleted", async () => {
            await provisionOtherDoctor(h);
            const booked = await seedWithStatus(h, "booked");
            const res = await postRecord(h, booked, recordBody(), "otherDoctor");
            expect(res.status).toBe(404);
            expectErrorEnvelope(res.body, "NotFound");
        });

        describe("the documented check order", () => {
            it("should answer 403 Forbidden for a wrong role or a locally suspended doctor before the body or the consultation is looked at", async () => {
                const id = await seedCompleted(h);
                const invalid = { chiefComplaint: "x" };
                for (const actor of ["patient", "otherPatient", "admin"] as const) {
                    const res = await postRecord(h, id, invalid, actor);
                    expect([actor, res.status]).toEqual([actor, 403]);
                    expectErrorEnvelope(res.body, "Forbidden");
                }
                const unknownConsultation = await postRecord(h, 999999, invalid, "admin");
                expect(unknownConsultation.status).toBe(403);
                await suspendLocally(DOCTOR);
                const suspended = await postRecord(h, id, invalid, "doctor");
                expect(suspended.status).toBe(403);
                expectErrorEnvelope(suspended.body, "Forbidden");
                const pending = await h.callWith(await h.signFor(DOCTOR, "doctor", "pending"), "post", `/api/consultations/${id}/record`, invalid);
                expect(pending.status).toBe(403);
            });

            it("should answer 404 for an unrelated doctor before the body is validated", async () => {
                const id = await seedCompleted(h);
                const stranger = await h.signFor(STRANGER_DOCTOR, "doctor");
                const res = await h.callWith(stranger, "post", `/api/consultations/${id}/record`, { chiefComplaint: "x" });
                expect(res.status).toBe(404);
                expectErrorEnvelope(res.body, "NotFound");
            });

            it("should answer 400 for an invalid body before the status check, for the assigned doctor, and 404 to any other doctor before the body is validated (M1)", async () => {
                await provisionOtherDoctor(h);
                const booked = await seedWithStatus(h, "booked");
                const completed = await seedCompleted(h);
                for (const id of [booked, completed]) {
                    const res = await postRecord(h, id, { chiefComplaint: "x" }, "doctor");
                    expect([id, res.status]).toEqual([id, 400]);
                    expectErrorEnvelope(res.body, "ValidationFailed");
                    expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(["chiefComplaint"]);
                    const other = await postRecord(h, id, { chiefComplaint: "x" }, "otherDoctor");
                    expect([id, other.status]).toEqual([id, 404]);
                    expectErrorEnvelope(other.body, "NotFound");
                }
            });

            it("should answer 404 to a non-assigned doctor before RecordRequiresCompleted, and RecordRequiresCompleted before Conflict for the assigned doctor", async () => {
                await provisionOtherDoctor(h);
                const booked = await seedWithStatus(h, "booked");
                const related = await postRecord(h, booked, recordBody(), "otherDoctor");
                expectErrorEnvelope(related.body, "NotFound");
                // A record row on a non-completed consultation (written by the owner; no route can) must not turn the status error into a conflict.
                await insertRecordRow(booked, { created_at: new Date() });
                const owner = await postRecord(h, booked, recordBody(), "doctor");
                expect(owner.status).toBe(409);
                expectErrorEnvelope(owner.body, "RecordRequiresCompleted");
                const completed = await seedCompleted(h);
                await insertRecordRow(completed, { created_at: new Date() });
                const conflict = await postRecord(h, completed, recordBody(), "doctor");
                expect(conflict.status).toBe(409);
                expectErrorEnvelope(conflict.body, "Conflict");
            });

            it("should spend no write budget on a 403 or 404 (the limiter runs after authorization)", async () => {
                const id = await seedCompleted(h);
                const stranger = await h.signFor(STRANGER_DOCTOR, "doctor");
                for (let index = 0; index < 25; index += 1) expect((await h.callWith(stranger, "post", `/api/consultations/${id}/record`, recordBody())).status).toBe(404);
                for (let index = 0; index < 25; index += 1) expect((await postRecord(h, id, recordBody(), "admin")).status).toBe(403);
                expect((await postRecord(h, id, recordBody(), "doctor")).status).toBe(201);
            });
        });

        describe("body validation", () => {
            it.each([
                ["a missing chiefComplaint", {}, "chiefComplaint"], ["a two character chiefComplaint", { chiefComplaint: "ab" }, "chiefComplaint"],
                ["a blank chiefComplaint", { chiefComplaint: "     " }, "chiefComplaint"], ["a NUL in the chiefComplaint", { chiefComplaint: "abc\u0000def" }, "chiefComplaint"],
                ["a 2001 character chiefComplaint", { chiefComplaint: "a".repeat(2001) }, "chiefComplaint"],
                ["a blank examinationNotes", { chiefComplaint: CHIEF, examinationNotes: "  " }, "examinationNotes"],
                ["a null treatmentPlan", { chiefComplaint: CHIEF, treatmentPlan: null }, "treatmentPlan"],
                ["a lowercase diagnosisCode", { chiefComplaint: CHIEF, diagnosisCode: "a00" }, "diagnosisCode"],
                ["a too long diagnosisCode", { chiefComplaint: CHIEF, diagnosisCode: "A00.12345" }, "diagnosisCode"],
                ["followUpInDays 0", { chiefComplaint: CHIEF, followUpInDays: 0 }, "followUpInDays"],
                ["followUpInDays 366", { chiefComplaint: CHIEF, followUpInDays: 366 }, "followUpInDays"],
                ["a fractional followUpInDays", { chiefComplaint: CHIEF, followUpInDays: 1.5 }, "followUpInDays"],
                ["a string followUpInDays", { chiefComplaint: CHIEF, followUpInDays: "7" }, "followUpInDays"],
                ["an unknown member", { chiefComplaint: CHIEF, severity: "high" }, "severity"],
            ])("should answer 400 ValidationFailed on the right field for %s and write nothing", async (_label, body, field) => {
                const id = await seedCompleted(h);
                const res = await postRecord(h, id, body, "doctor");
                expect(res.status).toBe(400);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toContain(field);
                expect(JSON.stringify(res.body)).not.toContain(CHIEF);
                expect(await recordRows()).toHaveLength(0);
                expect(await allRecordAudits()).toHaveLength(0);
            });

            it("should answer 400 for a body that is not a JSON object and for malformed JSON", async () => {
                const id = await seedCompleted(h);
                for (const raw of ["[]", '"text"', "5", "null", "{broken"]) {
                    const res = await h.call("post", `/api/consultations/${id}/record`, "doctor", undefined, { "Content-Type": "application/json" }).send(raw);
                    expect([raw, res.status]).toEqual([raw, 400]);
                    expectErrorEnvelope(res.body, "ValidationFailed");
                }
                expect(await recordRows()).toHaveLength(0);
            });

            it("should accept the boundary values: 3 and 2000 code points, followUpInDays 1 and 365, a newline in the text", async () => {
                const first = await seedCompleted(h);
                expect((await postRecord(h, first, { chiefComplaint: "abc", followUpInDays: 1 }, "doctor")).status).toBe(201);
                const second = await seedCompleted(h);
                expect((await postRecord(h, second, { chiefComplaint: "a".repeat(2000), followUpInDays: 365, examinationNotes: "line one\nline two", diagnosisCode: "A00" }, "doctor")).status).toBe(201);
                const third = await seedCompleted(h);
                expect((await postRecord(h, third, { chiefComplaint: "\u{1F600}".repeat(2000) }, "doctor")).status).toBe(201);
            });
        });
    });

    // ───────────────────────────────────────────── transactions (RC-R15)
    describe("atomicity of the write and its audit row", () => {
        it("should leave no record and no audit row when the audit insert of a create fails, and not hold the consultation afterwards", async () => {
            const id = await seedCompleted(h);
            await withFailingAudit("record.created", async () => {
                const res = await postRecord(h, id, recordBody(), "doctor");
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
                expect(JSON.stringify(res.body)).not.toContain(CHIEF);
            });
            expect(await recordRows()).toHaveLength(0);
            expect(await allRecordAudits()).toHaveLength(0);
            expect((await postRecord(h, id, recordBody(), "doctor")).status).toBe(201);
        });

        it("should write the record and its audit row in one database transaction", async () => {
            const id = await seedCompleted(h);
            await postRecord(h, id, recordBody(), "doctor");
            const xmin = async (table: string, where: string): Promise<string[]> =>
                (await ownerDb.raw(`SELECT xmin::text AS x FROM ${table} WHERE ${where}`)).rows.map((row: { x: string }) => row.x);
            expect(await xmin("medical_records", "true")).toEqual(await xmin("audit_logs", "action = 'record.created'"));
        });
    });

    // ───────────────────────────────────────────── concurrency (RC-R2, RC-R26)
    describe("concurrency", () => {
        it("should produce exactly one 201 and one 409 Conflict, one record row and one audit row for two simultaneous creates", async () => {
            for (let round = 0; round < 5; round += 1) {
                const id = await seedCompleted(h);
                const results = await Promise.all([postRecord(h, id, recordBody(), "doctor"), postRecord(h, id, recordBody({ chiefComplaint: "SYNTHETIC-CHIEF-RIVAL" }), "doctor")]);
                expect([round, results.map((res) => res.status).sort()]).toEqual([round, [201, 409]]);
                const loser = results.find((res) => res.status === 409);
                expectErrorEnvelope(loser?.body, "Conflict");
                expect((await recordRows()).filter((row) => row.consultation_id === id)).toHaveLength(1);
                expect((await audits("record.created")).filter((row) => (row.metadata as { consultationId: number }).consultationId === id)).toHaveLength(1);
            }
        });

        it("should keep the winner's content: the stored record is exactly one of the two bodies, never a mix", async () => {
            const id = await seedCompleted(h);
            const results = await Promise.all([
                postRecord(h, id, { chiefComplaint: "SYNTHETIC-CHIEF-A", treatmentPlan: "SYNTHETIC-PLAN-A" }, "doctor"),
                postRecord(h, id, { chiefComplaint: "SYNTHETIC-CHIEF-B", treatmentPlan: "SYNTHETIC-PLAN-B" }, "doctor"),
            ]);
            const winner = results.find((res) => res.status === 201);
            const [row] = await recordRows();
            expect([row?.chief_complaint, row?.treatment_plan]).toEqual(winner?.body.data.chiefComplaint === "SYNTHETIC-CHIEF-A" ? ["SYNTHETIC-CHIEF-A", "SYNTHETIC-PLAN-A"] : ["SYNTHETIC-CHIEF-B", "SYNTHETIC-PLAN-B"]);
        });

        it("should let a create for one consultation run beside a follow-up booking of another record without a deadlock", async () => {
            const first = await seedCompleted(h);
            const recordId = await createRecord(h, first);
            const second = await seedCompleted(h);
            const [created, booked] = await Promise.all([postRecord(h, second, recordBody(), "doctor"), h.book("patient", bookingBody({ followUpOfRecordId: recordId }))]);
            expect([created.status, booked.status]).toEqual([201, 201]);
            expect(booked.body.data.followUpOfRecordId).toBe(recordId);
        });

        it("should let in-place updates race a follow-up booking of the same record without a deadlock or a lost update", async () => {
            const recordId = await createRecord(h, await seedCompleted(h));
            for (let round = 0; round < 4; round += 1) {
                const [updated, booked] = await Promise.all([
                    patchRecord(h, recordId, { followUpInDays: 20 + round }, "doctor"),
                    h.book("patient", bookingBody({ followUpOfRecordId: recordId, startsAt: new Date(Date.now() + (4 + round) * 86_400_000).toISOString().replace(/T.*/, "T07:00:00.000Z") })),
                ]);
                expect([round, updated.status]).toEqual([round, 200]);
                expect([round, booked.status]).toEqual([round, 201]);
            }
            expect((await recordRows())[0]?.follow_up_in_days).toBe(23);
        });

        it("should serialize two simultaneous in-place updates so both land", async () => {
            const recordId = await createRecord(h, await seedCompleted(h), { chiefComplaint: CHIEF });
            const [a, b] = await Promise.all([patchRecord(h, recordId, { treatmentPlan: PLAN }, "doctor"), patchRecord(h, recordId, { examinationNotes: NOTES }, "doctor")]);
            expect([a.status, b.status]).toEqual([200, 200]);
            expect((await recordRows())[0]).toMatchObject({ treatment_plan: PLAN, examination_notes: NOTES });
            expect((await audits("record.updated")).map((row) => (row.metadata as { changedFields: string }).changedFields).sort()).toEqual(["examinationNotes", "treatmentPlan"]);
            expect(await amendmentRows()).toHaveLength(0);
        });
    });

    // ───────────────────────────────────────────── no Idempotency-Key, no Identity (RC-R19, RC-R24)
    describe("independence from the idempotency middleware and from Identity", () => {
        it("should ignore an Idempotency-Key on every record route: one key with different bodies is never an idempotency conflict and nothing is stored in Redis", async () => {
            const key = randomUUID();
            const withKey = { "Idempotency-Key": key };
            const recordId = await createRecord(h, await seedCompleted(h));
            const first = await h.call("patch", `/api/records/${recordId}`, "doctor", { treatmentPlan: "SYNTHETIC-PLAN-A" }, withKey);
            const second = await h.call("patch", `/api/records/${recordId}`, "doctor", { treatmentPlan: "SYNTHETIC-PLAN-B" }, withKey);
            expect([first.status, second.status]).toEqual([200, 200]);
            expect((await recordRows())[0]?.treatment_plan).toBe("SYNTHETIC-PLAN-B");
            expect((await h.call("get", `/api/records/${recordId}`, "patient", undefined, withKey)).status).toBe(200);
            expect((await h.call("get", `/api/patients/${PATIENT}/records`, "patient", undefined, withKey)).status).toBe(200);
            expect((await scanRedis()).filter((entry) => entry.key.startsWith("idem:"))).toEqual([]);
        });

        it("should serve all four record routes while Identity is down, without calling it (record DTOs carry user ids, never names)", async () => {
            h.identityServer.options.down = true;
            const callsBefore = h.identityServer.calls.length;
            const id = await seedCompleted(h);
            const created = await postRecord(h, id, recordBody(), "doctor");
            expect(created.status).toBe(201);
            const recordId = created.body.data.id as number;
            expect((await patchRecord(h, recordId, { treatmentPlan: "SYNTHETIC-PLAN-NEW" })).status).toBe(200);
            const read = await getRecord(h, recordId, "patient");
            expect(read.status).toBe(200);
            const page = await timeline(h, PATIENT, "doctor");
            expect(page.status).toBe(200);
            for (const body of [created.body, read.body, page.body]) expect(JSON.stringify(body)).not.toMatch(/displayName|avatarUrl|profileHydrated|fullName/);
            expect(h.identityServer.calls.length).toBe(callsBefore);
        });
    });

    // ───────────────────────────────────────────── account state and caller-supplied identity
    describe("principal handling", () => {
        it("should ignore caller-supplied identity headers: the verified token is the only principal", async () => {
            const id = await seedCompleted(h);
            const spoof = { "X-User-Id": String(DOCTOR), "X-Role": "doctor", "X-Forwarded-User": String(DOCTOR) };
            const asPatient = await h.call("post", `/api/consultations/${id}/record`, "patient", recordBody(), spoof);
            expect(asPatient.status).toBe(403);
            const asAdmin = await h.call("post", `/api/consultations/${id}/record`, "admin", recordBody(), spoof);
            expect(asAdmin.status).toBe(403);
            const stranger = await h.callWith(await h.signFor(STRANGER_DOCTOR, "doctor"), "post", `/api/consultations/${id}/record`, recordBody(), spoof);
            expect(stranger.status).toBe(404);
            expect(await recordRows()).toHaveLength(0);
        });

        it("should block a doctor suspended locally even though the token still says active", async () => {
            const id = await seedCompleted(h);
            await suspendLocally(DOCTOR);
            const res = await postRecord(h, id, recordBody(), "doctor");
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "Forbidden");
            expect(await recordRows()).toHaveLength(0);
        });
    });
});
