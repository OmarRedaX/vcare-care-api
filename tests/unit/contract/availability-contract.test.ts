import fs from "node:fs";
import path from "node:path";
import { contractOperationBlock, contractResponseCodes, inlineLists, schemaBlock } from "../../helpers/contract";

describe("availability slice 1 contract (C1-C3)", () => {
    const block = contractOperationBlock("/api/doctors/{doctorUserId}/slots", "get");
    it("should declare the patient and admin slots operation with the exact response set", () => {
        expect(block).toContain("operationId: getDoctorSlots");
        expect(inlineLists(block, "x-roles")).toEqual([["patient", "admin"]]);
        expect(block).toContain("x-ownership: none");
        expect(block).toContain("bearerUser");
        expect([...contractResponseCodes("/api/doctors/{doctorUserId}/slots", "get")].sort()).toEqual(["200", "400", "401", "403", "404", "429", "500"]);
    });
    it("should describe 404, 14-day validation, clipping, and start-only inclusion", () => {
        for (const phrase of ["non-bookable doctor", "another", "404 NotFound", "at most 14 days", "[now, now + 60 days]", "data: []", "start lies", "IANA zone"]) {
            expect(block).toContain(phrase);
        }
    });
    it("should describe effective window metadata and inactive or foreign types", () => {
        const meta = schemaBlock("SlotWindowMeta");
        expect(meta).toContain("nearest bound");
        expect(meta.match(/nearest bound/g)).toHaveLength(2);
        const yaml = fs.readFileSync(path.resolve(__dirname, "../../../contracts/openapi.yaml"), "utf8");
        expect(yaml.match(/A type that is unknown, inactive, deleted or another doctor's is `404 NotFound`/g)).toHaveLength(1);
        expect(schemaBlock("Slot")).toContain("startsAtLocal");
    });
});
