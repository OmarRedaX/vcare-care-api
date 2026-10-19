import { OTHER_PATIENT, PATIENT } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { ATTACH_DESC, useAttachmentsHarness } from "../helpers/record-attachments-fixtures";
import {
    AMEND_REASON, captureQueries, createRecord, getRecord, lockNow, patchRecord, PLAN, postRecord, provisionOtherDoctor, recordBody, seedCompleted, timeline,
} from "../helpers/records-fixtures";

jest.setTimeout(120_000);

type Listed = { id: number; recordId: number; fileType: string; sizeBytes: number; description: string | null; createdAt: string };

describe("record attachments in the record views (integration: real routes, Postgres, Redis; storage, Identity and video faked)", () => {
    const { h, newRecord, seedAttachments, addOk } = useAttachmentsHarness("record-attachments-links");

    /** Seeds `descriptions.length` live attachments in order (ids ascend) and returns their ids. */
    const seedDescribed = async (recordId: number, descriptions: Array<string | null>, changes: Record<string, unknown> = {}): Promise<number[]> => {
        const ids: number[] = [];
        for (const description of descriptions) ids.push(...await seedAttachments(recordId, 1, { description, ...changes }));
        return ids;
    };
    const attachmentsOf = (body: { data: { attachments?: Listed[]; records?: Array<{ id: number; attachments: Listed[] }> } }, recordId?: number): Listed[] =>
        recordId === undefined ? body.data.attachments ?? [] : body.data.records?.find((record) => record.id === recordId)?.attachments ?? [];
    /** Classifies a recorded statement the way the explain test does. */
    const kindOf = (sql: string): string => /medical_record_amendments/.test(sql) ? "amendments" : /record_attachments/.test(sql) ? "attachments" : /patient_profiles/.test(sql) ? "profile"
        : /audit_logs/.test(sql) ? "audit" : /medical_records/.test(sql) ? "record" : "other";
    const kinds = (sql: string[]): string[] => sql.filter((statement) => !/^(begin|commit|rollback)/i.test(statement)).map(kindOf);
    /** The statements of the service itself: the route's authorization statements (access row, suspension, relationship) come first and are not part of the documented count. */
    const tail = (sql: string[], count: number): string[] => kinds(sql).slice(-count);
    const countOf = (sql: string[], kind: string): number => kinds(sql).filter((entry) => entry === kind).length;

    // ───────────────────────────────────────────── GET /records/{id}
    describe("GET /records/{id}", () => {
        it("should list the live attachments oldest first, metadata only, hiding deleted ones, for the patient and the author", async () => {
            const recordId = await newRecord();
            const [first, second, third] = await seedDescribed(recordId, [ATTACH_DESC, null, "third"]);
            await ownerDb("record_attachments").where({ id: second }).update({ deleted_at: new Date() });
            for (const actor of ["patient", "doctor"] as const) {
                const res = await getRecord(h, recordId, actor);
                expect(res.status).toBe(200);
                const listed = attachmentsOf(res.body);
                expect(listed.map((item) => item.id)).toEqual([first, third]);
                expect(listed.map((item) => item.description)).toEqual([ATTACH_DESC, "third"]);
                expect(listed.every((item) => item.recordId === recordId && item.fileType === "application/pdf" && item.sizeBytes === 100)).toBe(true);
                expect(listed.map((item) => Object.keys(item).sort())).toEqual([["createdAt", "description", "fileType", "id", "recordId", "sizeBytes"], ["createdAt", "description", "fileType", "id", "recordId", "sizeBytes"]]);
            }
        });

        it("should answer [] for a record without attachments and for one whose attachments are all deleted", async () => {
            const bare = await newRecord();
            expect(attachmentsOf((await getRecord(h, bare, "patient")).body)).toEqual([]);
            const emptied = await newRecord();
            await seedDescribed(emptied, ["a", "b"], { deleted_at: new Date() });
            expect(attachmentsOf((await getRecord(h, emptied, "patient")).body)).toEqual([]);
        });

        it("should never show another record's or another patient's attachments", async () => {
            const mine = await newRecord();
            const theirs = await createRecord(h, await seedCompleted(h, { patient_user_id: OTHER_PATIENT }));
            const [mineId] = await seedDescribed(mine, ["mine"]);
            const [theirId] = await seedDescribed(theirs, ["theirs"]);
            expect(attachmentsOf((await getRecord(h, mine, "patient")).body).map((item) => item.id)).toEqual([mineId]);
            expect(attachmentsOf((await getRecord(h, theirs, "otherPatient")).body).map((item) => item.id)).toEqual([theirId]);
        });

        it("should show attachments added after the lock alongside the amendments", async () => {
            const recordId = await newRecord();
            await lockNow(recordId);
            const id = await addOk(recordId, { description: ATTACH_DESC });
            expect((await patchRecord(h, recordId, { treatmentPlan: PLAN, reason: AMEND_REASON })).status).toBe(201);
            const res = await getRecord(h, recordId, "patient");
            expect(res.body.data.amendments).toHaveLength(1);
            expect(attachmentsOf(res.body).map((item) => item.id)).toEqual([id]);
        });

        it("should issue the documented statements: record, amendments, attachments, audit (one attachments statement, with ANY)", async () => {
            const recordId = await newRecord();
            await seedDescribed(recordId, ["a", "b", "c"]);
            const captured = await captureQueries(() => getRecord(h, recordId, "patient"));
            expect(captured.result.status).toBe(200);
            expect(tail(captured.sql, 4)).toEqual(["record", "amendments", "attachments", "audit"]);
            expect([countOf(captured.sql, "amendments"), countOf(captured.sql, "attachments"), countOf(captured.sql, "audit")]).toEqual([1, 1, 1]);
            expect(captured.sql.find((sql) => kindOf(sql) === "attachments")).toContain("ANY(");
        });
    });

    // ───────────────────────────────────────────── GET /patients/{id}/records
    describe("GET /patients/{patientUserId}/records", () => {
        const seedTimeline = async (count: number): Promise<number[]> => {
            const ids: number[] = [];
            for (let index = 0; index < count; index += 1) ids.push(await createRecord(h, await seedCompleted(h)));
            return ids;
        };

        it("should give every record of the page its own attachments, oldest first, deleted rows hidden and other patients' rows absent", async () => {
            const [a, b, c] = await seedTimeline(3);
            const foreign = await createRecord(h, await seedCompleted(h, { patient_user_id: OTHER_PATIENT }));
            const aIds = await seedDescribed(a as number, ["a1", "a2"]);
            const cIds = await seedDescribed(c as number, ["c1", "c2", "c3"]);
            await ownerDb("record_attachments").where({ id: cIds[1] }).update({ deleted_at: new Date() });
            await seedDescribed(foreign, ["foreign"]);
            const res = await timeline(h, PATIENT, "patient");
            expect(res.status).toBe(200);
            expect(attachmentsOf(res.body, a as number).map((item) => item.id)).toEqual(aIds);
            expect(attachmentsOf(res.body, b as number)).toEqual([]);
            expect(attachmentsOf(res.body, c as number).map((item) => item.description)).toEqual(["c1", "c3"]);
            expect(JSON.stringify(res.body)).not.toContain("foreign");
        });

        it("should give page 2 of the default sort (cursor round trip) each record's own attachments", async () => {
            const ids = await seedTimeline(5);
            const expected = new Map<number, number[]>();
            for (const id of ids) expected.set(id, await seedDescribed(id, [`d-${id}-1`, `d-${id}-2`]));
            const first = await timeline(h, PATIENT, "patient", "?limit=2");
            expect(first.body.meta).toMatchObject({ hasMore: true, count: 2 });
            const second = await timeline(h, PATIENT, "patient", `?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`);
            expect(second.status).toBe(200);
            expect(second.body.meta).toMatchObject({ hasMore: true, count: 2 });
            const third = await timeline(h, PATIENT, "patient", `?limit=2&cursor=${encodeURIComponent(second.body.meta.nextCursor as string)}`);
            expect(third.body.meta).toMatchObject({ hasMore: false, count: 1 });
            const seen: number[] = [];
            for (const page of [first, second, third]) {
                for (const record of page.body.data.records as Array<{ id: number; attachments: Listed[] }>) {
                    seen.push(record.id);
                    expect(record.attachments.map((item) => item.id)).toEqual(expected.get(record.id));
                    expect(record.attachments.every((item) => item.recordId === record.id)).toBe(true);
                }
            }
            expect(seen).toEqual([...ids].reverse());
        });

        it("should issue one attachments statement for a page of records, none for an empty page, and keep the other statements at one each", async () => {
            const ids = await seedTimeline(4);
            await seedDescribed(ids[0] as number, ["x"]);
            const full = await captureQueries(() => timeline(h, PATIENT, "doctor", "?limit=3"));
            expect(full.result.status).toBe(200);
            expect(tail(full.sql, 5)).toEqual(["record", "amendments", "attachments", "profile", "audit"]);
            expect([countOf(full.sql, "amendments"), countOf(full.sql, "profile"), countOf(full.sql, "audit")]).toEqual([1, 1, 1]);
            expect(full.sql.filter((sql) => kindOf(sql) === "attachments")).toHaveLength(1);
            expect(full.sql.find((sql) => kindOf(sql) === "attachments")).toContain("ANY(");
            const empty = await captureQueries(() => timeline(h, OTHER_PATIENT, "otherPatient"));
            expect(empty.result.status).toBe(200);
            expect(empty.result.body.data.records).toEqual([]);
            expect(tail(empty.sql, 3)).toEqual(["record", "profile", "audit"]);
            expect(countOf(empty.sql, "amendments")).toBe(0);
            expect(empty.sql.filter((sql) => kindOf(sql) === "attachments")).toEqual([]);
        });

        it("should show the attachments of a record to a consulted doctor as it does to the patient", async () => {
            await provisionOtherDoctor(h);
            const [id] = await seedTimeline(1);
            const [attachment] = await seedDescribed(id as number, [ATTACH_DESC]);
            const res = await timeline(h, PATIENT, "otherDoctor");
            expect(res.status).toBe(200);
            expect(attachmentsOf(res.body, id as number).map((item) => item.id)).toEqual([attachment]);
        });
    });

    // ───────────────────────────────────────────── PATCH /records/{id}
    describe("PATCH /records/{id}", () => {
        it("should carry the attachments on the in-place 200 and on the no-op 200, with one attachments statement each", async () => {
            const recordId = await newRecord();
            const ids = await seedDescribed(recordId, ["p1", "p2"]);
            const inPlace = await captureQueries(() => patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` }));
            expect(inPlace.result.status).toBe(200);
            expect(attachmentsOf(inPlace.result.body).map((item) => item.id)).toEqual(ids);
            expect(tail(inPlace.sql, 4)).toEqual(["record", "record", "attachments", "audit"]);
            expect(countOf(inPlace.sql, "attachments")).toBe(1);
            const noop = await captureQueries(() => patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` }));
            expect(noop.result.status).toBe(200);
            expect(attachmentsOf(noop.result.body).map((item) => item.id)).toEqual(ids);
            expect(tail(noop.sql, 3)).toEqual(["record", "attachments", "audit"]);
            expect(countOf(noop.sql, "attachments")).toBe(1);
        });

        it("should answer [] on the in-place 200 of a record without attachments", async () => {
            const recordId = await newRecord();
            const res = await patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised` });
            expect(res.status).toBe(200);
            expect(attachmentsOf(res.body)).toEqual([]);
        });

        it("should read no attachments for an amendment and leave attachments out of the 201 body", async () => {
            const recordId = await newRecord();
            await seedDescribed(recordId, ["p1"]);
            await lockNow(recordId);
            const amended = await captureQueries(() => patchRecord(h, recordId, { treatmentPlan: `${PLAN} corrected`, reason: AMEND_REASON }));
            expect(amended.result.status).toBe(201);
            expect(amended.result.body.data.attachments).toBeUndefined();
            expect(kinds(amended.sql).filter((kind) => kind === "attachments")).toEqual([]);
        });

        it("should not let a PATCH touch the attachments themselves", async () => {
            const recordId = await newRecord();
            const ids = await seedDescribed(recordId, ["keep"]);
            expect((await patchRecord(h, recordId, { treatmentPlan: `${PLAN} revised`, attachments: [] })).status).toBe(400);
            const rows = await ownerDb("record_attachments").select("id", "deleted_at", "description");
            expect(rows).toEqual([{ id: ids[0], deleted_at: null, description: "keep" }]);
        });
    });

    // ───────────────────────────────────────────── POST /consultations/{id}/record
    describe("POST /consultations/{id}/record", () => {
        it("should answer attachments [] on the create 201 and read no attachments in the create transaction", async () => {
            const consultationId = await seedCompleted(h);
            const created = await captureQueries(() => postRecord(h, consultationId, recordBody(), "doctor"));
            expect(created.result.status).toBe(201);
            expect(created.result.body.data.attachments).toEqual([]);
            expect(kinds(created.sql).filter((kind) => kind === "attachments")).toEqual([]);
        });
    });
});
