import type { Test } from "supertest";
import type { Actor, ConsultationsHarness } from "./consultations-harness";
import { DAY, DOCTOR, HOUR, MINUTE, OTHER_DOCTOR, PATIENT } from "./consultations-harness";
import { db } from "../../src/lib/knex/knex";
import { redis } from "../../src/lib/redis/redis";
import { ownerDb } from "./db";

/** Synthetic clinical markers: each must never reach a log line, an audit row, a Redis key or value, or an error body. */
export const CHIEF = "SYNTHETIC-CHIEF-6601";
export const NOTES = "SYNTHETIC-NOTES-6602";
export const DX_TEXT = "SYNTHETIC-DXTEXT-6603";
export const PLAN = "SYNTHETIC-PLAN-6604";
export const AMEND_REASON = "SYNTHETIC-AMEND-REASON-6605";
export const DX_CODE = "Z99.9";
/** Every marker a log, audit or Redis scan must be free of (the code and the number are format-bound, scanned separately). */
export const MARKERS = [CHIEF, NOTES, DX_TEXT, PLAN, AMEND_REASON];

/** A third doctor with no consultation at all: the "unrelated doctor" of the matrix. */
export const STRANGER_DOCTOR = 205;
export const PROFILE_ALLERGEN = "SYNTHETIC-ALLERGEN-5521";
export const PROFILE_CONDITION = "SYNTHETIC-CONDITION-5522";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Valid create body; every optional member set so the full record round-trips. */
export const recordBody = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    chiefComplaint: CHIEF, examinationNotes: NOTES, diagnosisText: DX_TEXT, diagnosisCode: DX_CODE, treatmentPlan: PLAN, followUpInDays: 14, ...changes,
});

let slot = 0;
/**
 * A COMPLETED consultation for the default doctor and patient, in the past, in its own one-hour slot (the exclusion constraint forbids
 * two live rows of one doctor overlapping). Real SQL through the owner pool; the lifecycle routes are driven in the end-to-end test.
 */
export function seedCompleted(h: ConsultationsHarness, changes: Record<string, unknown> = {}): Promise<number> {
    slot = (slot + 1) % 900;
    const start = Date.now() - 40 * DAY + slot * HOUR;
    return h.seedConsultation({ starts_at: new Date(start), ends_at: new Date(start + 30 * MINUTE), status: "completed", completed_at: new Date(start + 25 * MINUTE), ...changes });
}

/** A consultation in any state for the default pair; `cancelled` carries the stamps its CHECK requires. */
export function seedWithStatus(h: ConsultationsHarness, status: string, changes: Record<string, unknown> = {}): Promise<number> {
    const stamps = status === "cancelled" ? { cancelled_at: new Date(), cancelled_by: "patient" } : {};
    return seedCompleted(h, { status, completed_at: null, ...stamps, ...changes });
}

/** Gives `doctorUserId` a `booked` consultation with `patientUserId` (a live relationship) in a future slot of that doctor. */
export function relate(h: ConsultationsHarness, doctorUserId: number, patientUserId = PATIENT, status = "booked"): Promise<number> {
    slot = (slot + 1) % 900;
    const start = Date.now() + 5 * DAY + slot * HOUR;
    return h.seedConsultation({ doctor_user_id: doctorUserId, patient_user_id: patientUserId, status, starts_at: new Date(start), ends_at: new Date(start + 30 * MINUTE),
        ...(status === "cancelled" ? { cancelled_at: new Date(), cancelled_by: "patient" } : {}) });
}

/** The owner-role insert of a record row (a timeline seed): locked_at = created_at + 24 h, exactly as the CHECK requires. */
export async function insertRecordRow(consultationId: number, changes: Record<string, unknown> = {}): Promise<number> {
    const created = (changes.created_at as Date | undefined) ?? new Date(Date.now() - 3 * DAY);
    const rows = await ownerDb("medical_records").insert({
        consultation_id: consultationId, patient_user_id: PATIENT, doctor_user_id: DOCTOR, chief_complaint: CHIEF, created_at: created, updated_at: created,
        locked_at: ownerDb.raw("?::timestamptz + interval '24 hours'", [created.toISOString()]), ...changes,
    }).returning("id");
    return (rows[0] as { id: number }).id;
}

