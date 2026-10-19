import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";
import type { RequestHandler, Router } from "express";
import { buildRecordAttachmentsPolicies } from "../../../../src/app/record-attachments/policies";
import { buildRecordAttachmentsRouter } from "../../../../src/app/record-attachments/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";
import type { AccessContext, OwnershipRule } from "../../../../src/lib/rbac/types";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

type Role = "patient" | "doctor" | "admin";
const ctx = (role: Role, userId: number, params: Record<string, string>): AccessContext => ({ auth: { userId, role, status: "active", emailVerified: true }, params });
const resolve = (owner: OwnershipRule, context: AccessContext) => {
    if (owner.kind !== "resolver") throw new Error("expected a resolver");
    return owner.resolve(context);
};

/** Record 9: patient 101, author 202. Doctor 204 has a relationship with patient 101 only. Doctor 205 has none. */
const accessRow = jest.fn((id: number) => Promise.resolve(id === 9 ? { id: 9, patientUserId: 101, doctorUserId: 202 } : undefined));
const suspended = new Set<number>();
const related = new Set<string>(["204:101"]);
const relationship = { hasConsultationRelationship: jest.fn((doctorUserId: number, patientUserId: number) => Promise.resolve(related.has(`${doctorUserId}:${patientUserId}`))) };
const doctors = { isLocallySuspended: jest.fn((userId: number) => Promise.resolve(suspended.has(userId))) };
const policies = buildRecordAttachmentsPolicies(doctors, { findAccessRow: accessRow }, relationship);

const ROUTES = [
    ["createIntent", "/api/records/{id}/attachments/uploads", "post"],
    ["complete", "/api/records/{id}/attachments/uploads/{uploadId}/complete", "post"],
    ["downloadUrl", "/api/records/{id}/attachments/{attachmentId}/download-url", "post"],
    ["remove", "/api/records/{id}/attachments/{attachmentId}", "delete"],
] as const;
const WRITES = ["createIntent", "complete", "remove"] as const;

beforeEach(() => { suspended.clear(); jest.clearAllMocks(); });

describe("record-attachments policies: roles, account state and audit classes", () => {
    it.each(ROUTES)("should declare the %s roles from the contract", (name, apiPath, method) => {
        expect([...policies[name].roles]).toEqual(inlineLists(contractOperationBlock(apiPath, method), "x-roles")[0]);
    });

    it("should list only the doctor on the three writes and patient plus doctor on download-url", () => {
        for (const name of WRITES) expect(policies[name].roles).toEqual(["doctor"]);
        expect(policies.downloadUrl.roles).toEqual(["patient", "doctor"]);
    });

    it("should never list the admin role on any of the four routes (403 at the role step)", () => {
        for (const [name] of ROUTES) expect(policies[name].roles).not.toContain("admin");
    });

    it("should never list the patient role on a write (a patient is denied at the role step)", () => {
        for (const name of WRITES) expect(policies[name].roles).not.toContain("patient");
    });

    it("should declare the audit class of each route from the contract and none on the intent route", () => {
        expect(policies.createIntent.audit).toBeUndefined();
        expect(policies.complete.audit).toBe("clinical-write");
        expect(policies.remove.audit).toBe("clinical-write");
        expect(policies.downloadUrl.audit).toBe("clinical-read");
        for (const [name, apiPath, method] of ROUTES) {
            const block = contractOperationBlock(apiPath, method);
            if (policies[name].audit === undefined) expect(block).not.toContain("x-audit: ");
            else expect(block).toContain(`x-audit: ${policies[name].audit}`);
        }
    });

    it("should leave the account state default (active only, no email requirement) on every route", () => {
        for (const [name] of ROUTES) expect(policies[name].accountState).toBeUndefined();
    });

    it("should declare the contract ownership name of each route", () => {
        for (const name of WRITES) expect(policies[name].owner).toMatchObject({ kind: "resolver", name: "record_attachment_writer" });
        for (const [name, apiPath, method] of ROUTES) {
            const wanted = name === "downloadUrl" ? "consulted-patient-or-self" : "record-author";
            expect(contractOperationBlock(apiPath, method)).toContain(`x-ownership: ${wanted}`);
        }
    });
});

