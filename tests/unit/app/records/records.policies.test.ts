import "reflect-metadata";
import type { RequestHandler, Router } from "express";
import { buildRecordsPolicies } from "../../../../src/app/records/policies";
import { buildRecordsRouter } from "../../../../src/app/records/routes";
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

/** Consultation 7: doctor 202, patient 101. Record 9: doctor 202, patient 101. Doctor 204 has a relationship with patient 101 only. Doctor 205 has none. */
const parties = jest.fn((id: number) => Promise.resolve(id === 7 ? { id: 7, doctorUserId: 202, patientUserId: 101, status: "completed" } : undefined));
const accessRow = jest.fn((id: number) => Promise.resolve(id === 9 ? { id: 9, patientUserId: 101, doctorUserId: 202 } : undefined));
const suspended = new Set<number>();
const related = new Set<string>(["204:101"]);
const relationship = { hasConsultationRelationship: jest.fn((doctorUserId: number, patientUserId: number) => Promise.resolve(related.has(`${doctorUserId}:${patientUserId}`))) };
const doctors = { isLocallySuspended: jest.fn((userId: number) => Promise.resolve(suspended.has(userId))) };
const policies = buildRecordsPolicies(doctors, { findParties: parties } as never, { findAccessRow: accessRow }, relationship);

const ROUTES = [
    ["create", "/api/consultations/{id}/record", "post"], ["get", "/api/records/{id}", "get"], ["update", "/api/records/{id}", "patch"],
    ["timeline", "/api/patients/{patientUserId}/records", "get"],
] as const;

beforeEach(() => { suspended.clear(); jest.clearAllMocks(); });

