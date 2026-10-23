import { logger } from "../../src/lib/logger/logger";
import { contractNoStoreValue } from "../helpers/contract";
import { PATIENT, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { captureLogs } from "../helpers/log-capture";
import { DERIVED_AVAILABILITY_PREFIXES } from "../helpers/redis";
import {
    AMEND_REASON, CHIEF, createRecord, DX_CODE, DX_TEXT, getRecord, lockNow, MARKERS, NOTES, patchRecord, PLAN, postRecord, PROFILE_ALLERGEN, PROFILE_CONDITION, recordBody,
    scanRedis, seedCompleted, seedProfile, STRANGER_DOCTOR, timeline, withFailingAudit,
} from "../helpers/records-fixtures";

jest.setTimeout(120_000);

describe("records privacy: logs, audit metadata, Redis and error bodies (integration: real routes, Postgres, Redis; Identity and video faked)", () => {
    const h = useConsultationsHarness("records-privacy");

    it("should keep every clinical marker out of the captured logs, every audit row, every Redis key and value and every error body across writes, reads and rejected requests", async () => {
        // The suite runs at LOG_LEVEL=warn; lower the root logger so every request_completed line (info) is emitted and scanned too.
        const level = logger as unknown as { level: string };
        const previousLevel = level.level;
        level.level = "debug";
        const logs = captureLogs();
        const responses: Array<{ status: number; headers: Record<string, string>; text: string; label: string }> = [];
        const note = (label: string, res: { status: number; headers: Record<string, unknown>; body: unknown }): void => {
            responses.push({ label, status: res.status, headers: res.headers as Record<string, string>, text: JSON.stringify(res.body) });
        };
        try {
            await seedProfile(PATIENT);
            const consultationId = await seedCompleted(h);
            const stranger = await h.signFor(STRANGER_DOCTOR, "doctor");
            const marked = recordBody({ chiefComplaint: `${CHIEF} on the left side`, examinationNotes: `${NOTES}\nsecond line`, diagnosisText: DX_TEXT, treatmentPlan: PLAN });

            // Writes.
            const created = await postRecord(h, consultationId, marked, "doctor");
            note("create", created);
            const id = created.body.data.id as number;
            note("update", await patchRecord(h, id, { treatmentPlan: `${PLAN} revised` }));
            note("noop", await patchRecord(h, id, { treatmentPlan: `${PLAN} revised` }));
            await lockNow(id);
            note("amend", await patchRecord(h, id, { examinationNotes: `${NOTES} corrected`, reason: AMEND_REASON }));
            // Reads.
            note("get", await getRecord(h, id, "patient"));
            note("get-doctor", await getRecord(h, id, "doctor"));
            note("timeline", await timeline(h, PATIENT, "patient"));
            note("timeline-doctor", await timeline(h, PATIENT, "doctor", "?limit=1"));
            // Rejected requests that carry the markers in their bodies.
            note("duplicate", await postRecord(h, consultationId, marked, "doctor"));
            note("invalid-code", await postRecord(h, await seedCompleted(h), { ...marked, diagnosisCode: "bad code" }, "doctor"));
            note("invalid-key", await postRecord(h, await seedCompleted(h), { ...marked, patientUserId: 1 }, "doctor"));
            note("no-reason", await patchRecord(h, id, { treatmentPlan: `${PLAN} again` }));
            note("reason-only", await patchRecord(h, id, { reason: AMEND_REASON }));
            note("null-field", await patchRecord(h, id, { treatmentPlan: null, reason: AMEND_REASON }));
            note("patient-write", await postRecord(h, consultationId, marked, "patient"));
            note("patient-patch", await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON }, "patient"));
            note("admin-write", await postRecord(h, consultationId, marked, "admin"));
            note("admin-patch", await patchRecord(h, id, { treatmentPlan: PLAN, reason: AMEND_REASON }, "admin"));
            note("admin-get", await getRecord(h, id, "admin"));
            note("admin-timeline", await timeline(h, PATIENT, "admin"));
            note("stranger-write", await h.callWith(stranger, "post", `/api/consultations/${consultationId}/record`, marked));
            note("stranger-patch", await h.callWith(stranger, "patch", `/api/records/${id}`, { treatmentPlan: PLAN, reason: AMEND_REASON }));
            note("stranger-get", await h.callWith(stranger, "get", `/api/records/${id}`));
            note("other-patient-get", await getRecord(h, id, "otherPatient"));
            note("other-patient-timeline", await timeline(h, PATIENT, "otherPatient"));
            note("unauthenticated", await getRecord(h, id));
            note("bad-cursor", await timeline(h, PATIENT, "patient", "?cursor=not-a-cursor"));
            // A failing audit insert: the 500 body and the error log must stay clean as well.
            const failing = await seedCompleted(h);
            await withFailingAudit("record.created", async () => { note("audit-500-create", await postRecord(h, failing, marked, "doctor")); });
            await withFailingAudit("record.read", async () => { note("audit-500-read", await getRecord(h, id, "patient")); });
            await withFailingAudit("patient_records.listed", async () => { note("audit-500-timeline", await timeline(h, PATIENT, "patient")); });
        } finally {
            logs.restore();
            level.level = previousLevel;
        }

        // 1. Logs: no marker, no code, no profile text, no credential.
        const text = logs.text();
        const secrets = [...MARKERS, DX_CODE, PROFILE_ALLERGEN, PROFILE_CONDITION, "1990-01-02", "Pat Synthetic", "Dr Synthetic", ...Object.values(h.tokens), "Authorization", "Bearer "];
        for (const secret of secrets) expect([secret.slice(0, 24), text.includes(secret)]).toEqual([secret.slice(0, 24), false]);

        // Not vacuous: the record routes logged, with only the whitelisted fields, and the audit failure was recorded without row content.
        const lines = logs.lines();
        const completed = lines.filter((line) => line.message === "request_completed" && typeof line.route === "string" && /\/api\/(records|patients\/:patientUserId\/records|consultations\/:id\/record)/.test(line.route));
        expect(completed.length).toBeGreaterThanOrEqual(30);
        for (const line of completed) {
            expect(Object.keys(line).every((key) => ["level", "message", "timestamp", "service", "requestId", "userId", "role", "route", "method", "status", "code", "durationMs"].includes(key))).toBe(true);
        }
        expect(new Set(completed.map((line) => line.route))).toEqual(new Set(["/api/consultations/:id/record", "/api/records/:id", "/api/patients/:patientUserId/records"]));
        const auditFailures = lines.filter((line) => line.message === "audit_write_failed");
        expect(auditFailures.map((line) => line.action).sort()).toEqual(["patient_records.listed", "record.created", "record.read"]);
        expect(auditFailures.every((line) => line.entityType === "medical_record" || line.entityType === "patient_records")).toBe(true);

        // 2. Audit metadata: ids, roles, counts and field names only.
        const audit = JSON.stringify(await ownerDb("audit_logs").select("action", "entity_type", "metadata").orderBy("id"));
        for (const secret of [...MARKERS, DX_CODE, PROFILE_ALLERGEN, PROFILE_CONDITION, "revised", "corrected"]) expect([secret, audit.includes(secret)]).toEqual([secret, false]);

        // 3. Redis: only rate-limit counters (and nothing that carries record text).
        const redisEntries = await scanRedis();
        expect(redisEntries.length).toBeGreaterThan(0);
        const redisText = JSON.stringify(redisEntries);
        for (const secret of [...MARKERS, DX_CODE, PROFILE_ALLERGEN, "revised", "corrected"]) expect([secret, redisText.includes(secret)]).toEqual([secret, false]);
        expect(redisEntries.filter((entry) => entry.key.startsWith("idem:"))).toEqual([]);

        // 4. Error bodies of every rejected request: no clinical text; and every response is uncacheable.
        const rejected = responses.filter((res) => res.status >= 400);
        expect(rejected.length).toBeGreaterThanOrEqual(20);
        for (const res of rejected) {
            for (const secret of [...MARKERS, DX_CODE, PROFILE_ALLERGEN, PROFILE_CONDITION]) expect([res.label, secret, res.text.includes(secret)]).toEqual([res.label, secret, false]);
        }
        for (const res of responses) expect([res.label, res.headers["cache-control"]]).toEqual([res.label, contractNoStoreValue()]);
        // The statuses the scenario meant to produce did occur (the scan above is not scanning nothing).
        const statusOf = (label: string): number => responses.find((res) => res.label === label)?.status ?? 0;
        expect(["create", "update", "noop", "amend", "get", "get-doctor", "timeline", "timeline-doctor"].map(statusOf)).toEqual([201, 200, 200, 201, 200, 200, 200, 200]);
        expect(["duplicate", "invalid-code", "invalid-key", "no-reason", "reason-only", "null-field", "patient-write", "patient-patch", "admin-write", "admin-patch", "admin-get",
            "admin-timeline", "stranger-write", "stranger-patch", "stranger-get", "other-patient-get", "other-patient-timeline", "unauthenticated", "bad-cursor",
            "audit-500-create", "audit-500-read", "audit-500-timeline"].map(statusOf)).toEqual([409, 400, 400, 400, 400, 400, 403, 403, 403, 403, 403, 403, 404, 404, 404, 404, 404, 401, 400, 500, 500, 500]);
        // The successful responses do carry the clinical text (the markers are real fixtures, not absent ones).
        const create = responses.find((res) => res.label === "create");
        for (const marker of [CHIEF, NOTES, DX_TEXT, PLAN]) expect(create?.text).toContain(marker);
    });

    it("should hold no record text in Redis after a burst of writes and reads, only counters", async () => {
        const id = await createRecord(h, await seedCompleted(h), recordBody());
        for (let index = 0; index < 5; index += 1) {
            await getRecord(h, id, "patient");
            await timeline(h, PATIENT, "patient");
        }
        await patchRecord(h, id, { treatmentPlan: `${PLAN} changed` });
        const entries = await scanRedis();
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            for (const secret of [...MARKERS, "changed"]) expect([entry.key, entry.value.includes(secret) || entry.key.includes(secret)]).toEqual([entry.key, false]);
            expect(["rl:", ...DERIVED_AVAILABILITY_PREFIXES].some((prefix) => entry.key.startsWith(prefix))).toBe(true);
        }
    });
});
