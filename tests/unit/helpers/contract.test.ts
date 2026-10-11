import { contractOperation, contractErrorCodes } from "../../helpers/contract";
import { ERROR_CODES } from "../../../src/lib/error/types";

describe("contract health operations", () => {
    it("should expose declared statuses, response headers, and error codes", () => {
        for (const path of ["/api/health/live", "/api/health/ready", "/internal/health/live", "/internal/health/ready"]) {
            const operation = contractOperation(path, "get");
            expect(operation.statuses).toEqual(path.endsWith("/ready") ? ["200", "503", "500"] : ["200", "500"]);
            expect(operation.headersByStatus["200"]).toEqual(["X-Request-Id", "Cache-Control"]);
            expect(operation.headersByStatus["503"]).toEqual(path.endsWith("/ready") ? ["X-Request-Id", "Cache-Control"] : undefined);
            expect(operation.errorCodes).toContain("InternalError");
        }
        expect([...ERROR_CODES].sort()).toEqual([...contractErrorCodes()].sort());
    });
});
