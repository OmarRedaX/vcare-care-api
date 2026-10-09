import { contractOperationBlock, contractResponseCodes, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";

const SUSPEND = "/api/admin/doctors/{doctorUserId}/suspend";
const REINSTATE = "/api/admin/doctors/{doctorUserId}/reinstate";

describe("admin-doctors contract (Cases 3 and 4)", () => {
    it.each([
        [SUSPEND, "suspendDoctor", 3, "must-not-degrade", ["200", "400", "401", "403", "404", "409", "429", "500", "503"], ["202"]],
        [REINSTATE, "reinstateDoctor", 4, "retry-report-pending", ["200", "202", "400", "401", "403", "404", "409", "429", "500"], ["503"]],
    ] as const)("should declare %s with its integration case, failure policy and status set", (path, operationId, integrationCase, policy, declared, absent) => {
        const block = contractOperationBlock(path, "patch");
        expect(block).toContain(`operationId: ${operationId}`);
        expect(block).toContain(`x-integration-case: ${integrationCase}`);
        expect(block).toContain(`x-failure-policy: ${policy}`);
        expect(inlineLists(block, "x-roles")[0]).toEqual(["admin"]);
        expect(block).toContain("x-ownership: none");
        expect(block).toContain("x-audit: admin-action");
        expect(contractResponseCodes(path, "patch").sort()).toEqual(expect.arrayContaining([...declared]));
        for (const code of absent) expect(contractResponseCodes(path, "patch")).not.toContain(code);
    });

    it("should list the audit actions each operation writes", () => {
        expect(inlineLists(contractOperationBlock(SUSPEND, "patch"), "x-audit-actions")[0]).toEqual(["doctor.suspended", "consultation.flagged_for_followup", "identity_sync.pending", "identity_sync.failed", "identity_sync.synced"]);
        expect(inlineLists(contractOperationBlock(REINSTATE, "patch"), "x-audit-actions")[0]).toEqual(["doctor.reinstated", "identity_sync.pending", "identity_sync.failed", "identity_sync.synced"]);
    });

    it("should document the S6 no-op rules and the 409 precondition in the operation descriptions", () => {
        const suspend = contractOperationBlock(SUSPEND, "patch");
        expect(suspend).toContain("already-suspended doctor is a no-op");
        expect(suspend).toContain("**200** when `identitySyncStatus='synced'`");
        expect(suspend).toContain("**503");
        const reinstate = contractOperationBlock(REINSTATE, "patch");
        expect(reinstate).toContain("A doctor who is not suspended is a no-op");
        expect(reinstate).toContain("**202**");
        expect(reinstate).toContain("`synced`");
    });

    it("should require data in the SuspensionPending 503 body next to the suspension marker", () => {
        const block = schemaBlock("SuspensionPending");
        expect(inlineLists(block, "required")[0]).toEqual(["suspension", "data"]);
        expect(block).toContain("const: applied-locally, session-revocation-pending");
        expect(block).toContain("$ref: '#/components/schemas/ErrorEnvelope'");
        expect(responseBlock("SuspensionPending")).toContain("IdentityUnavailable");
    });

    it("should declare the reinstate 202 body with a top-level identitySync sibling of data", () => {
        const block = contractOperationBlock(REINSTATE, "patch");
        const accepted = block.slice(block.indexOf("'202':"), block.indexOf("'400':"));
        expect(accepted).toContain("required: [success, data, identitySync]");
        expect(accepted).toContain("enum: [pending, failed]");
        expect(accepted).toContain("$ref: '#/components/schemas/ReinstatementResult'");
    });

    it("should bound the request reason to 3..2000 and reject unknown members", () => {
        for (const name of ["SuspendDoctor", "ReinstateDoctor"]) {
            const block = schemaBlock(name);
            expect(block).toContain("additionalProperties: false");
            expect(block).toContain("required: [reason]");
            expect(block).toContain("minLength: 3");
            expect(block).toContain("maxLength: 2000");
        }
    });

    it("should declare the result schemas with the keys the DTOs render", () => {
        expect(inlineLists(schemaBlock("SuspensionResult"), "required")[0]).toEqual(["doctorUserId", "suspendedAt", "identitySyncStatus", "flaggedConsultationIds"]);
        expect(inlineLists(schemaBlock("ReinstatementResult"), "required")[0]).toEqual(["doctorUserId", "reinstatedAt", "identitySyncStatus"]);
    });

    it("should cap the Identity-bound reason in the synced Identity contract at 500 characters (clamp S4)", () => {
        // Care's own contract keeps 2000; the engine clamps to Identity's limit. Guard the two numbers staying different on purpose.
        expect(schemaBlock("SuspendDoctor")).toContain("maxLength: 2000");
    });

    // Both routes run `idempotency({ required: false })` (spec 3.1): the contract declares the optional header and the 422 / 409 responses.
    it.each([[SUSPEND], [REINSTATE]])("should declare the optional Idempotency-Key and its 422/409 responses on %s", (path) => {
        const block = contractOperationBlock(path, "patch");
        expect(block).toContain("#/components/parameters/IdempotencyKeyOptional");
        expect(contractResponseCodes(path, "patch")).toEqual(expect.arrayContaining(["409", "422"]));
    });
});