describe("the live local-suspension check", () => {
    it("should be applied on the three writes, for doctors only, and not on download-url", () => {
        for (const name of WRITES) {
            expect(policies[name].checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
            expect(policies[name].checks?.[0]?.appliesTo).toEqual(["doctor"]);
        }
        expect(policies.downloadUrl.checks).toBeUndefined();
    });

    it.each(WRITES)("should deny %s with forbidden for a locally suspended author and allow it otherwise", async (name) => {
        const check = policies[name].checks?.[0];
        suspended.add(202);
        expect(await check?.run(ctx("doctor", 202, { id: "9" }))).toBe("deny-forbidden");
        suspended.clear();
        expect(await check?.run(ctx("doctor", 202, { id: "9" }))).toBe("allow");
        expect(doctors.isLocallySuspended).toHaveBeenCalledWith(202);
    });
});

describe("record_attachment_writer decision table", () => {
    const writer = policies.createIntent.owner;

    it("should be the same rule for intent, complete and delete", async () => {
        for (const name of WRITES) {
            expect(await resolve(policies[name].owner, ctx("doctor", 202, { id: "9" }))).toBe("allow");
            expect(await resolve(policies[name].owner, ctx("doctor", 204, { id: "9" }))).toBe("deny-not-found");
        }
    });

    it("should allow the record's author", async () => {
        expect(await resolve(writer, ctx("doctor", 202, { id: "9" }))).toBe("allow");
        expect(accessRow).toHaveBeenCalledWith(9);
    });

    it("should answer deny-not-found, never forbidden, to a doctor who has a consultation relationship but is not the author (RA-D2)", async () => {
        expect(await resolve(writer, ctx("doctor", 204, { id: "9" }))).toBe("deny-not-found");
        expect(relationship.hasConsultationRelationship).not.toHaveBeenCalled();
    });

    it("should answer deny-not-found to a doctor with no relationship to the patient", async () => {
        expect(await resolve(writer, ctx("doctor", 205, { id: "9" }))).toBe("deny-not-found");
    });

    it("should answer deny-not-found for an absent record", async () => {
        expect(await resolve(writer, ctx("doctor", 202, { id: "999" }))).toBe("deny-not-found");
    });

    it.each(["abc", "0", "-1", "1.5", "9abc", "1e2", " 9", ""])("should answer deny-not-found for the non-numeric or non-positive id %j without any lookup", async (id) => {
        expect(await resolve(writer, ctx("doctor", 202, { id }))).toBe("deny-not-found");
        expect(accessRow).not.toHaveBeenCalled();
    });

    it("should answer deny-not-found when the path carries no id", async () => {
        expect(await resolve(writer, ctx("doctor", 202, {}))).toBe("deny-not-found");
        expect(accessRow).not.toHaveBeenCalled();
    });

    it("should give the same decision for an absent record, a foreign record, a related doctor and a stranger (no existence oracle)", async () => {
        const decisions = await Promise.all([resolve(writer, ctx("doctor", 204, { id: "999" })), resolve(writer, ctx("doctor", 204, { id: "9" })),
            resolve(writer, ctx("doctor", 205, { id: "9" })), resolve(writer, ctx("doctor", 202, { id: "abc" }))]);
        expect(decisions).toEqual(["deny-not-found", "deny-not-found", "deny-not-found", "deny-not-found"]);
    });

    it("should take the id only from the path, never from a body in the context", async () => {
        const hostile = { auth: ctx("doctor", 205, {}).auth, params: { id: "9" }, body: { id: 999, doctorUserId: 205, recordId: 9 } } as AccessContext;
        expect(await resolve(writer, hostile)).toBe("deny-not-found");
    });

    it("should not consult suspension itself (the check step owns it, answering 403)", async () => {
        suspended.add(202);
        expect(await resolve(writer, ctx("doctor", 202, { id: "9" }))).toBe("allow");
        expect(doctors.isLocallySuspended).not.toHaveBeenCalled();
    });
});

describe("download-url ownership (the records record_reader rule)", () => {
    const reader = policies.downloadUrl.owner;

    it("should use the record_reader resolver", () => {
        expect(reader).toMatchObject({ kind: "resolver", name: "record_reader" });
    });

    it("should allow the record's patient and hide the record from another patient", async () => {
        expect(await resolve(reader, ctx("patient", 101, { id: "9" }))).toBe("allow");
        expect(await resolve(reader, ctx("patient", 102, { id: "9" }))).toBe("deny-not-found");
    });

    it("should allow the author and a related doctor, and hide the record from a stranger doctor", async () => {
        expect(await resolve(reader, ctx("doctor", 202, { id: "9" }))).toBe("allow");
        expect(await resolve(reader, ctx("doctor", 204, { id: "9" }))).toBe("allow");
        expect(await resolve(reader, ctx("doctor", 205, { id: "9" }))).toBe("deny-not-found");
    });

    it("should answer 404, not 403, for a locally suspended doctor, the author included (RA-R21)", async () => {
        suspended.add(202); suspended.add(204);
        expect(await resolve(reader, ctx("doctor", 202, { id: "9" }))).toBe("deny-not-found");
        expect(await resolve(reader, ctx("doctor", 204, { id: "9" }))).toBe("deny-not-found");
    });

    it("should still let the patient and an unsuspended related doctor open a suspended author's attachment", async () => {
        suspended.add(202);
        expect(await resolve(reader, ctx("patient", 101, { id: "9" }))).toBe("allow");
        expect(await resolve(reader, ctx("doctor", 204, { id: "9" }))).toBe("allow");
    });

    it.each(["abc", "0", "-3"])("should hide the id %j from every role with 404 and no lookup", async (id) => {
        for (const [role, userId] of [["patient", 101], ["doctor", 202]] as const) expect(await resolve(reader, ctx(role, userId, { id }))).toBe("deny-not-found");
        expect(accessRow).not.toHaveBeenCalled();
    });

    it("should refuse an admin that reaches the resolver", async () => {
        expect(await resolve(reader, ctx("admin", 303, { id: "9" }))).toBe("deny-forbidden");
    });
});

describe("NotAssignedDoctor on the attachment routes (RA-R2)", () => {
    it("should appear in no source file of the record-attachments module", () => {
        const root = path.resolve(__dirname, "..", "..", "..", "..", "src", "app", "record-attachments");
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".ts")) files.push(full);
            }
        };
        walk(root);
        expect(files.length).toBeGreaterThan(8);
        for (const file of files) expect([file, fs.readFileSync(file, "utf8").includes("NotAssignedDoctor")]).toEqual([file, false]);
    });

    it("should be referenced by no response of the four contract operations and only ever named as never returned", () => {
        for (const [, apiPath, method] of ROUTES) {
            const block = contractOperationBlock(apiPath, method);
            expect(block).not.toContain("RecordWriteForbidden");
            const mentions = block.replace(/\s+/g, " ").split("NotAssignedDoctor").slice(0, -1);
            for (const before of mentions) expect(before.endsWith("this route never answers `403 ")).toBe(true);
        }
    });
});

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }
const layers = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const chain = (router: Router, method: string, routePath: string): RequestHandler[] => {
    const layer = layers(router).find((item) => item.route?.path === routePath && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${routePath} missing`);
    return layer.route.stack.map((entry) => entry.handle);
};
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

describe("buildRecordAttachmentsRouter", () => {
    const router = buildRecordAttachmentsRouter();

    it("should compose guard, authorize, one limiter and the handler on every route, with no idempotency middleware", () => {
        expect(chain(router, "post", "/records/:id/attachments/uploads").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "post", "/records/:id/attachments/uploads/:uploadId/complete").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "post", "/records/:id/attachments/:attachmentId/download-url").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "delete", "/records/:id/attachments/:attachmentId").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
    });

    it("should register exactly the four operations", () => {
        const registered = layers(router).filter((layer) => layer.route !== undefined).flatMap((layer) => layer.route!.stack.map((entry) => `${entry.method ?? ""} ${layer.route!.path}`));
        expect([...new Set(registered)]).toEqual(["post /records/:id/attachments/uploads", "post /records/:id/attachments/uploads/:uploadId/complete",
            "post /records/:id/attachments/:attachmentId/download-url", "delete /records/:id/attachments/:attachmentId"]);
    });

    it("should pass assertRoutesAuthorized", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });
});
