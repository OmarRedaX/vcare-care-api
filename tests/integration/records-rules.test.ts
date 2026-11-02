import { redis } from "../../src/lib/redis/redis";
import { db } from "../../src/lib/knex/knex";
import { checkViolationConstraint } from "../../src/lib/knex/pg-errors";
import { findById } from "../../src/app/records/repository/medical-records.repo";
import { contractNoStoreValue, expectErrorEnvelope, expectPaginationMeta } from "../helpers/contract";
import { DAY, DOCTOR, HOUR, OTHER_DOCTOR, OTHER_PATIENT, PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import {
    AMEND_REASON, amendmentRows, audits, captureQueries, CHIEF, createRecord, DX_CODE, DX_TEXT, getRecord, insertRecordRow, lockIn, lockNow, NOTES, patchRecord, PLAN, postRecord,
    PROFILE_ALLERGEN, provisionOtherDoctor, recordBody, recordRows, seedCompleted, seedProfile, timeline, withFailingAudit, allRecordAudits, type Row,
} from "../helpers/records-fixtures";

jest.setTimeout(120_000);

describe("records: update, lock, amendments, reads and the timeline (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("records-rules");

    /** A fresh unlocked record of the default pair, created through the real route. */
    const openRecord = async (body: Record<string, unknown> = recordBody()): Promise<number> => createRecord(h, await seedCompleted(h), body);
    const lockedRecord = async (body: Record<string, unknown> = recordBody()): Promise<number> => { const id = await openRecord(body); await lockNow(id); return id; };
    const xmin = async (id: number): Promise<string> => (await ownerDb.raw("SELECT xmin::text AS x FROM medical_records WHERE id = ?", [id])).rows[0].x as string;
    const rowOf = async (id: number): Promise<Row> => await ownerDb("medical_records").where({ id }).first() as Row;

    // ───────────────────────────────────────────── before the lock (RC-R6)
    describe("PATCH before the lock", () => {
        it("should update in place, answer 200 with the updated record and audit record.updated with the changed field names only", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            const res = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW", followUpInDays: 30 });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ id, treatmentPlan: "SYNTHETIC-PLAN-NEW", followUpInDays: 30, chiefComplaint: CHIEF, isLocked: false, amendments: [], attachments: [] });
            const after = await rowOf(id);
            expect(after).toMatchObject({ treatment_plan: "SYNTHETIC-PLAN-NEW", follow_up_in_days: 30, chief_complaint: CHIEF });
            expect(after.created_at).toEqual(before.created_at);
            expect(after.locked_at).toEqual(before.locked_at);
            expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
            const [row] = await audits("record.updated");
            expect(row).toMatchObject({ actor_user_id: DOCTOR, actor_role: "doctor", entity_type: "medical_record", entity_id: id, request_id: res.headers["x-request-id"] });
            expect(row?.metadata).toEqual({ consultationId: before.consultation_id, patientUserId: PATIENT, changedFields: "treatmentPlan,followUpInDays" });
            expect(await amendmentRows()).toHaveLength(0);
        });

        it("should be a no-op when every value equals the stored one: 200 with the current record, no record write, updated_at unchanged, exactly one record.read audit row (R-D7 as amended by M3)", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            const versionBefore = await xmin(id);
            const auditsBefore = await ownerDb("audit_logs").count<{ count: string }>("id as count").first();
            const res = await patchRecord(h, id, { chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisCode: DX_CODE, followUpInDays: 14 });
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ id, chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisCode: DX_CODE, followUpInDays: 14, isLocked: false });
            expect(await rowOf(id)).toEqual(before);
            expect(await xmin(id)).toBe(versionBefore);
            expect(await audits("record.updated", "record.amended")).toHaveLength(0);
            expect(await amendmentRows()).toHaveLength(0);
            const reads = await audits("record.read");
            expect(reads).toHaveLength(1);
            expect(reads[0]).toMatchObject({ actor_user_id: DOCTOR, actor_role: "doctor", entity_type: "medical_record", entity_id: id, request_id: res.headers["x-request-id"] });
            expect(reads[0]?.metadata).toEqual({ consultationId: before.consultation_id, patientUserId: PATIENT, viewerRole: "doctor", viaNoopPatch: true });
            expect(Number((await ownerDb("audit_logs").count<{ count: string }>("id as count").first())?.count) - Number(auditsBefore?.count)).toBe(1);
            for (const marker of [CHIEF, NOTES, DX_CODE]) expect(JSON.stringify(reads)).not.toContain(marker);
        });

        it("should fail the no-op PATCH with 500 and leave the record untouched when its record.read audit insert fails (the disclosure is never unaudited)", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            await withFailingAudit("record.read", async () => {
                const res = await patchRecord(h, id, { chiefComplaint: CHIEF });
                expect(res.status).toBe(500);
                expect(JSON.stringify(res.body)).not.toContain(CHIEF);
            });
            expect(await rowOf(id)).toEqual(before);
            expect(await audits("record.read")).toHaveLength(0);
        });

        it("should reject a pre-lock reason that is too short with 400 although a reason is not used before the lock (M16), and accept a valid one", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            const bad = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: "x" });
            expect(bad.status).toBe(400);
            expectErrorEnvelope(bad.body, "ValidationFailed");
            expect(bad.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(["reason"]);
            expect(await rowOf(id)).toEqual(before);
            const good = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: AMEND_REASON });
            expect(good.status).toBe(200);
            expect(await amendmentRows()).toHaveLength(0);
        });

        it("should write only the field that differs when one value is equal and one is different", async () => {
            const id = await openRecord();
            const res = await patchRecord(h, id, { chiefComplaint: CHIEF, treatmentPlan: "SYNTHETIC-PLAN-NEW" });
            expect(res.status).toBe(200);
            expect((await audits("record.updated"))[0]?.metadata).toMatchObject({ changedFields: "treatmentPlan" });
        });

        it("should set a field that was null, and treat it as a change", async () => {
            const id = await openRecord({ chiefComplaint: CHIEF });
            const res = await patchRecord(h, id, { diagnosisText: DX_TEXT });
            expect(res.status).toBe(200);
            expect(res.body.data.diagnosisText).toBe(DX_TEXT);
            expect((await audits("record.updated"))[0]?.metadata).toMatchObject({ changedFields: "diagnosisText" });
        });

        it("should ignore a reason before the lock: not stored, not audited, no amendment", async () => {
            const id = await openRecord();
            const res = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: AMEND_REASON });
            expect(res.status).toBe(200);
            expect(JSON.stringify(await recordRows())).not.toContain(AMEND_REASON);
            expect(JSON.stringify(await audits("record.updated"))).not.toContain(AMEND_REASON);
            expect(await amendmentRows()).toHaveLength(0);
            const equal = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: AMEND_REASON });
            expect(equal.status).toBe(200);
            expect(await audits("record.updated")).toHaveLength(1);
        });

        it("should answer 400 ValidationFailed on the body field for an empty body and for a reason-only body, touching nothing", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            for (const body of [{}, { reason: AMEND_REASON }]) {
                const res = await patchRecord(h, id, body);
                expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
                expectErrorEnvelope(res.body, "ValidationFailed");
                expect(res.body.error.details).toEqual([{ field: "body", issue: "must contain at least one record field" }]);
            }
            expect(await rowOf(id)).toEqual(before);
            expect(await audits("record.updated", "record.amended")).toHaveLength(0);
        });

        it.each([
            ["JSON null for a field (a field cannot be cleared)", { treatmentPlan: null }, "treatmentPlan"], ["a blank text", { examinationNotes: "   " }, "examinationNotes"],
            ["a two character chiefComplaint", { chiefComplaint: "ab" }, "chiefComplaint"], ["an invalid diagnosisCode", { diagnosisCode: "a00.1" }, "diagnosisCode"],
            ["followUpInDays 366", { followUpInDays: 366 }, "followUpInDays"], ["a two character reason", { treatmentPlan: PLAN, reason: "ab" }, "reason"],
            ["a NUL in the reason", { treatmentPlan: PLAN, reason: "ab\u0000c" }, "reason"], ["an unknown member", { patientUserId: 5, treatmentPlan: PLAN }, "patientUserId"],
            ["a locked_at override", { lockedAt: "2099-01-01T00:00:00Z", treatmentPlan: PLAN }, "lockedAt"],
        ])("should answer 400 on the right field for %s and change nothing", async (_label, body, field) => {
            const id = await openRecord();
            const before = await rowOf(id);
            const res = await patchRecord(h, id, body);
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toContain(field);
            expect(await rowOf(id)).toEqual(before);
        });
    });

    // ───────────────────────────────────────────── after the lock (RC-R7, RC-R10)
    describe("PATCH after the lock", () => {
        it("should append an amendment (201) and leave the original row byte for byte unchanged, auditing record.amended with ids, names and the reason length", async () => {
            const id = await lockedRecord();
            const before = await rowOf(id);
            const versionBefore = await xmin(id);
            const res = await patchRecord(h, id, { diagnosisText: "SYNTHETIC-DXTEXT-CORRECTED", followUpInDays: 21, reason: AMEND_REASON });
            expect(res.status).toBe(201);
            expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
            expect(res.body.data).toMatchObject({ recordId: id, authorUserId: DOCTOR, diagnosisText: "SYNTHETIC-DXTEXT-CORRECTED", followUpInDays: 21, reason: AMEND_REASON,
                chiefComplaint: null, examinationNotes: null, diagnosisCode: null, treatmentPlan: null });
            expect(Object.keys(res.body.data).sort()).toEqual(["authorUserId", "chiefComplaint", "createdAt", "diagnosisCode", "diagnosisText", "examinationNotes", "followUpInDays", "id", "reason", "recordId", "treatmentPlan"]);

            expect(await rowOf(id)).toEqual(before);
            expect(await xmin(id)).toBe(versionBefore);
            const amendments = await amendmentRows();
            expect(amendments).toHaveLength(1);
            expect(amendments[0]).toMatchObject({ id: res.body.data.id, medical_record_id: id, author_user_id: DOCTOR, diagnosis_text: "SYNTHETIC-DXTEXT-CORRECTED", follow_up_in_days: 21,
                reason: AMEND_REASON, chief_complaint: null, examination_notes: null, diagnosis_code: null, treatment_plan: null });
            const [audit] = await audits("record.amended");
            expect(audit).toMatchObject({ actor_user_id: DOCTOR, actor_role: "doctor", entity_type: "medical_record", entity_id: id, request_id: res.headers["x-request-id"] });
            expect(audit?.metadata).toEqual({ consultationId: before.consultation_id, patientUserId: PATIENT, amendmentId: res.body.data.id, changedFields: "diagnosisText,followUpInDays",
                reasonLength: AMEND_REASON.length });
            expect(await audits("record.updated")).toHaveLength(0);
        });

        it("should answer 400 on the reason field and write nothing when an amendment has no reason", async () => {
            const id = await lockedRecord();
            const before = await rowOf(id);
            const res = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(res.body.error.details).toEqual([{ field: "reason", issue: "is required after the record is locked" }]);
            expect(await rowOf(id)).toEqual(before);
            expect(await amendmentRows()).toHaveLength(0);
            expect(await audits("record.amended", "record.updated")).toHaveLength(0);
        });

        it("should append an amendment even when the value equals the stored one (no diff after the lock)", async () => {
            const id = await lockedRecord();
            const res = await patchRecord(h, id, { chiefComplaint: CHIEF, reason: AMEND_REASON });
            expect(res.status).toBe(201);
            expect(res.body.data.chiefComplaint).toBe(CHIEF);
            expect(await amendmentRows()).toHaveLength(1);
            const again = await patchRecord(h, id, { chiefComplaint: CHIEF, reason: AMEND_REASON });
            expect(again.status).toBe(201);
            expect(await amendmentRows()).toHaveLength(2);
            expect(await audits("record.amended")).toHaveLength(2);
        });

        it("should read amendments in append (id) order even when created_at is inverted by transaction start order (M7)", async () => {
            const id = await lockedRecord();
            const first = await patchRecord(h, id, { followUpInDays: 1, reason: AMEND_REASON });
            const second = await patchRecord(h, id, { followUpInDays: 2, reason: AMEND_REASON });
            expect([first.status, second.status]).toEqual([201, 201]);
            // A double submit whose later-appended amendment began its transaction earlier: the owner inverts created_at to reproduce it.
            await ownerDb("medical_record_amendments").where({ id: second.body.data.id }).update({ created_at: new Date(Date.now() - 3_600_000) });
            await ownerDb("medical_record_amendments").where({ id: first.body.data.id }).update({ created_at: new Date() });
            for (const actor of ["patient", "doctor"] as const) {
                const read = await getRecord(h, id, actor);
                expect(read.body.data.amendments.map((amendment: { id: number }) => amendment.id)).toEqual([first.body.data.id, second.body.data.id]);
            }
            const page = await timeline(h, PATIENT, "patient");
            const item = (page.body.data.records as Array<{ id: number; amendments: Array<{ id: number }> }>).find((record) => record.id === id);
            expect(item?.amendments.map((amendment) => amendment.id)).toEqual([first.body.data.id, second.body.data.id]);
        });

        it("should keep many amendments in the order they were made and show them oldest first on the next read, for the patient and the doctor", async () => {
            const id = await lockedRecord();
            const sent: number[] = [];
            for (let index = 1; index <= 6; index += 1) {
                const res = await patchRecord(h, id, { followUpInDays: index, reason: `${AMEND_REASON}-${index}` });
                expect(res.status).toBe(201);
                sent.push(res.body.data.id as number);
            }
            for (const actor of ["patient", "doctor"] as const) {
                const read = await getRecord(h, id, actor);
                expect(read.status).toBe(200);
                expect(read.body.data.isLocked).toBe(true);
                expect(read.body.data.amendments.map((amendment: { id: number }) => amendment.id)).toEqual(sent);
                expect(read.body.data.amendments.map((amendment: { followUpInDays: number }) => amendment.followUpInDays)).toEqual([1, 2, 3, 4, 5, 6]);
                expect(read.body.data.amendments[5].reason).toBe(`${AMEND_REASON}-6`);
            }
            const stored = await rowOf(id);
            expect(stored.follow_up_in_days).toBe(14);
        });

        it("should reject clearing a field with JSON null after the lock (an amendment cannot erase a value) and write nothing", async () => {
            const id = await lockedRecord();
            const res = await patchRecord(h, id, { treatmentPlan: null, reason: AMEND_REASON });
            expect(res.status).toBe(400);
            expect(await amendmentRows()).toHaveLength(0);
        });

        it("should reject a reason-only body after the lock with the empty-body error, before the missing-record-field rule could be misread as a reason problem", async () => {
            const id = await lockedRecord();
            const res = await patchRecord(h, id, { reason: AMEND_REASON });
            expect(res.status).toBe(400);
            expect(res.body.error.details).toEqual([{ field: "body", issue: "must contain at least one record field" }]);
        });

        it("should answer 403 NotAssignedDoctor to a related doctor who is not the author and add no amendment", async () => {
            await provisionOtherDoctor(h);
            const id = await lockedRecord();
            const res = await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON }, "otherDoctor");
            expect(res.status).toBe(403);
            expectErrorEnvelope(res.body, "NotAssignedDoctor");
            expect(await amendmentRows()).toHaveLength(0);
        });

        it("should roll the amendment back and keep the record when the audit insert fails", async () => {
            const id = await lockedRecord();
            await withFailingAudit("record.amended", async () => {
                const res = await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON });
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
                expect(JSON.stringify(res.body)).not.toContain(PLAN);
            });
            expect(await amendmentRows()).toHaveLength(0);
            expect(await audits("record.amended")).toHaveLength(0);
            expect((await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON })).status).toBe(201);
        });

        it("should roll the in-place update back and keep the old values when the audit insert fails", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            await withFailingAudit("record.updated", async () => {
                const res = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
                expect(res.status).toBe(500);
            });
            expect(await rowOf(id)).toEqual(before);
            expect(await audits("record.updated")).toHaveLength(0);
        });
    });

    // ───────────────────────────────────────────── the lock boundary: database time (RC-R5, RC-R8)
    describe("the lock boundary", () => {
        it("should decide the lock with the transaction clock at the boundary: locked_at = NOW() is locked, one microsecond later is not", async () => {
            const [atNow, justAfter] = [await seedCompleted(h), await seedCompleted(h)];
            await db.transaction(async (trx) => {
                const ids: number[] = [];
                for (const [consultationId, offset] of [[atNow, "0 microseconds"], [justAfter, "1 microsecond"]] as const) {
                    const inserted = await trx.raw(`INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at)
                        VALUES (?, ?, ?, ?, NOW() - interval '24 hours' + interval '${offset}', NOW(), NOW() + interval '${offset}') RETURNING id`, [consultationId, PATIENT, DOCTOR, CHIEF]);
                    ids.push(inserted.rows[0].id as number);
                }
                expect((await findById(ids[0] as number, trx))?.isLocked).toBe(true);
                expect((await findById(ids[1] as number, trx))?.isLocked).toBe(false);
                // The trigger agrees with the flag, in the same transaction: the open row can be updated.
                await trx.raw("UPDATE medical_records SET treatment_plan = ? WHERE id = ?", [PLAN, ids[1] as number]);
            });
        });

        it("should make the trigger refuse an UPDATE once locked_at <= NOW(), naming the trigger as the constraint (equality case, one transaction)", async () => {
            const consultationId = await seedCompleted(h);
            let failure: unknown;
            try {
                await db.transaction(async (trx) => {
                    await trx.raw(`INSERT INTO medical_records (consultation_id, patient_user_id, doctor_user_id, chief_complaint, created_at, updated_at, locked_at)
                        VALUES (?, ?, ?, ?, NOW() - interval '24 hours', NOW(), NOW())`, [consultationId, PATIENT, DOCTOR, CHIEF]);
                    await trx.raw("UPDATE medical_records SET treatment_plan = ? WHERE consultation_id = ?", [PLAN, consultationId]);
                });
            } catch (error) { failure = error; }
            expect(checkViolationConstraint(failure)).toBe("trg_medical_records_forbid_update_after_lock");
            expect(await recordRows()).toHaveLength(0);
        });

        it("should update in place at a moment just before the lock and amend at and after it, through the route", async () => {
            const before = await openRecord();
            await lockIn(before, 20_000);
            const inPlace = await patchRecord(h, before, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
            expect(inPlace.status).toBe(200);
            expect(inPlace.body.data.isLocked).toBe(false);

            const atLock = await openRecord();
            await lockIn(atLock, 0);
            const first = await patchRecord(h, atLock, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: AMEND_REASON });
            expect(first.status).toBe(201);

            const after = await openRecord();
            await lockIn(after, -3_600_000);
            const second = await patchRecord(h, after, { treatmentPlan: "SYNTHETIC-PLAN-NEW", reason: AMEND_REASON });
            expect(second.status).toBe(201);
            expect((await rowOf(after)).treatment_plan).toBe(PLAN);
        });

        it("should report isLocked from database time on read, flipping with the lock", async () => {
            const id = await openRecord();
            expect((await getRecord(h, id, "patient")).body.data.isLocked).toBe(false);
            await lockNow(id);
            const locked = await getRecord(h, id, "patient");
            expect(locked.body.data.isLocked).toBe(true);
            expect(Date.parse(locked.body.data.lockedAt) - Date.parse(locked.body.data.createdAt)).toBe(24 * HOUR);
        });

        it("should answer 409 RecordLocked, change nothing and audit nothing when the trigger refuses an in-place update the service allowed", async () => {
            const id = await openRecord();
            const before = await rowOf(id);
            const original = (await ownerDb.raw("SELECT pg_get_functiondef('forbid_update_after_lock'::regproc) AS def")).rows[0].def as string;
            // A trigger that refuses every update stands in for any row altered outside the service between the lock flag and the write.
            await ownerDb.raw(`CREATE OR REPLACE FUNCTION forbid_update_after_lock() RETURNS trigger AS $$
                BEGIN RAISE EXCEPTION 'record % is locked', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_medical_records_forbid_update_after_lock'; END $$ LANGUAGE plpgsql;`);
            try {
                const res = await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
                expect(res.status).toBe(409);
                expectErrorEnvelope(res.body, "RecordLocked");
                expect(JSON.stringify(res.body)).not.toContain("SYNTHETIC-PLAN-NEW");
            } finally {
                await ownerDb.raw(original);
            }
            expect(await rowOf(id)).toEqual(before);
            expect(await audits("record.updated")).toHaveLength(0);
            expect((await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" })).status).toBe(200);
        });

        it("should refuse a direct UPDATE of a locked record for the app role and for the owner, a soft delete included", async () => {
            const id = await lockedRecord();
            const before = await rowOf(id);
            for (const conn of [db, ownerDb]) {
                for (const change of [{ treatment_plan: PLAN }, { deleted_at: new Date() }, { chief_complaint: "SYNTHETIC-CHIEF-OTHER" }]) {
                    let failure: unknown;
                    try { await conn("medical_records").where({ id }).update(change); } catch (error) { failure = error; }
                    const column = Object.keys(change)[0];
                    if (conn === db && column === "deleted_at") {
                        // M5: the app role holds no UPDATE on deleted_at, so the statement never reaches the trigger.
                        expect([column, (failure as { code?: string }).code]).toEqual([column, "42501"]);
                    } else {
                        expect([column, checkViolationConstraint(failure)]).toEqual([column, "trg_medical_records_forbid_update_after_lock"]);
                    }
                }
            }
            expect(await rowOf(id)).toEqual(before);
        });

        it("should let the owner shift an unlocked record in time only while it stays consistent (the lock CHECK rejects a lone locked_at change)", async () => {
            const id = await openRecord();
            await expect(ownerDb("medical_records").where({ id }).update({ locked_at: new Date(Date.now() + 99 * DAY) })).rejects.toMatchObject({ code: "23514", constraint: "chk_medical_records_lock" });
        });
    });

    // ───────────────────────────────────────────── GET /records/{id} (RC-R12, RC-R14)
    describe("GET /records/{id}", () => {
        it("should answer 200 with the record, no-store, and write one record.read audit row with the viewer and the amendment count", async () => {
            const id = await lockedRecord();
            await patchRecord(h, id, { followUpInDays: 3, reason: AMEND_REASON });
            const res = await getRecord(h, id, "patient");
            expect(res.status).toBe(200);
            expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
            expect(res.body.data).toMatchObject({ id, chiefComplaint: CHIEF, isLocked: true, attachments: [] });
            expect(res.body.data.amendments).toHaveLength(1);
            const [row] = await audits("record.read");
            expect(row).toMatchObject({ actor_user_id: PATIENT, actor_role: "patient", entity_type: "medical_record", entity_id: id, request_id: res.headers["x-request-id"] });
            expect(row?.metadata).toEqual({ consultationId: (await rowOf(id)).consultation_id, patientUserId: PATIENT, viewerRole: "patient", viewerIsAuthor: false, amendmentCount: 1 });
        });

        it("should mark the author and a consulted doctor differently in the audit metadata and write one row per read", async () => {
            await provisionOtherDoctor(h);
            const id = await openRecord();
            expect((await getRecord(h, id, "doctor")).status).toBe(200);
            expect((await getRecord(h, id, "otherDoctor")).status).toBe(200);
            const rows = await audits("record.read");
            expect(rows.map((row) => [row.actor_user_id, row.actor_role, (row.metadata as Record<string, unknown>).viewerIsAuthor])).toEqual([[DOCTOR, "doctor", true], [OTHER_DOCTOR, "doctor", false]]);
        });

        it("should answer 404 for an unknown, non-numeric or zero id and write no audit row", async () => {
            for (const missing of ["999999", "abc", "0", "-1", "1.5"]) {
                for (const actor of ["patient", "doctor"] as const) {
                    const res = await getRecord(h, missing, actor);
                    expect([actor, missing, res.status]).toEqual([actor, missing, 404]);
                    expectErrorEnvelope(res.body, "NotFound");
                }
            }
            expect(await audits("record.read")).toHaveLength(0);
        });

        it("should answer 400 for any query member, without an audit row", async () => {
            const id = await openRecord();
            const res = await getRecord(h, `${id}?expand=amendments`, "patient");
            expect(res.status).toBe(400);
            expectErrorEnvelope(res.body, "ValidationFailed");
            expect(await audits("record.read")).toHaveLength(0);
        });

        it("should fail closed with 500 and no clinical text, and write no row, when the read audit fails", async () => {
            const id = await openRecord();
            await withFailingAudit("record.read", async () => {
                const res = await getRecord(h, id, "patient");
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
                for (const text of [CHIEF, NOTES, DX_TEXT, PLAN]) expect(JSON.stringify(res.body)).not.toContain(text);
            });
            expect(await audits("record.read")).toHaveLength(0);
            expect((await getRecord(h, id, "patient")).status).toBe(200);
        });

        it("should hide a soft-deleted record with 404 everywhere", async () => {
            const id = await openRecord();
            await ownerDb("medical_records").where({ id }).update({ deleted_at: new Date() });
            expect((await getRecord(h, id, "patient")).status).toBe(404);
            expect((await getRecord(h, id, "doctor")).status).toBe(404);
            expect((await patchRecord(h, id, { treatmentPlan: PLAN })).status).toBe(404);
            expect((await timeline(h, PATIENT, "patient")).body.data.records).toEqual([]);
        });
    });

    // ───────────────────────────────────────────── the timeline (RC-R16)
    describe("GET /patients/{patientUserId}/records", () => {
        /** Seeds `count` records for the default pair, newest last created; returns them as the database ordered them (created_at desc, id desc). */
        async function seedTimeline(count: number, tieAt?: number[]): Promise<number[]> {
            const base = Date.now() - 30 * DAY;
            const ids: number[] = [];
            for (let index = 0; index < count; index += 1) {
                const created = new Date(base + (tieAt?.includes(index) ? Math.min(...tieAt) : index) * HOUR);
                ids.push(await insertRecordRow(await seedCompleted(h), { created_at: created }));
            }
            const rows = await ownerDb("medical_records").select("id", "created_at").whereIn("id", ids);
            return rows.sort((a: Row, b: Row) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id).map((row: Row) => row.id as number);
        }
        const pageIds = (res: { body: { data: { records: Array<{ id: number }> } } }): number[] => res.body.data.records.map((record) => record.id);

        it("should answer page 1 and page 2 on the default sort with an exact boundary: 21 records give 20 then 1, the last page has no cursor", async () => {
            const expected = await seedTimeline(21);
            const first = await timeline(h, PATIENT, "patient");
            expect(first.status).toBe(200);
            expect(first.headers["cache-control"]).toBe(contractNoStoreValue());
            expect(pageIds(first)).toEqual(expected.slice(0, 20));
            expect(expectPaginationMeta(first.body.meta)).toEqual({ nextCursor: expect.any(String), hasMore: true, count: 20 });
            const second = await timeline(h, PATIENT, "patient", `?cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`);
            expect(second.status).toBe(200);
            expect(pageIds(second)).toEqual(expected.slice(20));
            expect(second.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
        });

        it("should report hasMore false and no cursor when the records fit exactly in one page", async () => {
            await seedTimeline(20);
            const res = await timeline(h, PATIENT, "patient");
            expect(res.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 20 });
        });

        it("should return an empty page with count 0 for a patient without records", async () => {
            const res = await timeline(h, PATIENT, "patient");
            expect(res.status).toBe(200);
            expect(res.body.data.records).toEqual([]);
            expect(res.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
        });

        it("should page newest first with created_at ties broken by id, with no gap or repeat, even when a tie straddles a page boundary", async () => {
            // Records 3, 4 and 5 share one timestamp; a page size of 4 puts the boundary inside the tie.
            const expected = await seedTimeline(9, [3, 4, 5]);
            const seen: number[] = [];
            let cursor: string | null = null;
            let pages = 0;
            do {
                const res: Awaited<ReturnType<typeof timeline>> = await timeline(h, PATIENT, "patient", `?limit=4${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
                expect(res.status).toBe(200);
                seen.push(...pageIds(res));
                cursor = res.body.meta.nextCursor as string | null;
                pages += 1;
            } while (cursor !== null && pages < 10);
            expect(pages).toBe(3);
            expect(seen).toEqual(expected);
            expect(new Set(seen).size).toBe(9);
        });

        it("should accept limits 1 and 100 and answer 400 on the limit field for 0, 101 and a non-number, and on a malformed cursor", async () => {
            await seedTimeline(2);
            expect(pageIds(await timeline(h, PATIENT, "patient", "?limit=1"))).toHaveLength(1);
            expect((await timeline(h, PATIENT, "patient", "?limit=100")).status).toBe(200);
            for (const limit of ["0", "101", "abc", "-1"]) {
                const res = await timeline(h, PATIENT, "patient", `?limit=${limit}`);
                expect([limit, res.status]).toEqual([limit, 400]);
                expect(res.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(["limit"]);
            }
            for (const cursor of ["not-a-cursor", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["2030-01-01T00:00:00Z",5]').toString("base64url"), Buffer.from('["0000-01-01T00:00:00.000000Z",5]').toString("base64url")]) {
                const res = await timeline(h, PATIENT, "patient", `?cursor=${cursor}`);
                expect([cursor, res.status]).toEqual([cursor, 400]);
                expect(res.body.error.details).toEqual([{ field: "cursor", issue: "is invalid" }]);
            }
            expect((await timeline(h, PATIENT, "patient", "?sort=asc")).status).toBe(400);
            expect(await audits("patient_records.listed")).toHaveLength(2);
        });

        it("should repeat data.patient identically on every page and give a doctor the same clinical profile as the patient", async () => {
            await seedProfile(PATIENT);
            await seedTimeline(5);
            const first = await timeline(h, PATIENT, "patient", "?limit=2");
            const second = await timeline(h, PATIENT, "patient", `?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`);
            expect(first.body.data.patient).toMatchObject({ userId: PATIENT, allergies: [PROFILE_ALLERGEN], timezone: "Africa/Cairo" });
            expect(second.body.data.patient).toEqual(first.body.data.patient);
            const asDoctor = await timeline(h, PATIENT, "doctor", "?limit=2");
            expect(asDoctor.body.data.patient).toEqual(first.body.data.patient);
        });

        it("should answer patient null when the patient has no profile row yet, on every page", async () => {
            await seedTimeline(3);
            const first = await timeline(h, PATIENT, "doctor", "?limit=2");
            const second = await timeline(h, PATIENT, "doctor", `?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`);
            expect(first.status).toBe(200);
            expect(first.body.data.patient).toBeNull();
            expect(second.body.data.patient).toBeNull();
            expect(first.body.data.records).toHaveLength(2);
        });

        it("should list the records of every doctor for the patient and attach each record's amendments to the right record", async () => {
            await provisionOtherDoctor(h);
            const mine = await lockedRecord();
            const theirs = await createRecord(h, await seedCompleted(h, { doctor_user_id: OTHER_DOCTOR }), recordBody(), "otherDoctor");
            await lockNow(theirs);
            expect((await patchRecord(h, mine, { followUpInDays: 5, reason: AMEND_REASON })).status).toBe(201);
            expect((await patchRecord(h, theirs, { followUpInDays: 6, reason: AMEND_REASON }, "otherDoctor")).status).toBe(201);
            expect((await patchRecord(h, theirs, { followUpInDays: 7, reason: AMEND_REASON }, "otherDoctor")).status).toBe(201);
            const res = await timeline(h, PATIENT, "doctor");
            expect(res.status).toBe(200);
            const byId = new Map<number, Row>(res.body.data.records.map((record: Row) => [record.id as number, record]));
            expect([...byId.keys()].sort()).toEqual([mine, theirs].sort());
            expect(byId.get(mine)).toMatchObject({ doctorUserId: DOCTOR });
            expect(byId.get(theirs)).toMatchObject({ doctorUserId: OTHER_DOCTOR });
            expect(byId.get(mine)?.amendments.map((amendment: Row) => [amendment.recordId, amendment.followUpInDays])).toEqual([[mine, 5]]);
            expect(byId.get(theirs)?.amendments.map((amendment: Row) => [amendment.recordId, amendment.followUpInDays])).toEqual([[theirs, 6], [theirs, 7]]);
        });

        it("should write exactly one patient_records.listed row per call, empty pages included, with counts and no patient_profile.read row", async () => {
            await seedProfile(PATIENT);
            await seedTimeline(3);
            await timeline(h, PATIENT, "patient", "?limit=2");
            const second = await timeline(h, PATIENT, "doctor", `?limit=2&cursor=${encodeURIComponent((await timeline(h, PATIENT, "doctor", "?limit=2")).body.meta.nextCursor as string)}`);
            expect(second.status).toBe(200);
            await ownerDb("medical_records").del();
            await timeline(h, PATIENT, "patient");
            const rows = await audits("patient_records.listed");
            expect(rows.map((row) => [row.actor_user_id, row.actor_role, row.entity_type, row.entity_id, row.metadata])).toEqual([
                [PATIENT, "patient", "patient_records", PATIENT, { patientUserId: PATIENT, viewerRole: "patient", recordCount: 2, hasMore: true, firstPage: true }],
                [DOCTOR, "doctor", "patient_records", PATIENT, { patientUserId: PATIENT, viewerRole: "doctor", recordCount: 2, hasMore: true, firstPage: true }],
                [DOCTOR, "doctor", "patient_records", PATIENT, { patientUserId: PATIENT, viewerRole: "doctor", recordCount: 1, hasMore: false, firstPage: false }],
                [PATIENT, "patient", "patient_records", PATIENT, { patientUserId: PATIENT, viewerRole: "patient", recordCount: 0, hasMore: false, firstPage: true }],
            ]);
            expect(rows.every((row) => typeof row.request_id === "string")).toBe(true);
            expect(await audits("patient_profile.read")).toHaveLength(0);
        });

        it("should load the amendments of a whole page with one query and the profile with one query, and read the amendments of an empty page with none", async () => {
            await seedProfile(PATIENT);
            await seedTimeline(6);
            const full = await captureQueries(() => timeline(h, PATIENT, "doctor", "?limit=5"));
            expect(full.result.status).toBe(200);
            expect(full.sql.filter((sql) => sql.includes("medical_record_amendments"))).toHaveLength(1);
            expect(full.sql.filter((sql) => sql.includes('from "medical_records"'))).toHaveLength(1);
            expect(full.sql.filter((sql) => sql.includes("patient_profiles"))).toHaveLength(1);
            expect(full.sql.filter((sql) => sql.includes("audit_logs"))).toHaveLength(1);
            await ownerDb("medical_records").del();
            const empty = await captureQueries(() => timeline(h, PATIENT, "doctor"));
            expect(empty.sql.filter((sql) => sql.includes("medical_record_amendments"))).toHaveLength(0);
            expect(empty.sql.filter((sql) => sql.includes("audit_logs"))).toHaveLength(1);
        });

        it("should fail closed with 500, no clinical text and no listed row when the timeline audit fails", async () => {
            await seedProfile(PATIENT);
            await seedTimeline(2);
            await withFailingAudit("patient_records.listed", async () => {
                const res = await timeline(h, PATIENT, "patient");
                expect(res.status).toBe(500);
                expectErrorEnvelope(res.body, "InternalError");
                for (const text of [CHIEF, PROFILE_ALLERGEN]) expect(JSON.stringify(res.body)).not.toContain(text);
            });
            expect(await audits("patient_records.listed")).toHaveLength(0);
        });

        it("should ignore soft-deleted records and other patients' records", async () => {
            const kept = await seedTimeline(2);
            const deleted = await insertRecordRow(await seedCompleted(h), { deleted_at: new Date() });
            const other = await insertRecordRow(await seedCompleted(h, { patient_user_id: OTHER_PATIENT }), { patient_user_id: OTHER_PATIENT });
            const res = await timeline(h, PATIENT, "patient");
            expect(pageIds(res)).toEqual(kept);
            expect(pageIds(res)).not.toContain(deleted);
            expect(pageIds(res)).not.toContain(other);
        });
    });

    // ───────────────────────────────────────────── rate limits (RC-R20)
    describe("rate limits", () => {
        it("should answer 429 with Retry-After on the 21st record write in a minute, creates and patches sharing one bucket, while reads keep their own budget", async () => {
            const id = await openRecord();
            for (let index = 0; index < 9; index += 1) expect((await patchRecord(h, id, { chiefComplaint: CHIEF })).status).toBe(200);
            for (let index = 0; index < 10; index += 1) expect((await postRecord(h, await seedCompleted(h), { chiefComplaint: CHIEF }, "doctor")).status).toBe(201);
            const limited = await patchRecord(h, id, { chiefComplaint: CHIEF });
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited");
            expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expect(limited.headers["cache-control"]).toBe(contractNoStoreValue());
            const alsoLimited = await postRecord(h, await seedCompleted(h), { chiefComplaint: CHIEF }, "doctor");
            expect(alsoLimited.status).toBe(429);
            expect(await redis.exists(`rl:records-write-user:${DOCTOR}`)).toBe(1);
            expect((await getRecord(h, id, "doctor")).status).toBe(200);
            expect((await timeline(h, PATIENT, "doctor")).status).toBe(200);
        });

        it("should answer 429 on the 121st read of one record and keep the budget per user", async () => {
            const id = await openRecord();
            for (let index = 0; index < 120; index += 1) expect((await getRecord(h, id, "patient")).status).toBe(200);
            const limited = await getRecord(h, id, "patient");
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited");
            expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            expect(await redis.exists(`rl:records-read-user:${PATIENT}`)).toBe(1);
            expect((await getRecord(h, id, "doctor")).status).toBe(200);
            expect((await timeline(h, PATIENT, "patient")).status).toBe(200);
        });

        it("should answer 429 on the 61st timeline read and spend nothing for an admin whose calls are denied", async () => {
            await seedCompleted(h);
            for (let index = 0; index < 5; index += 1) expect((await timeline(h, PATIENT, "admin")).status).toBe(403);
            expect(await redis.exists(`rl:records-timeline-user:303`)).toBe(0);
            for (let index = 0; index < 60; index += 1) expect((await timeline(h, PATIENT, "patient")).status).toBe(200);
            const limited = await timeline(h, PATIENT, "patient");
            expect(limited.status).toBe(429);
            expectErrorEnvelope(limited.body, "RateLimited");
            expect(await redis.exists(`rl:records-timeline-user:${PATIENT}`)).toBe(1);
            expect((await timeline(h, PATIENT, "doctor")).status).toBe(200);
        });
    });

    // ───────────────────────────────────────────── audit coverage (RC-R14, RC-R15)
    describe("audit rows", () => {
        it("should write one clinical-free row per successful write and read and none for a denied, invalid, missing or conflicting request", async () => {
            const consultationId = await seedCompleted(h);
            const stranger = await h.signFor(205, "doctor");
            // Denied / invalid / missing / conflicting requests first: none may leave a row.
            await postRecord(h, consultationId, { chiefComplaint: "x" }, "doctor");
            await postRecord(h, consultationId, recordBody(), "patient");
            await postRecord(h, consultationId, recordBody(), "admin");
            await h.callWith(stranger, "post", `/api/consultations/${consultationId}/record`, recordBody());
            await postRecord(h, 999999, recordBody(), "doctor");
            expect(await allRecordAudits()).toHaveLength(0);

            const id = await createRecord(h, consultationId);
            await postRecord(h, consultationId, recordBody(), "doctor");
            await patchRecord(h, id, {}, "doctor");
            await patchRecord(h, id, { chiefComplaint: CHIEF }, "doctor");
            await getRecord(h, 999999, "patient");
            await getRecord(h, id, "admin");
            await timeline(h, PATIENT, "admin");
            await timeline(h, OTHER_PATIENT, "patient");
            await timeline(h, "me", "patient");
            // The equal-value PATCH above is the only success besides the create: it is audited as a read (M3), nothing else is.
            const early = await allRecordAudits();
            expect(early.map((row) => row.action)).toEqual(["record.created", "record.read"]);
            expect(early[1]?.metadata).toMatchObject({ viewerRole: "doctor", viaNoopPatch: true });
            await getRecord(h, id, "patient");
            await timeline(h, PATIENT, "doctor");
            await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" }, "doctor");
            await lockNow(id);
            await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON }, "doctor");
            const rows = await allRecordAudits();
            expect(rows.map((row) => row.action)).toEqual(["record.created", "record.read", "record.read", "patient_records.listed", "record.updated", "record.amended"]);
            const flat = JSON.stringify(rows);
            for (const text of [CHIEF, NOTES, DX_TEXT, PLAN, AMEND_REASON, "SYNTHETIC-PLAN-NEW", DX_CODE]) expect(flat).not.toContain(text);
        });

        it("should list the record audit rows to an admin through GET /api/audit-logs without any clinical content", async () => {
            const id = await openRecord();
            await patchRecord(h, id, { treatmentPlan: "SYNTHETIC-PLAN-NEW" });
            await lockNow(id);
            await patchRecord(h, id, { followUpInDays: 3, reason: AMEND_REASON });
            await getRecord(h, id, "patient");
            await timeline(h, PATIENT, "patient");
            const byRecord = await h.call("get", `/api/audit-logs?entityType=medical_record&entityId=${id}`, "admin");
            expect(byRecord.status).toBe(200);
            expect(byRecord.body.data.map((row: Row) => row.action).sort()).toEqual(["record.amended", "record.created", "record.read", "record.updated"]);
            const byTimeline = await h.call("get", `/api/audit-logs?entityType=patient_records&entityId=${PATIENT}`, "admin");
            expect(byTimeline.body.data.map((row: Row) => row.action)).toEqual(["patient_records.listed"]);
            const flat = JSON.stringify([byRecord.body, byTimeline.body]);
            for (const text of [CHIEF, NOTES, DX_TEXT, PLAN, AMEND_REASON, "SYNTHETIC-PLAN-NEW"]) expect(flat).not.toContain(text);
        });
    });
});