/** Creates a record through the real route and returns its id; the doctor token is the harness's. */
export async function createRecord(h: ConsultationsHarness, consultationId: number, body: Record<string, unknown> = recordBody(), actor: Actor = "doctor"): Promise<number> {
    const res = await h.call("post", `/api/consultations/${consultationId}/record`, actor, body);
    if (res.status !== 201) throw new Error(`record fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.id as number;
}

/**
 * Moves a record back in time by `ms` as ONE owner statement: `created_at`, `updated_at` and `locked_at` shift together, so
 * `chk_medical_records_lock` still holds and the row is as old as the test needs. Valid only while the record is not yet locked
 * (the BEFORE UPDATE trigger refuses any statement on a locked row, the owner's included).
 */
export async function ageRecord(id: number, ms: number): Promise<void> {
    await ownerDb.raw(
        `UPDATE medical_records SET created_at = created_at - (? * interval '1 millisecond'), updated_at = updated_at - (? * interval '1 millisecond'),
                locked_at = locked_at - (? * interval '1 millisecond') WHERE id = ?`, [ms, ms, ms, id]);
}

/** Ages a record so that it locks `msUntilLock` from now (positive: still open, zero or negative: locked). */
export async function lockIn(id: number, msUntilLock: number): Promise<void> {
    await ageRecord(id, 24 * HOUR - msUntilLock);
}

export const lockNow = (id: number): Promise<void> => lockIn(id, -1000);

export const recordRows = (): Promise<Row[]> => ownerDb("medical_records").select("*").orderBy("id");
export const amendmentRows = (): Promise<Row[]> => ownerDb("medical_record_amendments").select("*").orderBy("id");
export const audits = (...actions: string[]): Promise<Row[]> => ownerDb("audit_logs")
    .select("actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata").whereIn("action", actions).orderBy("id");
export const RECORD_AUDITS = ["record.created", "record.read", "record.updated", "record.amended", "patient_records.listed"];
export const allRecordAudits = (): Promise<Row[]> => audits(...RECORD_AUDITS);

export async function seedProfile(userId = PATIENT, changes: Record<string, unknown> = {}): Promise<void> {
    await ownerDb("patient_profiles").insert({ user_id: userId, date_of_birth: "1990-01-02", gender: "female", blood_type: "O+", allergies: [PROFILE_ALLERGEN],
        chronic_conditions: [PROFILE_CONDITION], timezone: "Africa/Cairo", ...changes });
}

/** Makes `doctorUserId` locally suspended (the token still says active), exactly as Case 3's first commit does. */
export const suspendLocally = (doctorUserId = DOCTOR): Promise<number> =>
    ownerDb("doctor_profiles").where({ user_id: doctorUserId }).update({ suspended_at: new Date(), suspension_reason: "SYNTHETIC-SUSPENSION" });

export const getRecord = (h: ConsultationsHarness, id: number | string, actor?: Actor): Test => h.call("get", `/api/records/${id}`, actor);
export const patchRecord = (h: ConsultationsHarness, id: number | string, body: object, actor: Actor = "doctor"): Test => h.call("patch", `/api/records/${id}`, actor, body);
export const postRecord = (h: ConsultationsHarness, consultationId: number | string, body: object = recordBody(), actor?: Actor): Test =>
    h.call("post", `/api/consultations/${consultationId}/record`, actor, body);
export const timeline = (h: ConsultationsHarness, patientUserId: number | string, actor?: Actor, query = ""): Test =>
    h.call("get", `/api/patients/${patientUserId}/records${query}`, actor);

/** Provisions the related (non-author) doctor with a profile and a live relationship to the default patient. */
export async function provisionOtherDoctor(h: ConsultationsHarness): Promise<void> {
    await h.seedDoctor(OTHER_DOCTOR);
    await relate(h, OTHER_DOCTOR);
}

/** Runs `run` while recording every SQL statement the application pool (and its transactions) issues. */
export async function captureQueries<T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const sql: string[] = [];
    const listener = (data: { sql: string }): void => { sql.push(data.sql); };
    db.on("query", listener);
    try {
        return { result: await run(), sql };
    } finally {
        db.removeListener("query", listener);
    }
}

/** Every Redis key (default: all of the dedicated test database) with its value (read-only SCAN, never KEYS), for "no clinical text in Redis" scans. */
export async function scanRedis(prefixes: string[] = [""]): Promise<Array<{ key: string; value: string }>> {
    const found: Array<{ key: string; value: string }> = [];
    for (const prefix of prefixes) {
        let cursor = "0";
        do {
            const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
            cursor = next;
            for (const key of keys) {
                const type = await redis.type(key);
                const value = type === "string" ? (await redis.get(key)) ?? "" : JSON.stringify(type === "zset" ? await redis.zrange(key, 0, -1, "WITHSCORES")
                    : type === "hash" ? await redis.hgetall(key) : type === "list" ? await redis.lrange(key, 0, -1) : await redis.smembers(key));
                found.push({ key, value });
            }
        } while (cursor !== "0");
    }
    return found;
}

/** Adds a throwaway CHECK to `audit_logs` so the matching audit insert fails (the transaction under test must then fail whole), always removed after. NOT VALID: rows already written stay, only new ones are refused. */
export async function withFailingAudit(action: string, run: () => Promise<void>): Promise<void> {
    const name = `chk_audit_${action.replace(/[^a-z]/g, "_")}_test`;
    await ownerDb.raw(`ALTER TABLE audit_logs ADD CONSTRAINT ${name} CHECK (action <> '${action}') NOT VALID`);
    try { await run(); } finally { await ownerDb.raw(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS ${name}`); }
}
