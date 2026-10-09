import { contractOperationBlock, contractResponseCodes, idempotentOperations, inlineLists, responseBlock, schemaBlock } from "../../helpers/contract";

type Method = "get" | "put" | "post" | "patch" | "delete";
const OPERATIONS: Array<[string, string, Method, string, string[]]> = [
    ["getMyWorkingHours", "/api/doctors/me/working-hours", "get", "", ["200", "401", "403", "404", "429", "500"]],
    ["replaceMyWorkingHours", "/api/doctors/me/working-hours", "put", "admin-action", ["200", "400", "401", "403", "404", "409", "429", "500"]],
    ["listMyExceptions", "/api/doctors/me/exceptions", "get", "", ["200", "400", "401", "403", "404", "429", "500"]],
    ["createMyException", "/api/doctors/me/exceptions", "post", "admin-action", ["201", "400", "401", "403", "404", "409", "422", "429", "500"]],
    ["deleteMyException", "/api/doctors/me/exceptions/{id}", "delete", "admin-action", ["204", "400", "401", "403", "404", "409", "429", "500"]],
    ["listMyConsultationTypes", "/api/doctors/me/consultation-types", "get", "", ["200", "400", "401", "403", "404", "429", "500"]],
    ["createMyConsultationType", "/api/doctors/me/consultation-types", "post", "", ["201", "400", "401", "403", "404", "409", "422", "429", "500"]],
    ["updateMyConsultationType", "/api/doctors/me/consultation-types/{id}", "patch", "", ["200", "400", "401", "403", "404", "409", "429", "500"]],
];

describe("schedules contract (C1-C6)", () => {
    it.each(OPERATIONS)("should declare %s as doctor-only, self-owned, active and not locally suspended", (operationId, path, method) => {
        const block = contractOperationBlock(path, method);
        expect(block).toContain(`operationId: ${operationId}`);
        expect(inlineLists(block, "x-roles")).toEqual([["doctor"]]);
        expect(block).toContain("x-ownership: self");
        expect(block).toContain("x-account-state: 'status active; not locally suspended'");
        expect(block).toContain("bearerUser");
    });

    it.each(OPERATIONS)("should declare exactly the response set of %s (C1/C2 additions included)", (_operationId, path, method, _audit, codes) => {
        expect([...contractResponseCodes(path, method)].sort()).toEqual([...codes].sort());
    });

    it.each(OPERATIONS)("should declare x-audit only where bookings can be affected (%s)", (_operationId, path, method, audit) => {
        const block = contractOperationBlock(path, method);
        if (audit === "") expect(block).not.toContain("x-audit: ");
        else expect(block).toContain(`x-audit: ${audit}`);
    });

    it("should declare the audit actions per write", () => {
        const actions = (path: string, method: Method): string[] => inlineLists(contractOperationBlock(path, method), "x-audit-actions")[0] ?? [];
        expect(actions("/api/doctors/me/working-hours", "put")).toEqual(["schedule.hours_replaced", "schedule.conflicts_confirmed"]);
        expect(actions("/api/doctors/me/exceptions", "post")).toEqual(["schedule.exception_created", "schedule.conflicts_confirmed"]);
        expect(actions("/api/doctors/me/exceptions/{id}", "delete")).toEqual(["schedule.exception_deleted", "schedule.conflicts_confirmed"]);
        expect(actions("/api/doctors/me/consultation-types", "post")).toEqual(["consultation_type.created"]);
        expect(actions("/api/doctors/me/consultation-types/{id}", "patch")).toEqual(["consultation_type.updated"]);
    });

    it("should declare an Idempotency-Key only on the two POSTs and as optional", () => {
        const schedule = idempotentOperations().filter((operation) => operation.path.startsWith("/api/doctors/me/") &&
            (operation.path.includes("exceptions") || operation.path.includes("consultation-types") || operation.path.includes("working-hours")));
        expect(schedule.map((operation) => `${operation.method} ${operation.path}`).sort()).toEqual([
            "POST /api/doctors/me/consultation-types", "POST /api/doctors/me/exceptions",
        ]);
        for (const [, path, method] of OPERATIONS) {
            const optional = contractOperationBlock(path, method).includes("IdempotencyKeyOptional");
            expect(optional).toBe(method === "post");
            expect(contractOperationBlock(path, method)).not.toContain("IdempotencyKeyRequired");
        }
    });

    it("should declare the confirmConflicts boolean query on deleteMyException and on no other operation", () => {
        const block = contractOperationBlock("/api/doctors/me/exceptions/{id}", "delete");
        expect(block).toMatch(/name: confirmConflicts\s+in: query/);
        expect(block).toMatch(/type: boolean\s+default: false/);
        for (const [, path, method] of OPERATIONS.filter(([id]) => id !== "deleteMyException")) {
            expect(contractOperationBlock(path, method)).not.toContain("name: confirmConflicts");
        }
    });

    it("should send ScheduleConflictsUnconfirmed on the three conflict-capable operations as 409 and declare the sibling conflicts member", () => {
        for (const [, path, method] of OPERATIONS.filter(([id]) => ["replaceMyWorkingHours", "createMyException", "deleteMyException"].includes(id))) {
            expect(contractOperationBlock(path, method)).toContain("#/components/responses/ScheduleConflictsUnconfirmed");
        }
        const response = responseBlock("ScheduleConflictsUnconfirmed");
        expect(response).toContain("ScheduleConflicts");
        expect(schemaBlock("ScheduleConflicts")).toContain("consultationIds");
        expect(schemaBlock("ScheduleConflicts")).toContain("count");
    });

    it("should keep the declared required lists of the response schemas", () => {
        expect(inlineLists(schemaBlock("WorkingHours"), "required")[0]).toEqual(["timezone", "days"]);
        expect(inlineLists(schemaBlock("ScheduleException"), "required")[0]).toEqual(["id", "date", "type", "startTime", "endTime", "reason", "createdAt"]);
        expect(inlineLists(schemaBlock("ConsultationType"), "required")[0]).toEqual(["id", "name", "durationMinutes", "price", "currency", "isActive", "createdAt", "updatedAt"]);
    });

    it("should bound the price at the INT column maximum in all three schemas (C4)", () => {
        for (const schema of ["ConsultationType", "ConsultationTypeCreate", "ConsultationTypeUpdate"]) {
            expect(schemaBlock(schema)).toContain("maximum: 2147483647");
        }
    });

    it("should document the 20-type cap, currency rule and 60-date range rule in the descriptions (C3/C5)", () => {
        expect(contractOperationBlock("/api/doctors/me/consultation-types", "post")).toMatch(/at most 20 consultation types/);
        expect(contractOperationBlock("/api/doctors/me/consultation-types", "post")).toContain("ALLOWED_CURRENCIES");
        expect(contractOperationBlock("/api/doctors/me/exceptions", "post")).toMatch(/at most 60 days/);
        expect(contractOperationBlock("/api/doctors/me/exceptions", "post")).toMatch(/before today/);
    });
});
