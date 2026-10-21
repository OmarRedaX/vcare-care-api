import request from "supertest";
import type { Test } from "supertest";
import { RecordAttachmentsController } from "../../src/app/record-attachments/controller/record-attachments.controller";
import { RecordAttachmentsService } from "../../src/app/record-attachments/service/record-attachments.service";
import { UploadIntentsService } from "../../src/app/upload-intents/service/upload-intents.service";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import type { Actor, ConsultationsHarness } from "./consultations-harness";
import { useConsultationsHarness } from "./consultations-harness";
import { ownerDb } from "./db";
import { InMemoryObjectStorage } from "./fake-storage";
import type { Row } from "./records-fixtures";
import { audits, createRecord, seedCompleted } from "./records-fixtures";

/**
 * Synthetic markers for attachment free text. Each must never reach a log line, an audit row, a Redis key or value, an error body,
 * or any response other than the record views that are meant to show the description.
 */
export const ATTACH_DESC = "SYNTHETIC-ATTACH-DESC-0001";
export const ATTACH_DESC_2 = "SYNTHETIC-ATTACH-DESC-0002";
export const ATTACH_MARKERS = [ATTACH_DESC, ATTACH_DESC_2];

/** Stored bytes the shared detector accepts (the leading bytes are all it reads). */
export const PDF = Buffer.from("%PDF-1.7 synthetic attachment file");
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic png body")]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic jpeg body")]);
/** Looks like a PDF by name and declared type only. */
export const FALSE_PDF = Buffer.from("fake PDF bytes behind a pdf name");

export const AUDIT_ACTIONS = ["attachment.added", "attachment.removed", "attachment.url_issued"] as const;

/** Who sends a request: a harness actor, a raw bearer token, or nobody (`"anonymous"`: no Authorization header). */
export type Caller = Actor | "anonymous" | { token: string };

export interface UploadOptions {
    bytes?: Buffer;
    description?: string;
    caller?: Caller;
}

export interface Uploaded {
    uploadId: number;
    quarantineKey: string;
    intent: request.Response;
}

export interface AttachmentsKit {
    h: ConsultationsHarness;
    storage: InMemoryObjectStorage;
    /** Any verb (the harness's `call` has no `delete`). */
    send: (verb: "get" | "post" | "patch" | "delete", path: string, caller?: Caller, payload?: object, headers?: Record<string, string>) => Test;
    /** A completed consultation of the default pair with a record written by the default doctor. */
    newRecord: () => Promise<number>;
    createIntent: (recordId: number | string, body?: object, caller?: Caller, headers?: Record<string, string>) => Test;
    complete: (recordId: number | string, uploadId: number | string, caller?: Caller, payload?: object) => Test;
    downloadUrl: (recordId: number | string, attachmentId: number | string, caller?: Caller, payload?: object) => Test;
    remove: (recordId: number | string, attachmentId: number | string, caller?: Caller, payload?: object) => Test;
    /** Intent through the route, then the quarantine object seeded (the browser's presigned POST). Nothing is completed. */
    upload: (recordId: number, options?: UploadOptions) => Promise<Uploaded>;
    /** Intent + seeded object + `complete`; returns the `complete` response. */
    add: (recordId: number, options?: UploadOptions) => Promise<request.Response>;
    /** `add` that insists on `201` and returns the attachment id. */
    addOk: (recordId: number, options?: UploadOptions) => Promise<number>;
    /** Owner-role insert of `count` live attachment rows (a cap filler: no route budget spent). Returns their ids. */
    seedAttachments: (recordId: number, count: number, changes?: Record<string, unknown>) => Promise<number[]>;
}

/**
 * The consultations harness (real routes, services, Postgres, Redis; Identity and video faked) plus an in-memory object storage bound as
 * `STORAGE`. Call inside `describe`. The attachment services hold the storage port from their constructors, so they are re-registered on the
 * test double BEFORE the harness builds the app.
 */
