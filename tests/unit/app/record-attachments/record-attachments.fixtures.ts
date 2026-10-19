import type { Knex } from "knex";
import { RecordAttachment } from "../../../../src/app/record-attachments/entity/record-attachment.entity";
import type { AuthContext } from "../../../../src/lib/types/types";

/** Synthetic marker: it must never reach audit metadata, logs, error bodies or any response DTO. */
export const ATTACH_DESC = "SYNTHETIC-ATTACH-DESC-0001";
export const OBJECT_KEY = "record-attachments/00000000-0000-4000-8000-00000000aaaa";

export const NOW = Date.parse("2030-01-01T10:00:00Z");
export const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
export const author: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
export const otherDoctor: AuthContext = { userId: 204, role: "doctor", status: "active", emailVerified: true };
export const admin: AuthContext = { userId: 303, role: "admin", status: "active", emailVerified: true };

export function attachmentEntity(changes: Partial<RecordAttachment> = {}): RecordAttachment {
    return new RecordAttachment({
        id: 41, recordId: 9, uploadedByUserId: 202, objectKey: OBJECT_KEY, fileType: "application/pdf", sizeBytes: 2048,
        attachmentDescription: ATTACH_DESC, createdAt: new Date(NOW), deletedAt: null, ...changes,
    });
}

/** A pg-like error carrying a SQLSTATE and a constraint name. */
export function pgError(code: string, constraint?: string): Error {
    return Object.assign(new Error("synthetic pg error"), constraint === undefined ? { code } : { code, constraint });
}

type Call = [string, unknown[]];
/** A chainable query-builder stand-in: records every builder call and resolves, when awaited, to `result`. */
export function stubConn(result: unknown) {
    const calls: Call[] = [];
    const tables: string[] = [];
    const builder: unknown = new Proxy(() => undefined, {
        get(_target, prop) {
            if (prop === "then") return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
            return (...args: unknown[]) => { calls.push([String(prop), args]); return builder; };
        },
    });
    const conn = Object.assign((table: string) => { tables.push(table); return builder; }, { raw: (sql: string) => ({ raw: sql }), fn: { now: () => ({ now: true }) } });
    return { conn: conn as unknown as Knex.Transaction, calls, tables, called: (name: string) => calls.filter(([method]) => method === name) };
}

export function summaryRow(changes: Record<string, unknown> = {}) {
    return { id: 1, medical_record_id: 9, file_type: "application/pdf", size_bytes: 100, description: ATTACH_DESC, created_at: new Date(NOW), ...changes };
}