describe("records policies: roles and audit classes", () => {
    it.each(ROUTES)("should declare the %s roles from the contract", (name, path, method) => {
        expect([...policies[name].roles]).toEqual(inlineLists(contractOperationBlock(path, method), "x-roles")[0]);
    });

    it("should never list the admin role and never let a patient write", () => {
        for (const name of ["create", "get", "update", "timeline"] as const) expect(policies[name].roles).not.toContain("admin");
        expect(policies.create.roles).toEqual(["doctor"]);
        expect(policies.update.roles).toEqual(["doctor"]);
        expect(policies.get.roles).toEqual(["patient", "doctor"]);
        expect(policies.timeline.roles).toEqual(["patient", "doctor"]);
    });

    it("should declare the clinical audit class of each route from the contract", () => {
        expect(policies.create.audit).toBe("clinical-write");
        expect(policies.update.audit).toBe("clinical-write");
        expect(policies.get.audit).toBe("clinical-read");
        expect(policies.timeline.audit).toBe("clinical-read");
        for (const [name, path, method] of ROUTES) expect(contractOperationBlock(path, method)).toContain(`x-audit: ${policies[name].audit}`);
    });

    it("should apply the live local-suspension check on the writes only, as the doctors module defines it", async () => {
        for (const name of ["create", "update"] as const) expect(policies[name].checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
        expect(policies.get.checks).toBeUndefined();
        expect(policies.timeline.checks).toBeUndefined();
        const check = policies.create.checks?.[0];
        expect(check?.appliesTo).toEqual(["doctor"]);
        suspended.add(202);
        expect(await check?.run(ctx("doctor", 202, { id: "7" }))).toBe("deny-forbidden");
        suspended.clear();
        expect(await check?.run(ctx("doctor", 202, { id: "7" }))).toBe("allow");
    });

    it("should leave the account state default (active only) with no email requirement", () => {
        for (const name of ["create", "get", "update", "timeline"] as const) expect(policies[name].accountState).toBeUndefined();
    });

    it("should name the resolvers the contract documents", () => {
        expect(policies.create.owner).toMatchObject({ kind: "resolver", name: "record_write_consultation" });
        expect(policies.update.owner).toMatchObject({ kind: "resolver", name: "record_write_record" });
        expect(policies.get.owner).toMatchObject({ kind: "resolver", name: "record_reader" });
        expect(policies.timeline.owner).toMatchObject({ kind: "resolver", name: "records_timeline_reader" });
    });
});

describe("record_write_consultation and record_write_record", () => {
    const cases = [["create", "record_write_consultation", "7"], ["update", "record_write_record", "9"]] as const;

    it.each(cases)("should hide a non-numeric, zero, negative or missing id on %s with 404 and query nothing", async (name, _label, _id) => {
        for (const params of [{ id: "abc" }, { id: "0" }, { id: "-1" }, { id: "1.5" }, { id: "7abc" }, {}] as Array<Record<string, string>>) {
            expect(await resolve(policies[name].owner, ctx("doctor", 202, params))).toBe("deny-not-found");
        }
        expect(parties).not.toHaveBeenCalled();
        expect(accessRow).not.toHaveBeenCalled();
    });

    it.each(cases)("should answer 404 on %s when the row is absent, without a relationship lookup", async (name) => {
        expect(await resolve(policies[name].owner, ctx("doctor", 202, { id: "999" }))).toBe("deny-not-found");
        expect(relationship.hasConsultationRelationship).not.toHaveBeenCalled();
    });

    it.each(cases)("should allow the assigned doctor on %s with no relationship lookup", async (name, _label, id) => {
        expect(await resolve(policies[name].owner, ctx("doctor", 202, { id }))).toBe("allow");
        expect(relationship.hasConsultationRelationship).not.toHaveBeenCalled();
    });

    it.each(cases)("should allow a related non-assigned doctor on %s (the service then answers NotAssignedDoctor)", async (name, _label, id) => {
        expect(await resolve(policies[name].owner, ctx("doctor", 204, { id }))).toBe("allow");
        expect(relationship.hasConsultationRelationship).toHaveBeenCalledWith(204, 101);
    });

    it.each(cases)("should answer 404 on %s for a doctor with no relationship to the patient", async (name, _label, id) => {
        expect(await resolve(policies[name].owner, ctx("doctor", 205, { id }))).toBe("deny-not-found");
    });

    it("should take the id only from the path, never from anything else in the context", async () => {
        expect(await resolve(policies.create.owner, { auth: ctx("doctor", 205, {}).auth, params: { id: "7" }, body: { consultationId: 7, doctorUserId: 205 } } as AccessContext)).toBe("deny-not-found");
    });
});

describe("record_reader", () => {
    it.each([{ id: "abc" }, { id: "0" }, { id: "-5" }, {}])("should hide the non-numeric id %j from every role with 404", async (params) => {
        for (const [role, userId] of [["patient", 101], ["doctor", 202]] as const) expect(await resolve(policies.get.owner, ctx(role, userId, params as Record<string, string>))).toBe("deny-not-found");
        expect(accessRow).not.toHaveBeenCalled();
    });

    it("should answer 404 for an absent record", async () => {
        expect(await resolve(policies.get.owner, ctx("patient", 101, { id: "999" }))).toBe("deny-not-found");
        expect(await resolve(policies.get.owner, ctx("doctor", 202, { id: "999" }))).toBe("deny-not-found");
    });

    it("should allow the record's patient and hide the record from every other patient", async () => {
        expect(await resolve(policies.get.owner, ctx("patient", 101, { id: "9" }))).toBe("allow");
        expect(await resolve(policies.get.owner, ctx("patient", 102, { id: "9" }))).toBe("deny-not-found");
        expect(relationship.hasConsultationRelationship).not.toHaveBeenCalled();
    });

    it("should allow the author, then a related doctor, and hide the record from an unrelated doctor", async () => {
        expect(await resolve(policies.get.owner, ctx("doctor", 202, { id: "9" }))).toBe("allow");
        expect(await resolve(policies.get.owner, ctx("doctor", 204, { id: "9" }))).toBe("allow");
        expect(await resolve(policies.get.owner, ctx("doctor", 205, { id: "9" }))).toBe("deny-not-found");
    });

    it("should answer 404, not 403, for a locally suspended doctor, the author included (R-D5)", async () => {
        suspended.add(202); suspended.add(204);
        expect(await resolve(policies.get.owner, ctx("doctor", 202, { id: "9" }))).toBe("deny-not-found");
        expect(await resolve(policies.get.owner, ctx("doctor", 204, { id: "9" }))).toBe("deny-not-found");
    });

    it("should still let the patient read a record whose author is suspended", async () => {
        suspended.add(202);
        expect(await resolve(policies.get.owner, ctx("patient", 101, { id: "9" }))).toBe("allow");
        expect(await resolve(policies.get.owner, ctx("doctor", 204, { id: "9" }))).toBe("allow");
    });

    it("should deny any other role with forbidden once the record exists", async () => {
        expect(await resolve(policies.get.owner, ctx("admin", 303, { id: "9" }))).toBe("deny-forbidden");
    });
});

describe("records_timeline_reader", () => {
    it.each([{ patientUserId: "me" }, { patientUserId: "abc" }, { patientUserId: "0" }, { patientUserId: "-1" }, { patientUserId: "1e2" }, {}])(
        "should hide the id %j from patients and doctors with 404", async (params) => {
            for (const [role, userId] of [["patient", 101], ["doctor", 202]] as const) expect(await resolve(policies.timeline.owner, ctx(role, userId, params as Record<string, string>))).toBe("deny-not-found");
            expect(relationship.hasConsultationRelationship).not.toHaveBeenCalled();
        });

    it("should allow a patient their own timeline and hide every other patient's", async () => {
        expect(await resolve(policies.timeline.owner, ctx("patient", 101, { patientUserId: "101" }))).toBe("allow");
        expect(await resolve(policies.timeline.owner, ctx("patient", 102, { patientUserId: "101" }))).toBe("deny-not-found");
    });

    it("should allow a doctor with a relationship and hide the timeline from a doctor without one, even for a patient who does not exist", async () => {
        expect(await resolve(policies.timeline.owner, ctx("doctor", 204, { patientUserId: "101" }))).toBe("allow");
        expect(await resolve(policies.timeline.owner, ctx("doctor", 205, { patientUserId: "101" }))).toBe("deny-not-found");
        expect(await resolve(policies.timeline.owner, ctx("doctor", 204, { patientUserId: "888" }))).toBe("deny-not-found");
    });

    it("should answer 404, not 403, for a locally suspended doctor with a relationship", async () => {
        suspended.add(204);
        expect(await resolve(policies.timeline.owner, ctx("doctor", 204, { patientUserId: "101" }))).toBe("deny-not-found");
        expect(relationship.hasConsultationRelationship).not.toHaveBeenCalled();
    });

    it("should deny an admin with forbidden", async () => {
        expect(await resolve(policies.timeline.owner, ctx("admin", 303, { patientUserId: "101" }))).toBe("deny-forbidden");
    });
});

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }
const layers = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const chain = (router: Router, method: string, path: string): RequestHandler[] => {
    const layer = layers(router).find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${path} missing`);
    return layer.route.stack.map((entry) => entry.handle);
};
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

describe("buildRecordsRouter", () => {
    const router = buildRecordsRouter();

    it("should compose guard, authorize, one limiter and the handler on every route, with no idempotency middleware", () => {
        expect(chain(router, "post", "/consultations/:id/record").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "get", "/records/:id").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "patch", "/records/:id").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "get", "/patients/:patientUserId/records").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
    });

    it("should register exactly the four operations", () => {
        const registered = layers(router).filter((layer) => layer.route !== undefined).flatMap((layer) => layer.route!.stack.map((entry) => `${entry.method ?? ""} ${layer.route!.path}`));
        expect([...new Set(registered)]).toEqual(["post /consultations/:id/record", "get /records/:id", "patch /records/:id", "get /patients/:patientUserId/records"]);
    });

    it("should pass assertRoutesAuthorized", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });
});