export function useAttachmentsHarness(suite: string): AttachmentsKit {
    const storage = new InMemoryObjectStorage();
    const previous: Array<{ token: symbol; value: unknown }> = [];

    beforeAll(() => {
        for (const token of [TOKENS.STORAGE, TOKENS.UploadIntentsService, TOKENS.RecordAttachmentsService, TOKENS.RecordAttachmentsController]) {
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        }
        container.registerInstance(TOKENS.STORAGE, storage);
        container.registerSingleton(TOKENS.UploadIntentsService, UploadIntentsService);
        container.registerSingleton(TOKENS.RecordAttachmentsService, RecordAttachmentsService);
        container.registerSingleton(TOKENS.RecordAttachmentsController, RecordAttachmentsController);
    });
    const h = useConsultationsHarness(suite);
    beforeEach(() => { storage.clear(); });
    afterAll(() => {
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
    });

    const bearer = (caller: Caller): string | undefined => caller === "anonymous" ? undefined : typeof caller === "string" ? h.tokens[caller] : caller.token;
    const send: AttachmentsKit["send"] = (verb, path, caller = "doctor", payload, headers = {}) => {
        let test = request(h.app())[verb](path).set(headers);
        const token = bearer(caller);
        if (token !== undefined) test = test.set("Authorization", `Bearer ${token}`);
        if (payload !== undefined) test = test.send(payload);
        return test;
    };
    const base = (recordId: number | string): string => `/api/records/${recordId}/attachments`;

    const kit: AttachmentsKit = {
        h, storage, send,
        newRecord: async () => createRecord(h, await seedCompleted(h)),
        createIntent: (recordId, body, caller = "doctor", headers) => send("post", `${base(recordId)}/uploads`, caller, body, headers),
        complete: (recordId, uploadId, caller = "doctor", payload) => send("post", `${base(recordId)}/uploads/${uploadId}/complete`, caller, payload),
        downloadUrl: (recordId, attachmentId, caller = "patient", payload) => send("post", `${base(recordId)}/${attachmentId}/download-url`, caller, payload),
        remove: (recordId, attachmentId, caller = "doctor", payload) => send("delete", `${base(recordId)}/${attachmentId}`, caller, payload),
        upload: async (recordId, options = {}) => {
            const body = options.description === undefined ? undefined : { description: options.description };
            const intent = await kit.createIntent(recordId, body, options.caller ?? "doctor");
            if (intent.status !== 201) throw new Error(`intent fixture failed: ${intent.status} ${JSON.stringify(intent.body)}`);
            const uploadId = intent.body.data.uploadId as number;
            const quarantineKey = (intent.body.data.fields as Record<string, string>).key as string;
            storage.seed(quarantineKey, options.bytes ?? PDF);
            return { uploadId, quarantineKey, intent };
        },
        add: async (recordId, options = {}) => {
            const uploaded = await kit.upload(recordId, options);
            return kit.complete(recordId, uploaded.uploadId, options.caller ?? "doctor");
        },
        addOk: async (recordId, options = {}) => {
            const res = await kit.add(recordId, options);
            if (res.status !== 201) throw new Error(`attachment fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
            return res.body.data.id as number;
        },
        seedAttachments: async (recordId, count, changes = {}) => {
            const ids: number[] = [];
            for (let index = 0; index < count; index += 1) {
                const rows = await ownerDb("record_attachments").insert({
                    medical_record_id: recordId, uploaded_by_user_id: 202, object_key: `record-attachments/seed-${recordId}-${ids.length}-${Math.random().toString(36).slice(2)}`,
                    file_type: "application/pdf", size_bytes: 100, ...changes,
                }).returning("id");
                ids.push((rows[0] as { id: number }).id);
            }
            return ids;
        },
    };
    return kit;
}

export const attachmentRows = (): Promise<Row[]> => ownerDb("record_attachments").select("*").orderBy("id");
export const intentRows = (): Promise<Row[]> => ownerDb("upload_intents").select("*").orderBy("id");
export const attachmentAudits = (): Promise<Row[]> => audits(...AUDIT_ACTIONS);
export const liveCount = async (recordId: number): Promise<number> =>
    Number((await ownerDb("record_attachments").where({ medical_record_id: recordId }).whereNull("deleted_at").count({ n: "*" }))[0]?.n ?? 0);
/** The `medical_records` row exactly as stored, to prove an operation never touched it. */
export const recordSnapshot = async (recordId: number): Promise<string> => JSON.stringify(await ownerDb("medical_records").where({ id: recordId }).first());
/** Storage calls of one kind, in order. */
export const storageCalls = (storage: InMemoryObjectStorage, operation: string): unknown[][] =>
    storage.calls.filter((call) => call.operation === operation).map((call) => call.args as unknown[]);
